import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import './promises.js';

export class BackendProcess {
  constructor() {
    this.baseUrl = '';
    this.binaryPath = '';
    this._process = null;
    this._startedHere = false;
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
    })() || 17777;
    this.baseUrl = (this.binaryPath ? `http://127.0.0.1:${port}` : server.url || '')
      .trim().replace(/\/$/, '');
  }

  async ensureRunning() {
    if (!this.baseUrl) throw new Error('Configure a remote URL or a local usher binary');
    if (await this._healthy()) return;

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

    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    this._process = launcher.spawnv([
      this.binaryPath,
      'serve',
      '--addr', `${host}:${port}`,
    ]);
    this._startedHere = true;

    for (let attempt = 0; attempt < 50; attempt++) {
      if (await this._healthy()) return;
      await new Promise(resolve => GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        100,
        () => { resolve(); return GLib.SOURCE_REMOVE; }
      ));
    }
    this.stop();
    throw new Error('The embedded usher backend did not become ready');
  }

  stop() {
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
