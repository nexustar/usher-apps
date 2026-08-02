import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import { DEFAULT_EMBEDDED_PORT } from './server-store.js';
import './promises.js';

const STARTUP_POLL_MS = 100;
const STARTUP_ATTEMPTS = 400; // 40s
const RESTART_DELAY_MS = 1500;
const CRASH_WINDOW_MS = 60000;
const MAX_RESTARTS = 3;
const STDERR_TAIL_LINES = 40;

// Inside a Flatpak (and any comparable sandbox) the app cannot start a backend
// on the host: doing so needs the org.freedesktop.Flatpak escape hatch, which
// hands back the whole machine and defeats the point of shipping sandboxed.
// Detection is at runtime so one build behaves correctly either way.
export function isSandboxed() {
  return GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS) ||
    Boolean(GLib.getenv('FLATPAK_ID'));
}

export class BackendProcess {
  constructor() {
    this.baseUrl = '';
    this.binaryPath = '';
    this.adopted = false;
    // Called with ('running' | 'restarting' | 'failed', detail) for a backend
    // this app owns. Nothing is reported for adopted or remote servers: their
    // lifetime is somebody else's business.
    this.onState = null;
    this._process = null;
    this._startedHere = false;
    this._stopping = false;
    this._ready = false;
    this._exitDetail = null;
    this._crashes = [];
    this._stderrTail = [];
    this._healthSession = new Soup.Session({
      user_agent: 'usher-gtk-health/0.1',
      timeout: 3,
    });
  }

  configure(server) {
    this.stop();
    let path = (server.binaryPath || '').trim();
    if (path.startsWith('~/')) path = GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
    this.binaryPath = path;
    const port = Number(server.port) || (() => {
      try { return GLib.Uri.parse(server.url || '', GLib.UriFlags.NONE).get_port(); }
      catch (_) { return 0; }
    })() || DEFAULT_EMBEDDED_PORT;
    this.baseUrl = (this.binaryPath ? `http://127.0.0.1:${port}` : server.url || '')
      .trim().replace(/\/$/, '');
  }

  // True only while this process owns a backend it spawned itself. An usher
  // that was already listening — the user's own, or one this app started
  // before it was restarted — is adopted, not owned: it is never stopped here,
  // and it is authenticated to like any other server.
  get startedHere() {
    return this._startedHere;
  }

  async ensureRunning() {
    if (!this.baseUrl) throw new Error('Configure a remote URL or a local usher binary');
    if (await this._healthy()) {
      this.adopted = !this._startedHere;
      return;
    }
    this.adopted = false;

    if (!this.binaryPath) {
      throw new Error(`Could not reach usher at ${this.baseUrl}`);
    }
    if (!GLib.file_test(this.binaryPath, GLib.FileTest.IS_EXECUTABLE)) {
      throw new Error(`usher binary is not executable: ${this.binaryPath}`);
    }

    const uri = GLib.Uri.parse(this.baseUrl, GLib.UriFlags.NONE);
    const host = uri.get_host();
    const port = uri.get_port();
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new Error('The app only starts an embedded backend on loopback');
    }

    // Health already failed, so anything still accepting connections here is
    // not usher.
    if (await this._portTaken(host, port)) {
      throw new Error(
        `Port ${port} is already in use by another program. ` +
        `Choose a different port for the local backend.`);
    }

    this._spawn(host, port);

