import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import './vendor/marked.umd.js';


const marked = globalThis.marked;
if (!marked?.lexer) throw new Error('vendored marked lexer did not load');

function escape(text) {
  return GLib.markup_escape_text(String(text ?? ''), -1);
}

function safeHref(href) {
  const value = String(href || '').trim();
  const scheme = GLib.uri_parse_scheme(value)?.toLowerCase() || '';
  return ['http', 'https', 'mailto'].includes(scheme) ? value : '';
}

function inline(tokens = []) {
  return tokens.map(token => {
    switch (token.type) {
      case 'text':
      case 'escape':
        return token.tokens ? inline(token.tokens) : escape(token.text);
      case 'strong': return `<b>${inline(token.tokens)}</b>`;
      case 'em': return `<i>${inline(token.tokens)}</i>`;
      case 'codespan':
        return `<span font_family="monospace" background="#bbbbbb2e"> ${escape(token.text)} </span>`;
      case 'del': return `<s>${inline(token.tokens)}</s>`;
      case 'br': return '\n';
      case 'link': {
        const label = inline(token.tokens);
        const href = safeHref(token.href);
        return href ? `<a href="${escape(href)}">${label}</a>` : label;
      }
      case 'image': {
        const label = escape(token.text || token.href || 'image');
        const href = safeHref(token.href);
        return href ? `<a href="${escape(href)}">${label}</a>` : label;
      }
      case 'html': return escape(token.raw || token.text);
      default:
        return token.tokens ? inline(token.tokens) : escape(token.text || token.raw);
    }
  }).join('');
}

function labelFor(token, extra = {}) {
  const label = new Gtk.Label({
    xalign: 0,
    yalign: 0,
    selectable: true,
    wrap: true,
    wrap_mode: Pango.WrapMode.WORD_CHAR,
    natural_wrap_mode: Gtk.NaturalWrapMode.WORD,
    hexpand: true,
    max_width_chars: 80,
    use_markup: true,
    label: inline(token.tokens || [{ type: 'text', text: token.text || token.raw || '' }]),
    ...extra,
  });
  return label;
}

// Code is monospace text, not a highlighted editor: usher does not do syntax
// highlighting (it is on the project's out-of-scope list, and the web UI
// renders a plain <pre>). Diff fences are the one exception the web makes —
// it colours +/-/@@ lines, so this does too.
function codeBlock(token) {
  const text = String(token.text || '').trim();
  const isDiff = /^diff\b/.test(String(token.lang || '').trim());
  const label = new Gtk.Label({
    xalign: 0,
    yalign: 0,
    selectable: true,
    wrap: false,
    hexpand: true,
  });
  label.add_css_class('markdown-code-text');
  if (isDiff) label.set_markup(diffMarkup(text));
  else label.set_text(text);
  const scroll = new Gtk.ScrolledWindow({
    child: label,
    hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    vscrollbar_policy: Gtk.PolicyType.NEVER,
    propagate_natural_height: true,
    propagate_natural_width: false,
    hexpand: true,
  });
  const frame = new Gtk.Frame({ child: scroll, hexpand: true });
  frame.add_css_class('markdown-code');
  return frame;
}

function diffMarkup(text) {
  return text.split('\n').map(line => {
    const escaped = escape(line);
    if (line.startsWith('+')) return `<span foreground="#3fb950">${escaped}</span>`;
    if (line.startsWith('-')) return `<span foreground="#f85149">${escaped}</span>`;
    if (line.startsWith('@@')) return `<span foreground="#8b949e">${escaped}</span>`;
    return escaped;
  }).join('\n');
}

function listBlock(token, options) {
  const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  const start = Number(token.start) || 1;
  for (let index = 0; index < (token.items || []).length; index++) {
    const item = token.items[index];
    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    row.append(new Gtk.Label({
      label: token.ordered ? `${start + index}.` : '•',
      xalign: 1,
      yalign: 0,
    }));
    row.append(renderTokens(item.tokens || [], options));
    list.append(row);
  }
  return list;
}

// A paragraph holding nothing but one image becomes a real picture; an image
// mixed into a sentence stays an inline text link, because Pango markup has no
// way to host a widget mid-line. Returns the lone image token, or null.
function loneImage(token) {
  const tokens = (token.tokens || [])
    .filter(child => !(child.type === 'text' && !String(child.text || '').trim()));
  return tokens.length === 1 && tokens[0].type === 'image' ? tokens[0] : null;
}

function tableBlock(token) {
  const grid = new Gtk.Grid({ row_spacing: 1, column_spacing: 1 });
  grid.add_css_class('markdown-table-grid');
  const alignments = token.align || [];
  const addCell = (cell, column, row, header = false) => {
    const alignment = alignments[column] === 'right' ? 1 :
      alignments[column] === 'center' ? 0.5 : 0;
    const label = new Gtk.Label({
      label: inline(cell.tokens || []),
      use_markup: true,
      selectable: true,
      xalign: alignment,
      yalign: 0,
      margin_top: 5,
      margin_bottom: 5,
      margin_start: 8,
      margin_end: 8,
    });
    const box = new Gtk.Box({ hexpand: true });
    box.append(label);
    box.add_css_class('markdown-table-cell');
    if (header) box.add_css_class('markdown-table-header');
    grid.attach(box, column, row, 1, 1);
  };
  (token.header || []).forEach((cell, column) => addCell(cell, column, 0, true));
  (token.rows || []).forEach((cells, row) => {
    cells.forEach((cell, column) => addCell(cell, column, row + 1));
  });
  const frame = new Gtk.Frame({ child: grid });
  frame.add_css_class('markdown-table');
  const scroll = new Gtk.ScrolledWindow({
    child: frame,
    hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    vscrollbar_policy: Gtk.PolicyType.NEVER,
    propagate_natural_height: true,
    propagate_natural_width: false,
    hexpand: true,
  });
  return scroll;
}

function block(token, options) {
  switch (token.type) {
    case 'paragraph':
    case 'text': {
      const image = options.image && loneImage(token);
      const widget = image && options.image(image.href, image.text || '');
      return widget || labelFor(token);
    }
    case 'heading': {
      const heading = labelFor(token);
      heading.set_markup(`<span weight="semibold">${inline(token.tokens)}</span>`);
      heading.add_css_class('markdown-heading');
      return heading;
    }
    case 'list': return listBlock(token, options);
    case 'table': return tableBlock(token);
    case 'code': return codeBlock(token);
    case 'blockquote': {
      const frame = new Gtk.Frame({ child: renderTokens(token.tokens || [], options) });
      frame.add_css_class('markdown-quote');
      return frame;
    }
    case 'hr': return new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL });
    case 'html': return labelFor({ text: token.raw || token.text || '' });
    case 'space': return null;
    default:
      if (token.tokens) return renderTokens(token.tokens, options);
      return labelFor(token);
  }
}

function renderTokens(tokens, options) {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });
  for (const token of tokens) {
    const widget = block(token, options);
    if (widget) box.append(widget);
  }
  return box;
}

// options.image(href, alt) may return a widget for a standalone image, or a
// falsy value to leave it as text. Keeping it a callback is what lets this
// module stay free of any API-client or session knowledge.
export function render(text, options = {}) {
  const widget = renderTokens(marked.lexer(String(text || '')), options);
  widget.add_css_class('markdown-body');
  return widget;
}
