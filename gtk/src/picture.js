import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

// A picture that reports height-for-width as its *minimum* height. GtkListView
// sizes rows from their minimum, and a can-shrink GtkPicture reports zero — so
// an image in the transcript would collapse to nothing. A size request would
// fix that but also pin a minimum width, overflowing narrow windows.
export const AspectPicture = GObject.registerClass(
class AspectPicture extends Gtk.Picture {
  setAspect(width, height) {
    this._aspect = height > 0 ? width / height : 0;
    this.queue_resize();
  }

  vfunc_get_request_mode() {
    return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH;
  }

  vfunc_measure(orientation, forSize) {
    if (orientation === Gtk.Orientation.VERTICAL && this._aspect > 0 && forSize > 0) {
      const height = Math.round(forSize / this._aspect);
      return [height, height, -1, -1];
    }
    return super.vfunc_measure(orientation, forSize);
  }
});

export function showPictureDialog(parent, paintable, title, subtitle = '') {
  const picture = new Gtk.Picture({
    paintable,
    can_shrink: true,
    content_fit: Gtk.ContentFit.CONTAIN,
  });
  const scroll = new Gtk.ScrolledWindow({ child: picture, hexpand: true, vexpand: true });
  const toolbar = new Adw.ToolbarView({ content: scroll });
  const header = new Adw.HeaderBar();
  header.set_title_widget(new Adw.WindowTitle({ title, subtitle }));
  toolbar.add_top_bar(header);
  const dialog = new Adw.Dialog({ child: toolbar, content_width: 900, content_height: 700 });
  dialog.present(parent);
}
