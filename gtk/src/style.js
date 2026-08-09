import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

/* Everything derives from theme tokens (@accent_bg_color, @view_bg_color,
   currentColor) so light and dark Adwaita both look native.

   Type and corners follow the web UI's two scales. The web anchors on a 14px
   body, so its steps become ems here and prose keeps the inherited size —
   only what deviates declares one:

     --font-lg   16px  1.15em   titles
     --font-base 14px  1em      body, controls, rows
     --font-sm   13px  0.93em   mono data, code, group chrome
     --font-meta 12px  0.86em   timestamps, roles, micro-labels
     --font-code       0.9em    inline code, relative to the prose it interrupts

     --radius-sm  4px  chips, menu rows, nested surfaces
     --radius     6px  standalone controls: buttons, inputs, images
     --radius-lg  8px  floating panels: composer, popovers, cards
     --radius-xl 10px  the settings dialog

   Two shapes sit outside the scale in the web too, and so here: the message
   bubble at 20px and the tool card at 12px. The sidebar row keeps Adwaita's
   own 9px selection pill rather than the web's 4px — that one is a platform
   affordance, not a container. */
const CSS = `
/* Prose inherits: the web's .content is body size, not a step down. */
.markdown-heading {
  font-size: 1.15em;
  font-weight: 600;
}

/* User prompts get a tinted bubble; assistant content flows plainly on the
   view background. */
.user-bubble {
  background-color: alpha(@accent_bg_color, 0.18);
  border-radius: 20px;
}

/* Tool calls recede into the background: an outline and nothing else, which
   is what the web settled on — they are scaffolding, not content. */
.tool-card {
  border-radius: 12px;
  margin-top: 4px;
  margin-bottom: 4px;
}

/* Consecutive tool calls merge into one block: the run shares an outline, and
   only its ends are rounded. The web overlaps the two hairlines with -1px,
   which works there because its border colour is opaque; a GtkFrame's border
   is translucent, so overlapping would double the alpha into a dark seam.
   Drop the upper border instead and let the one above it serve as the join. */
.tool-group > .tool-card {
  margin-top: 0;
  margin-bottom: 0;
  border-radius: 0;
}

.tool-group > .tool-card:not(:first-child) {
  border-top-style: none;
}

.tool-group > .tool-card:first-child {
  margin-top: 4px;
  border-top-left-radius: 12px;
  border-top-right-radius: 12px;
}

.tool-group > .tool-card:last-child {
  margin-bottom: 4px;
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}

/* GTK 4 names the GtkExpander CSS node expander-widget. */
.tool-card expander-widget title {
  padding: 5px 8px;
}

.tool-header {
  font-size: 0.86em;
  font-weight: 600;
  opacity: 0.70;
}

.tool-body {
  padding: 0 8px 7px 8px;
  opacity: 0.88;
}

/* Code blocks are plain monospace — usher does no syntax highlighting — on the
   dark slab the web uses in both colour schemes. */
.markdown-code {
  border-style: none;
  border-radius: 5px;
  margin-top: 4px;
  margin-bottom: 4px;
}

.markdown-code-text {
  font-family: monospace;
  font-size: 0.93em;
  padding: 8px;
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

/* A session list is long and every row is one line, so it does not need the
   36px row and 2px gap .navigation-sidebar gives a list of destinations. */
.session-list > row {
  min-height: 30px;
  margin-bottom: 0;
}

/* Subagent rows are a step down in type and carry no marks, so they hold a
   line in less. */
.session-list > row.subagent {
  min-height: 24px;
}

/* Auto-approve reads by colour, not by a pressed slab: the composer's tool
   row stays flat, and the amber is the same warning colour the sidebar's ϟ
   uses for a session that runs tools unattended. */
.approve-toggle {
  opacity: 0.7;
}

.approve-toggle:checked {
  background-color: transparent;
  box-shadow: none;
  color: @warning_color;
  opacity: 1;
}

.approve-toggle:checked:hover {
  background-color: alpha(currentColor, 0.08);
}

/* AdwToggleGroup brings its own shape; only the web pill's type size and
   compactness are ours. */
.render-mode {
  font-size: 0.93em;
}

.render-mode toggle {
  min-height: 24px;
  padding: 0 8px;
}

/* The fork control is quiet text in the turn footer, the size of the web's. */
.turn-fork {
  font-size: 0.86em;
  font-weight: normal;
  min-height: 0;
  padding: 1px 6px;
}


/* Session state, mirroring the web sidebar: a dot in a fixed slot so titles
   line up whether or not one is shown. A live worker that is merely warm gets
   a dim green dot — present but quiet, so a list of idle sessions doesn't
   shout and full brightness is left for actual activity. */
.session-dot {
  font-size: 0.7em;
  color: @success_color;
  opacity: 0.5;
}

/* Running breathes between full brightness and a dim trough; the animation
   drives opacity, so it overrides the dim base above. */
.session-dot.running { animation: session-breathe 4s ease-in-out infinite; }
.session-dot.unread { color: @accent_color; opacity: 1; }
.session-dot.permission { color: @error_color; opacity: 1; }

/* GTK's CSS parser takes one selector per keyframe, not a comma-separated
   list, so the endpoints are spelled out. */
@keyframes session-breathe {
  from { opacity: 1; }
  50% { opacity: 0.3; }
  to { opacity: 1; }
}

/* How many decisions a session is holding, as the pill every GTK chat sidebar
   uses for an unread count. */
.session-count {
  font-size: 0.8em;
  font-weight: bold;
  border-radius: 9999px;
  min-width: 12px;
  padding: 1px 6px;
  background-color: alpha(currentColor, 0.15);
}

/* The archived disclosure arrow, turning the way AdwExpanderRow's does:
   -gtk-icon-transform, not transform, is what GTK animates on an icon. */
.session-disclosure {
  transition: -gtk-icon-transform 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
  opacity: 0.55;
}

.session-disclosure.collapsed {
  -gtk-icon-transform: rotate(0.5turn);
}

/* A GtkListView is a .view, which paints it in the white content colour and
   leaves the transcript floating as a slab inside the window. The layering is
   the web UI's: chrome is the lifted surface, content sits on the canvas. */
.transcript-list {
  background: none;
}

/* Inline transcript images take the standalone-control radius, as on the web. */
.transcript-image picture {
  border-radius: 6px;
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

/* The colours with no theme token behind them: backend brands, and the code
   slab the web keeps dark in both schemes. Each carries a light and a dark
   value, and GTK's CSS parser has no @media, so the pair is swapped at
   runtime. Values are the web's. */
const BACKEND_COLORS = {
  claude: ['#bd5b3d', '#e0916f'],
  codex: ['#6f76d6', '#8e93e0'],
  pi: ['#09090b', '#ffffff'],
};

const CODE_BLOCK_BG = ['#1f2328', '#0a0d12'];
const CODE_BLOCK_FG = ['#e6edf3', '#e6edf3'];

export const BACKENDS = Object.keys(BACKEND_COLORS);

function schemedCss(dark) {
  const i = dark ? 1 : 0;
  return [
    ...BACKENDS.map(name => `.backend-${name} { color: ${BACKEND_COLORS[name][i]}; }`),
    `.markdown-code { background-color: ${CODE_BLOCK_BG[i]}; }`,
    `.markdown-code-text { color: ${CODE_BLOCK_FG[i]}; }`,
  ].join('\n');
}

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

  const schemed = new Gtk.CssProvider();
  const manager = Adw.StyleManager.get_default();
  const applySchemed = () => schemed.load_from_string(schemedCss(manager.get_dark()));
  applySchemed();
  manager.connect('notify::dark', applySchemed);
  Gtk.StyleContext.add_provider_for_display(
    display,
    schemed,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
  );
  installed = true;
}
