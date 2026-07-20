import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import { BackendProcess } from './backend-process.js';
import { installStyles } from './style.js';
import { UsherWindow } from './window.js';

export const UsherApplication = GObject.registerClass(
class UsherApplication extends Adw.Application {
  _init() {
    super._init({
      application_id: 'io.github.nexustar.Usher',
      flags: Gio.ApplicationFlags.FLAGS_NONE,
    });
    this._backend = new BackendProcess();

    const quit = new Gio.SimpleAction({ name: 'quit' });
    quit.connect('activate', () => this.quit());
    this.add_action(quit);
    this.set_accels_for_action('app.quit', ['<Primary>q']);

    const refresh = new Gio.SimpleAction({ name: 'refresh' });
    refresh.connect('activate', () => this.active_window?.refresh());
    this.add_action(refresh);
    this.set_accels_for_action('app.refresh', ['<Primary>r']);
  }

  async vfunc_activate() {
    installStyles();
    let window = this.active_window;
    if (!window) {
      window = new UsherWindow({ application: this, backend: this._backend });
    }
    window.present();
    await window.start();
  }

  vfunc_shutdown() {
    this._backend.stop();
    super.vfunc_shutdown();
  }
});
