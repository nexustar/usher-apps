import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

/* Everything derives from theme tokens (@accent_bg_color, @view_bg_color,
   currentColor) so light and dark Adwaita both look native.

   Corner policy mirrors the usher web UI's scale: 8px for the message bubble
   and chrome containers (composer, permission card), 4-5px for content
   blocks (tool cards 4, code 5, tables 4), quotes square with a left bar.
   Buttons keep the stock Adwaita radius. */
const CSS = `
.markdown-body {
  font-size: 0.92em;
}

.markdown-heading {
  font-size: 1em;
  font-weight: 600;
}

/* User prompts get a tinted bubble; assistant content flows plainly on the
   view background. */
.user-bubble {
  background-color: alpha(@accent_bg_color, 0.18);
  border-radius: 8px;
}

.tool-card {
  background-color: alpha(currentColor, 0.04);
  border-radius: 4px;
  margin-top: 4px;
  margin-bottom: 4px;
}

/* GTK 4 names the GtkExpander CSS node expander-widget. */
.tool-card expander-widget title {
  padding: 5px 8px;
}

.tool-header {
  font-size: 0.80em;
  font-weight: 600;
  opacity: 0.70;
}

.tool-body {
  padding: 0 8px 7px 8px;
  opacity: 0.88;
}

/* Code blocks take their colors from a GtkSourceView scheme matched to the
   app theme (see markdown.js); the frame adds a hairline so the block reads
   as one inset unit. */
.markdown-code {
  border: 1px solid alpha(currentColor, 0.15);
  border-radius: 5px;
  margin-top: 4px;
  margin-bottom: 4px;
}

.markdown-table {
  border-radius: 4px;
}

.markdown-quote {
  border-style: none;
  border-left: 3px solid alpha(currentColor, 0.25);
  border-radius: 0;
  background: none;
  padding-left: 10px;
}

.composer-frame,
.permission-card {
  border-radius: 8px;
}

.markdown-table-grid {
  background-color: alpha(currentColor, 0.12);
}

.markdown-table-cell {
  background-color: @view_bg_color;
}

.markdown-table-header {
  background-color: alpha(currentColor, 0.05);
  font-weight: 600;
}
`;

let installed = false;

export function installStyles() {
  if (installed) return;
  const display = Gdk.Display.get_default();
  if (!display) return;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(CSS);
  Gtk.StyleContext.add_provider_for_display(
    display,
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
  );
  installed = true;
}
