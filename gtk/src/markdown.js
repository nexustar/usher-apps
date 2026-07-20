import Adw from 'gi://Adw?version=1';
import GtkSource from 'gi://GtkSource?version=5';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import './vendor/marked.umd.js';

GtkSource.init();

const marked = globalThis.marked;
if (!marked?.lexer) throw new Error('vendored marked lexer did not load');

const languageAliases = new Map([
  ['bash', 'sh'], ['shell', 'sh'], ['zsh', 'sh'],
  ['js', 'javascript'], ['jsx', 'js'],
  ['ts', 'typescript'], ['tsx', 'typescript-jsx'],
  ['py', 'python'], ['rb', 'ruby'],
  ['c++', 'cpp'], ['cc', 'cpp'], ['cs', 'c-sharp'],
  ['yml', 'yaml'], ['md', 'markdown'],
]);

const languageManager = GtkSource.LanguageManager.get_default();

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

function codeBlock(token) {
  const languageName = String(token.lang || '').trim().split(/\s+/)[0].toLowerCase();
  const languageId = languageAliases.get(languageName) || languageName;
  const language = languageId ? languageManager.get_language(languageId) : null;
  const buffer = new GtkSource.Buffer({ highlight_syntax: Boolean(language) });
  if (language) buffer.set_language(language);
  const schemes = GtkSource.StyleSchemeManager.get_default();
  const dark = Adw.StyleManager.get_default().get_dark();
  const scheme = schemes.get_scheme(dark ? 'Adwaita-dark' : 'Adwaita') ||
    schemes.get_scheme(dark ? 'classic-dark' : 'classic');
  if (scheme) buffer.set_style_scheme(scheme);
  buffer.set_text(String(token.text || '').trim(), -1);
  const view = new GtkSource.View({
    buffer,
    editable: false,
    cursor_visible: false,
    monospace: true,
    show_line_numbers: false,
    highlight_current_line: false,
    wrap_mode: Gtk.WrapMode.NONE,
    hexpand: true,
    top_margin: 8,
    bottom_margin: 8,
    left_margin: 8,
    right_margin: 8,
    pixels_above_lines: 1,
    pixels_below_lines: 1,
  });
  const scroll = new Gtk.ScrolledWindow({
    child: view,
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

function listBlock(token) {
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
    row.append(renderTokens(item.tokens || []));
    list.append(row);
  }
  return list;
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

function block(token) {
  switch (token.type) {
    case 'paragraph':
    case 'text':
      return labelFor(token);
    case 'heading': {
      const heading = labelFor(token);
      heading.set_markup(`<span weight="semibold">${inline(token.tokens)}</span>`);
      heading.add_css_class('markdown-heading');
      return heading;
    }
    case 'list': return listBlock(token);
    case 'table': return tableBlock(token);
    case 'code': return codeBlock(token);
    case 'blockquote': {
      const frame = new Gtk.Frame({ child: renderTokens(token.tokens || []) });
      frame.add_css_class('markdown-quote');
      return frame;
    }
    case 'hr': return new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL });
    case 'html': return labelFor({ text: token.raw || token.text || '' });
    case 'space': return null;
    default:
      if (token.tokens) return renderTokens(token.tokens);
      return labelFor(token);
  }
}

function renderTokens(tokens) {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, hexpand: true });
  for (const token of tokens) {
    const widget = block(token);
    if (widget) box.append(widget);
  }
  return box;
}

export function render(text) {
  const widget = renderTokens(marked.lexer(String(text || '')));
  widget.add_css_class('markdown-body');
  return widget;
}
