import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { BackendProcess } from './backend-process.js';
import { installStyles } from './style.js';
import { UsherWindow } from './window.js';

// An installed build puts the app's own icons in the system icon directory,
// where the theme finds them unaided. Running from a source checkout, nothing
// has been installed, so the tree they live in has to be pointed at.
export function installIcons() {
  const display = Gdk.Display.get_default();
  if (!display) return;
  const [file] = GLib.filename_from_uri(import.meta.url);
  const icons = GLib.build_filenamev(
    [GLib.path_get_dirname(file), '..', 'data', 'icons']);
  if (!GLib.file_test(icons, GLib.FileTest.IS_DIR)) return;
  Gtk.IconTheme.get_for_display(display).add_search_path(icons);
}

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
    // The shortcut users try first for a settings dialog.
    this.set_accels_for_action('win.settings', ['<Primary>comma']);
  }

  async vfunc_activate() {
    installStyles();
    installIcons();
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
