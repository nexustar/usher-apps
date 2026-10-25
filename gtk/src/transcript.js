// Transcript rendering: turns, tool cards, and inline images.
//
// The view owns no state — everything it needs about the session comes from
// the context it is built with — so it can be exercised with stubs.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import * as markdown from './markdown.js';
import { AspectPicture, showPictureDialog } from './picture.js';
import { ellipsize } from './text.js';

// Inline transcript images are capped to this box; clicking one opens it full
// size. Both are logical pixels, scaled down only (never up).
const INLINE_IMAGE_MAX_WIDTH = 560;
const INLINE_IMAGE_MAX_HEIGHT = 400;

// The tools that hand work to another session.
export const ROUTING_TOOL = /(^|__)(send_to_session|create_session)$/;
// …and those that also move the router's focus.
export const FOCUS_TOOL = /(^|__)(send_to_session|create_session|resolve_session)$/;

// The target session id from a routing tool's result: create_session does
// not know it when called.
export function parseRoutedSession(content) {
  if (!content) return '';
  const a = content.indexOf('{');
  const b = content.lastIndexOf('}');
  if (a < 0 || b <= a) return '';
  try {
    const result = JSON.parse(content.slice(a, b + 1));
    return typeof result.session_id === 'string' ? result.session_id : '';
  } catch (_) {
    return '';
  }
}

// ctx: { window, api, sessionId(), backendName(), rawMarkdown(), onFork(uuid),
//        canFork(), onImageLoaded(), sessionTitle(id), openSession(id) }
export class TranscriptView {
  constructor(ctx) {
    this._ctx = ctx;
  }