    // usher scans every sessions directory before it listens, so readiness
    // scales with how much history the machine holds — measured at over five
    // seconds on an ordinary workstation.
    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
      if (await this._healthy()) {
        // Only a backend that has served is supervised; one that never came up
        // is reported by this call instead.
        this._ready = true;
        return;
      }
      // It exited before it ever served; its own output says why.
      if (this._exitDetail) {
        const detail = this._exitDetail;
        this.stop();
        throw new Error(detail);
      }
      await new Promise(resolve => GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        STARTUP_POLL_MS,
        () => { resolve(); return GLib.SOURCE_REMOVE; }
      ));
    }
    this.stop();
    throw new Error(
      `The embedded usher backend did not become ready within ` +
      `${(STARTUP_ATTEMPTS * STARTUP_POLL_MS) / 1000}s`);
  }

  // A pipe nobody drains eventually blocks the writer, and usher logs
  // steadily, so the tail reader below is required.
  _spawn(host, port) {
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    const process = launcher.spawnv([
      this.binaryPath,
      'serve',
      '--addr', `${host}:${port}`,
    ]);
    this._process = process;
    this._startedHere = true;
    this._stopping = false;
    this._ready = false;
    this._exitDetail = null;
    this._stderrTail = [];
    this._drainStderr(process);
    this._watch(process, host, port);
  }

  async _drainStderr(process) {
    const stream = new Gio.DataInputStream({ base_stream: process.get_stderr_pipe() });
    try {
      for (;;) {
        const [line] = await stream.read_line_async(GLib.PRIORITY_DEFAULT, null);
        if (line === null) return;
        this._stderrTail.push(new TextDecoder().decode(line));
        if (this._stderrTail.length > STDERR_TAIL_LINES) this._stderrTail.shift();
      }
    } catch (_) {
      // The process is gone and the pipe closed under us; the tail we have is
      // what there is.
    }
  }

  async _watch(process, host, port) {
    try {
      await process.wait_async(null);
    } catch (_) {
      return;
    }
    // A newer process (or an intentional stop) has taken over.
    if (this._process !== process || this._stopping) return;
    this._process = null;
    this._startedHere = false;

    const status = process.get_if_exited()
      ? `exit status ${process.get_exit_status()}`
      : `signal ${process.get_term_sig()}`;
    const detail = [`usher stopped unexpectedly (${status})`,
      ...this._stderrTail.slice(-6)].join('\n');
    this._exitDetail = detail;
    // Never came up: ensureRunning is still waiting and will report this.
    if (!this._ready) return;

    const now = GLib.get_monotonic_time() / 1000;
    this._crashes = this._crashes.filter(at => now - at < CRASH_WINDOW_MS);
    this._crashes.push(now);
    if (this._crashes.length > MAX_RESTARTS) {
      this.onState?.('failed', `${detail}\nGiving up after repeated crashes.`);
      return;
    }

    this.onState?.('restarting', detail);
    await new Promise(resolve => GLib.timeout_add(
      GLib.PRIORITY_DEFAULT, RESTART_DELAY_MS,
      () => { resolve(); return GLib.SOURCE_REMOVE; }
    ));
    if (this._process || this._stopping) return; // something else took over
    try {
      this._spawn(host, port);
      for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
        if (!this._startedHere) return; // stopped while we waited
        if (await this._healthy()) {
          // Supervised again, so the next crash is also restarted.
          this._ready = true;
          this.onState?.('running', 'usher restarted');
          return;
        }
        if (this._exitDetail) { // died again before serving
          this.onState?.('failed', this._exitDetail);
          return;
        }
        await new Promise(resolve => GLib.timeout_add(
          GLib.PRIORITY_DEFAULT, STARTUP_POLL_MS,
          () => { resolve(); return GLib.SOURCE_REMOVE; }
        ));
      }
      this.onState?.('failed', 'usher did not come back up');
    } catch (error) {
      this.onState?.('failed', error.message || String(error));
    }
  }

  stop() {
    this._stopping = true;
    if (this._startedHere && this._process) {
      const process = this._process;
      let reaped = false;
      process.wait_async(null).then(() => { reaped = true; }).catch(() => { reaped = true; });
      try { process.send_signal(15); }
      catch (_) { /* It already exited; wait_async still reaps it. */ }
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        if (!reaped) {
          try { process.force_exit(); }
          catch (_) { /* It exited between the check and the signal. */ }
        }
        return GLib.SOURCE_REMOVE;
      });
    }
    this._process = null;
    this._startedHere = false;
    // A deliberate stop is not evidence against the next start.
    this._crashes = [];
  }

  // Something is accepting connections on this port. Used only after a health
  // check has already failed, so a true answer means "occupied by not-usher".
  async _portTaken(host, port) {
    const client = new Gio.SocketClient({ timeout: 2 });
    try {
      const connection = await client.connect_to_host_async(`${host}:${port}`, port, null);
      connection?.close(null);
      return true;
    } catch (_) {
      return false;
    }
  }

  async _healthy() {
    try {
      const message = Soup.Message.new('GET', `${this.baseUrl}/healthz`);
      const contents = await this._healthSession.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        null
      );
      return message.status_code === Soup.Status.OK &&
        new TextDecoder().decode(contents.get_data()).trim() === 'ok';
    } catch (_) {
      return false;
    }
  }

}
