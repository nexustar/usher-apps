import GLib from 'gi://GLib';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'usher-app']);
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'servers.json']);

// usher's own default is 7777, so a backend this app starts sits elsewhere and
// cannot collide with one the user runs themselves.
export const DEFAULT_EMBEDDED_PORT = 17777;

// A package that ships its own backend puts the path here (see the launcher).
// That binary is the one such a build runs: no other install is searched for,
// so the client and the server it drives cannot fall out of step.
function bundledBackend() {
  // Nothing on the host can be started from a sandbox, bundled or not.
  if (GLib.file_test('/.flatpak-info', GLib.FileTest.EXISTS) ||
      GLib.getenv('FLATPAK_ID')) {
    return '';
  }
  const path = GLib.getenv('USHER_BUNDLED_BACKEND') || '';
  return path && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) ? path : '';
}

export class ServerStore {
  constructor() {
    this.servers = [];
    this.activeId = '';
    this.embeddedPath = bundledBackend();
    this.embeddedPort = DEFAULT_EMBEDDED_PORT;
    this._load();
  }

  get active() {
    if (this.activeId === '__embedded__') {
      return this.embeddedPath
        ? {
            id: '__embedded__',
            name: 'Embedded usher',
            url: '',
            binaryPath: this.embeddedPath,
            port: this.embeddedPort,
          }
        : null;
    }
    return this.servers.find(server => server.id === this.activeId) || null;
  }

  get isEmbeddedActive() {
    return this.activeId === '__embedded__';
  }

  setEmbeddedPath(path) {
    this.embeddedPath = path.trim();
    this._save();
  }

  setEmbeddedPort(port) {
    const value = Number(port);
    this.embeddedPort = Number.isInteger(value) && value > 0 && value < 65536
      ? value : DEFAULT_EMBEDDED_PORT;
    this._save();
  }

  selectEmbedded() {
    this.activeId = '__embedded__';
    this._save();
  }

  upsert(server) {
    const value = {
      id: server.id || GLib.uuid_string_random(),
      name: server.name.trim(),
      url: server.url.trim().replace(/\/$/, ''),
    };
    const index = this.servers.findIndex(item => item.id === value.id);
    if (index >= 0) this.servers[index] = value;
    else this.servers.push(value);
    this.activeId = value.id;
    this._save();
    return value;
  }

  remove(id) {
    this.servers = this.servers.filter(server => server.id !== id);
    if (this.activeId === id) this.activeId = this.servers[0]?.id || '';
    this._save();
  }

  select(id) {
    if (id === '__embedded__') { this.selectEmbedded(); return; }
    if (!this.servers.some(server => server.id === id)) return;
    this.activeId = id;
    this._save();
  }

  _load() {
    try {
      const [ok, contents] = GLib.file_get_contents(CONFIG_FILE);
      if (!ok) return;
      const data = JSON.parse(new TextDecoder().decode(contents));
      if (Array.isArray(data.servers)) this.servers = data.servers;
      if (typeof data.activeId === 'string') this.activeId = data.activeId;
      if (typeof data.embeddedPath === 'string') this.embeddedPath = data.embeddedPath;
      if (Number.isInteger(data.embeddedPort)) this.embeddedPort = data.embeddedPort;
    } catch (_) {
      this.servers = [];
      this.activeId = '';
      this.embeddedPath = bundledBackend();
      this.embeddedPort = DEFAULT_EMBEDDED_PORT;
    }
  }

  _save() {
    GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
    GLib.file_set_contents(CONFIG_FILE, JSON.stringify({
      activeId: this.activeId,
      embeddedPath: this.embeddedPath,
      embeddedPort: this.embeddedPort,
      servers: this.servers,
    }, null, 2));
  }
}