  // The turn's footer: timestamp on the left, fork on the right. There is no
  // speaker name — the bubble marks the user and flat content marks the
  // assistant, which is the split the web UI settled on.
  turnFooter(ts, alignEnd) {
    const footer = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 18,
      halign: alignEnd ? Gtk.Align.END : Gtk.Align.START,
      margin_top: 2,
    });
    const time = new Date(ts || '');
    if (!Number.isNaN(time.getTime())) {
      const stamp = new Gtk.Label({
        label: `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`,
      });
      stamp.add_css_class('caption');
      stamp.add_css_class('dim-label');
      footer.append(stamp);
    }
    return footer;
  }

  // The web footer's control, verbatim: U+2443 and the word. The glyph needs a
  // font covering the OCR block (Noto Sans Symbols and friends); without one
  // GTK draws tofu, with none of a browser's wider fallback.
  forkButton(uuid) {
    const button = new Gtk.Button({
      label: '\u2443 fork',
      valign: Gtk.Align.CENTER,
      tooltip_text: 'Fork the conversation from here',
    });
    button.add_css_class('flat');
    button.add_css_class('dim-label');
    button.add_css_class('turn-fork');
    button.connect('clicked', async self => {
      self.set_sensitive(false);
      try {
        await this._ctx.onFork(uuid);
      } finally {
        self.set_sensitive(true);
      }
    });
    return button;
  }


  // routed: replies to routed work, shown below the turn.
  turnWidget(turn, routed = null) {
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    outer.set_margin_top(6);
    outer.set_margin_bottom(6);
    outer.set_margin_start(12);
    outer.set_margin_end(12);

    if (turn.role === 'assistant') {
      const flow = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
      // A run of tool calls reads as one block rather than a stack of separate
      // cards, which is what the web does with them. An image part renders as
      // a picture, not a card, so it ends the run.
      const run = [];
      const flush = () => {
        if (!run.length) return;
        if (run.length === 1) {
          flow.append(run[0]);
        } else {
          const group = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
          group.add_css_class('tool-group');
          for (const card of run) group.append(card);
          flow.append(group);
        }
        run.length = 0;
      };
      for (const part of turn.parts || []) {
        if (part.type !== 'tool') {
          flush();
          flow.append(this.renderText(part.content || ''));
          continue;
        }
        const widget = this.toolWidget(part);
        if (widget.has_css_class('tool-card')) {
          run.push(widget);
          continue;
        }
        flush();
        flow.append(widget);
      }
      flush();
      if (turn.live && turn.previewText) {
        const preview = markdown.render(turn.previewText);
        preview.add_css_class('dim-label');
        flow.append(preview);
      }
      if (turn.live && !flow.get_first_child()) {
        const status = new Gtk.Label({ label: turn.status || 'Working…', xalign: 0 });
        status.add_css_class('dim-label');
        flow.append(status);
      }
      outer.append(flow);
      // Footers only settle once the turn has: a live turn has neither a final
      // timestamp nor a fork point yet.
      if (!turn.live) {
        const footer = this.turnFooter(turn.ts, false);
        if (turn.uuid && this._ctx.canFork?.() !== false) footer.append(this.forkButton(turn.uuid));
        if (footer.get_first_child()) outer.append(footer);
      }
    } else if (turn.role === 'error' ||
               (turn.role === 'system' && turn.content !== 'Context compacted')) {
      // Errors and notices are the backend's words, verbatim.
      const text = new Gtk.Label({
        label: `${turn.role === 'error' ? '■ ' : ''}${turn.content || ''}`,
        xalign: 0,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
        selectable: true,
      });
      if (turn.role === 'error') {
        text.add_css_class('turn-error');
      } else {
        text.add_css_class('notice');
        if (turn.level === 'warning') text.add_css_class('warning');
        else text.add_css_class('dim-label');
      }
      outer.append(text);
      const footer = this.turnFooter(turn.ts, false);
      if (footer.get_first_child()) outer.append(footer);
    } else if (turn.role !== 'user') {
      // Context-compaction markers: a centered, dim, compact marker instead
      // of a speech bubble.
      const marker = new Gtk.Label({
        label: turn.content || turn.role,
        halign: Gtk.Align.CENTER,
      });
      marker.add_css_class('caption');
      marker.add_css_class('dim-label');
      outer.append(marker);
    } else {
      const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
      inner.set_margin_top(8);
      inner.set_margin_bottom(8);
      inner.set_margin_start(12);
      inner.set_margin_end(12);
      inner.append(this.renderText(turn.content || ''));
      const bubble = new Gtk.Box({ halign: Gtk.Align.END });
      bubble.add_css_class('user-bubble');
      if (turn.origin) {
        bubble.add_css_class('injected');
        bubble.set_tooltip_text(`Sent by ${turn.origin}, not typed`);
      }
      bubble.append(inner);
      // Keep the bubble clear of the left edge so even a long prompt still
      // reads as right-aligned speech.
      bubble.set_margin_start(48);
      outer.append(bubble);
      const footer = this.turnFooter(turn.ts, true);
      if (footer.get_first_child()) outer.append(footer);
    }
    for (const reply of routed || []) outer.append(this.routedReplyWidget(reply));
    return new Adw.Clamp({
      child: outer,
      maximum_size: 900,
      tightening_threshold: 700,
    });
  }

  routedReplyWidget(reply) {
    // Full width, so a code block scrolls inside rather than spilling out.
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL, spacing: 4,
      margin_top: 6, margin_bottom: 6,
    });
    box.add_css_class('routed-reply');
    const head = new Gtk.Box({ spacing: 6 });
    const name = reply.title || `session ${reply.session_id.slice(0, 8)}`;
    const source = new Gtk.Button({
      child: new Gtk.Label({ label: name, ellipsize: Pango.EllipsizeMode.END, xalign: 0 }),
      tooltip_text: `Open ${name}`,
      hexpand: false,
    });
    source.add_css_class('flat');
    source.add_css_class('routed-source');
    if (reply.backend) source.add_css_class(`backend-${reply.backend}`);
    source.connect('clicked', () => this._ctx.openSession?.(reply.session_id));
    head.append(source);
    const time = new Date(reply.ts || '');
    if (reply.done && !Number.isNaN(time.getTime())) {
      const stamp = new Gtk.Label({
        label: `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`,
        valign: Gtk.Align.CENTER,
      });
      stamp.add_css_class('caption');
      stamp.add_css_class('dim-label');
      head.append(stamp);
    }
    box.append(head);
    if (!reply.done || !reply.reply) {
      // Interrupted, tools only, or the prompt never arrived.
      const state = new Gtk.Label({
        label: !reply.done
          ? (reply.status === 'awaiting_permission' ? 'Waiting for approval' : 'Working…')
          : 'No reply',
        xalign: 0,
      });
      state.add_css_class('caption');
      state.add_css_class('dim-label');
      box.append(state);
    } else {
      box.append(this.renderText(reply.reply));
    }
    return box;
  }

  routedPartWidget(part, id) {
    let sent = '';
    try {
      const input = JSON.parse(part.tool_input || '{}');
      sent = input.text || input.initial_message || '';
    } catch (_) { /* no input recorded */ }
    const title = this._ctx.sessionTitle?.(id) || id.slice(0, 8);
    const header = new Gtk.Label({
      label: `→ ${ellipsize(title, 120)}`,
      tooltip_text: title,
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.END,
      hexpand: true,
    });
    header.add_css_class('tool-header');
    const expander = new Gtk.Expander({ label_widget: header, hexpand: true });
    expander.connect('notify::expanded', () => {
      if (!expander.get_expanded() || expander.get_child() || !sent) return;
      const body = new Gtk.Label({
        label: sent, xalign: 0, wrap: true, selectable: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
      });
      body.add_css_class('tool-body');
      expander.set_child(body);
    });
    const open = new Gtk.Button({
      icon_name: 'go-next-symbolic',
      tooltip_text: 'Open this session',
      valign: Gtk.Align.START,
    });
    open.add_css_class('flat');
    open.connect('clicked', () => this._ctx.openSession?.(id));
    const row = new Gtk.Box({ spacing: 4 });
    row.append(expander);
    row.append(open);
    const frame = new Gtk.Frame({ child: row, hexpand: true });
    frame.add_css_class('routed-part');
    return frame;
  }

  toolWidget(part) {
    // A rejected routing call carries no session id and stays a tool card.
    if (ROUTING_TOOL.test(part.tool_name || '')) {
      const id = parseRoutedSession(part.content);
      if (id) return this.routedPartWidget(part, id);
    }
    // show_image exists to put a picture in the transcript, so it renders as
    // one instead of a collapsible tool call.
    if (part.tool_target && /(^|__)show_image$/.test(part.tool_name || '')) {
      const picture = this.imageWidget(part.tool_target, this.imageDims(part.content));
      if (picture) return picture;
    }
    const expander = new Gtk.Expander();
    expander.set_label_widget(this.toolHeader(part));
    expander.connect('notify::expanded', () => {
      if (!expander.get_expanded() || expander.get_child()) return;
      const body = this.toolBody(part);
      body.add_css_class('tool-body');
      expander.set_child(body);
    });
    const frame = new Gtk.Frame({ child: expander, hexpand: true });
    frame.add_css_class('tool-card');
    if (/^(Edit|Write)$/i.test(part.tool_name || '')) expander.set_expanded(true);
    return frame;
  }

  // Tool output is data: never laid out as markdown.
  toolBody(part) {
    if (part.content_kind === 'image') {
      return this.imageWidget(part.tool_target) || new Gtk.Box();
    }
    const text = String(part.content || '').replace(/\n+$/, '');
    if (!text) return new Gtk.Box();
    return markdown.codeWidget(text, part.content_kind === 'diff');
  }

  toolHeader(part) {
    const full = `${part.tool_name || 'Tool'}  ${part.tool_target || ''}`.trim();
    const label = new Gtk.Label({
      label: ellipsize(full, 160),
      tooltip_text: full,
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.END,
      max_width_chars: 80,
      hexpand: true,
    });
    label.add_css_class('tool-header');
    return label;
  }


  // Mirrors the server's /image allowlist, which excludes SVG (a same-origin
  // SVG runs its scripts under usher's auth). Anything with a URI scheme is
  // remote — the endpoint resolves host paths only — and stays a text link.
  isDisplayableImage(path) {
    const value = String(path || '');
    if (GLib.uri_parse_scheme(value)) return false;
    return /\.(png|jpe?g|gif|webp)$/i.test(value.split('?')[0]);
  }

  // show_image's tool result carries {"w":…,"h":…}; pull it out to size the
  // picture before the bytes arrive. Codex fences the output, so scan for the
  // first {…} span rather than parsing the whole string.
  imageDims(content) {
    const text = String(content || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      const w = parseInt(parsed.w, 10);
      const h = parseInt(parsed.h, 10);
      if (w > 0 && h > 0) return { w, h };
    } catch (_) { /* not a dims payload — the texture supplies its own size */ }
    return null;
  }

  // The displayed width for an image of (w, h), never upscaled. The height
  // budget folds into the width because the aspect ratio is preserved, which
  // lets a single width cap bound both — see _imageWidget for why capping
  // width (rather than requesting a size) is the only safe option.
  inlineWidth(w, h) {
    return Math.round(Math.min(w, INLINE_IMAGE_MAX_WIDTH, w * INLINE_IMAGE_MAX_HEIGHT / h));
  }

  // An inline transcript image. Bytes load asynchronously through the
  // session-scoped endpoint; the widget is returned immediately so the
  // transcript never blocks on the network. Returns null for paths the server
  // would refuse anyway, letting the caller keep its text fallback.
  imageWidget(path, dims = null) {
    if (!this._ctx.sessionId() || !this.isDisplayableImage(path)) return null;
    const sessionId = this._ctx.sessionId();
    const picture = new AspectPicture({
      can_shrink: true,
      content_fit: Gtk.ContentFit.CONTAIN,
      halign: Gtk.Align.START,
      tooltip_text: path,
    });
    // Capped by clamping the width, never by a size request: a request is a
    // *minimum*, and one wider than a narrow window overflows the whole
    // transcript. The clamp must fill its row — halign START would collapse it
    // to nothing — so the picture carries the left alignment.
    const box = new Adw.Clamp({ child: picture });
    box.add_css_class('transcript-image');
    // Knowing the aspect up front also reserves the right height, so the
    // transcript does not jump when the bytes land.
    if (dims) {
      box.set_maximum_size(this.inlineWidth(dims.w, dims.h));
      picture.setAspect(dims.w, dims.h);
    }

    this._ctx.api.imageBytes(sessionId, path).then(bytes => {
      if (this._ctx.sessionId() !== sessionId) return;
      const texture = Gdk.Texture.new_from_bytes(bytes);
      picture.set_paintable(texture);
      box.set_maximum_size(this.inlineWidth(texture.get_width(), texture.get_height()));
      picture.setAspect(texture.get_width(), texture.get_height());
      const click = new Gtk.GestureClick();
      click.connect('released', () => this.showFullImage(path, texture));
      picture.add_controller(click);
      picture.set_cursor(Gdk.Cursor.new_from_name('pointer', null));
      // The turn only gains its real height now, so a reader sitting at the
      // bottom would otherwise be left just above a freshly arrived image.
      this._ctx.onImageLoaded();
    }).catch(error => {
      if (this._ctx.sessionId() !== sessionId) return;
      const failed = new Gtk.Label({
        label: `Image unavailable: ${path.split('/').pop() || path}`,
        xalign: 0,
        tooltip_text: error.message || String(error),
      });
      failed.add_css_class('caption');
      failed.add_css_class('dim-label');
      box.set_child(failed);
    });
    return box;
  }

  // Given to markdown.render so a line holding nothing but an image renders as
  // a picture. Returning null (remote or non-raster) keeps the text fallback.
  markdownOptions() {
    return { image: href => this.imageWidget(href) };
  }

  // Message bodies render as markdown unless the raw view is on, which shows
  // exactly what the model wrote — markup, fences and all.
  renderText(text) {
    if (!this._ctx.rawMarkdown()) return markdown.render(text, this.markdownOptions());
    const label = new Gtk.Label({
      label: text,
      xalign: 0,
      yalign: 0,
      selectable: true,
      wrap: true,
      wrap_mode: Pango.WrapMode.WORD_CHAR,
      hexpand: true,
    });
    label.add_css_class('monospace');
    label.add_css_class('caption');
    return label;
  }

  showFullImage(path, texture) {
    showPictureDialog(this._ctx.window, texture, path.split('/').pop() || 'Image',
      `${texture.get_width()} × ${texture.get_height()}`);
  }
}
