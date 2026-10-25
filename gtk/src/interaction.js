// Permission requests and agent questions, rendered as cards above the
// composer. The server tags each with a kind, so nothing here keys off a tool
// name; answering goes back through the context's respond().

import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import * as markdown from './markdown.js';
import { ellipsize } from './text.js';

// ctx: { respond(id, payload, buttons) }
export class InteractionCards {
  constructor(ctx) {
    this._ctx = ctx;
  }

  isQuestion(pending) {
    return (pending.kind === 'choice' || pending.kind === 'text') &&
      Array.isArray(pending.tool_input?.questions) &&
      pending.tool_input.questions.length > 0;
  }


  interactionCard(body) {
    body.set_margin_top(10);
    body.set_margin_bottom(10);
    body.set_margin_start(12);
    body.set_margin_end(12);
    const frame = new Gtk.Frame({ child: body, hexpand: true });
    frame.add_css_class('card');
    frame.add_css_class('permission-card');
    return frame;
  }

  // The server's preview of the call, else its raw input.
  // source names the session a card comes from when it is not the open one.
  permissionWidget(pending, total, source = '') {
    if (pending.kind === 'plan') return this.planWidget(pending, total, source);
    const preview = pending.preview;
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    const heading = new Gtk.Label({
      label: `Permission: ${preview?.tool_name || pending.tool_name || pending.kind || 'tool'}` +
        (total > 1 ? ` (1 of ${total})` : ''),
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.END,
    });
    heading.add_css_class('heading');
    box.append(heading);
    this._appendSource(box, source);
    if (preview?.tool_target) {
      const target = new Gtk.Label({
        label: ellipsize(preview.tool_target, 300),
        tooltip_text: preview.tool_target,
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.MIDDLE,
      });
      target.add_css_class('monospace');
      target.add_css_class('caption');
      box.append(target);
    }
    if (pending.reason) {
      const reason = new Gtk.Label({
        label: pending.reason, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR,
      });
      reason.add_css_class('dim-label');
      box.append(reason);
    }

    const scrolled = child => new Gtk.ScrolledWindow({
      child,
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      max_content_height: 200,
      propagate_natural_height: true,
      hexpand: true,
    });
    if (!preview) {
      let inputText = '';
      try { inputText = JSON.stringify(pending.tool_input ?? {}, null, 2); }
      catch (_) { inputText = String(pending.tool_input || ''); }
      box.append(scrolled(markdown.codeWidget(ellipsize(inputText, 4000))));
    } else {
      if (preview.tool_input) {
        box.append(scrolled(markdown.codeWidget(ellipsize(preview.tool_input, 4000))));
      }
      if (preview.content) {
        box.append(scrolled(markdown.codeWidget(
          ellipsize(preview.content, 8000), preview.content_kind === 'diff')));
      }
    }

    const actions = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END });
    const deny = new Gtk.Button({ label: 'Deny' });
    deny.add_css_class('destructive-action');
    const buttons = [deny];
    let always = null;
    if (pending.allow_always) {
      always = new Gtk.Button({ label: 'Always allow' });
      buttons.push(always);
    }
    const allow = new Gtk.Button({ label: 'Allow' });
    allow.add_css_class('suggested-action');
    buttons.push(allow);
    for (const button of buttons) actions.append(button);
    box.append(actions);

    const respond = (behavior, scope) => this._ctx.respond(
      pending.id,
      { behavior, scope, reason: 'via usher GTK client' },
      buttons
    );
    deny.connect('clicked', () => respond('deny', 'once'));
    allow.connect('clicked', () => respond('allow', 'once'));
    always?.connect('clicked', () => respond('allow', 'always'));
    return box;
  }

  // Approving a plan to leave plan mode.
  planWidget(pending, total, source = '') {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    const heading = new Gtk.Label({
      label: `Plan${total > 1 ? ` (1 of ${total})` : ''}`, xalign: 0,
    });
    heading.add_css_class('heading');
    box.append(heading);
    this._appendSource(box, source);
    box.append(new Gtk.ScrolledWindow({
      child: markdown.render(pending.preview?.content || ''),
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      max_content_height: 360,
      propagate_natural_height: true,
      hexpand: true,
    }));
    const actions = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END });
    const keep = new Gtk.Button({ label: 'Keep Planning' });
    const approve = new Gtk.Button({ label: 'Approve' });
    approve.add_css_class('suggested-action');
    actions.append(keep);
    actions.append(approve);
    box.append(actions);
    const buttons = [keep, approve];
    keep.connect('clicked', () => this._ctx.respond(
      pending.id,
      { behavior: 'deny', scope: 'once', reason: 'The user wants to keep planning.' },
      buttons
    ));
    approve.connect('clicked', () => this._ctx.respond(
      pending.id, { behavior: 'allow', scope: 'once' }, buttons));
    return box;
  }

  // One question at a time, matching the web card: options (when the backend
  // offered any) plus a free-text control that doubles as "Other" and is the
  // only control for a "text" interaction. Answers go back keyed by the
  // question text, verbatim from the tool input.
  questionWidget(pending, queued, source = '') {
    const questions = pending.tool_input.questions;
    const answers = new Array(questions.length).fill('');
    let index = 0;

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    const heading = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    const title = new Gtk.Label({ label: 'Question', xalign: 0, hexpand: true });
    title.add_css_class('heading');
    heading.append(title);
    const position = new Gtk.Label({ xalign: 1 });
    position.add_css_class('caption');
    position.add_css_class('dim-label');
    heading.append(position);
    box.append(heading);
    this._appendSource(box, source);
    if (queued > 1) {
      const queuedLabel = new Gtk.Label({
        label: `${queued - 1} more waiting in this session`, xalign: 0,
      });
      queuedLabel.add_css_class('caption');
      queuedLabel.add_css_class('dim-label');
      box.append(queuedLabel);
    }

    const bodyHolder = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    box.append(bodyHolder);

    const actions = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END });
    const back = new Gtk.Button({ label: 'Back', visible: false });
    const ignore = new Gtk.Button({ label: 'Ignore' });
    const submit = new Gtk.Button({ label: 'Answer', sensitive: false });
    submit.add_css_class('suggested-action');
    actions.append(back);
    actions.append(ignore);
    actions.append(submit);
    box.append(actions);

    const syncActions = () => {
      const last = index === questions.length - 1;
      submit.set_label(last ? 'Answer' : 'Next');
      submit.set_sensitive(Boolean(answers[index]));
      back.set_visible(index > 0);
      position.set_label(questions.length > 1
        ? `${index + 1} of ${questions.length}` : '');
    };

    const render = () => {
      let child;
      while ((child = bodyHolder.get_first_child())) bodyHolder.remove(child);
      const question = questions[index];
      if (question.header) {
        const header = new Gtk.Label({ label: question.header, xalign: 0 });
        header.add_css_class('caption-heading');
        header.add_css_class('dim-label');
        bodyHolder.append(header);
      }
      const text = new Gtk.Label({
        label: (question.question || '') +
          (question.multiSelect ? ' (select all that apply)' : ''),
        xalign: 0,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
      });
      bodyHolder.append(text);

      const options = question.options || [];
      const toggles = [];
      const selected = new Set();
      // Restore what this question already holds, so stepping back and forward
      // does not lose an answer.
      const previous = answers[index];
      const previousLabels = previous ? previous.split(', ') : [];

      let free = null;
      const currentAnswer = () => {
        const typed = free.value.trim();
        if (typed) return typed;
        return [...selected].sort((a, b) => a - b)
          .map(i => options[i]?.label || '').filter(Boolean).join(', ');
      };
      const update = () => {
        answers[index] = currentAnswer();
        syncActions();
      };

      let syncing = false;
      options.forEach((option, oi) => {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        content.append(new Gtk.Label({ label: option.label || '', xalign: 0 }));
        if (option.description) {
          const description = new Gtk.Label({
            label: option.description, xalign: 0, wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
          });
          description.add_css_class('caption');
          description.add_css_class('dim-label');
          content.append(description);
        }
        if (option.preview) {
          const preview = new Gtk.Label({
            label: ellipsize(option.preview, 600), xalign: 0, yalign: 0,
            wrap: true, wrap_mode: Pango.WrapMode.CHAR,
          });
          preview.add_css_class('monospace');
          preview.add_css_class('caption');
          preview.add_css_class('dim-label');
          const scroll = new Gtk.ScrolledWindow({
            child: preview, hscrollbar_policy: Gtk.PolicyType.NEVER,
            max_content_height: 120, propagate_natural_height: true,
          });
          content.append(scroll);
        }
        const button = new Gtk.ToggleButton({ child: content });
        toggles.push(button);
        if (previousLabels.includes(option.label)) {
          selected.add(oi);
          button.set_active(true);
        }
        button.connect('toggled', () => {
          if (syncing) return;
          syncing = true;
          if (button.get_active()) {
            if (!question.multiSelect) {
              selected.clear();
              toggles.forEach((other, i) => { if (i !== oi) other.set_active(false); });
            }
            selected.add(oi);
            free.setText(''); // picking an option clears the free text
          } else {
            selected.delete(oi);
          }
          syncing = false;
          update();
        });
        bodyHolder.append(button);
      });

      const placeholder = question.placeholder ||
        (options.length ? 'or type your own answer…' : '');
      const prefill = previous && !previousLabels.some(l => options.some(o => o.label === l))
        ? previous : (question.prefill || '');
      free = question.multiline
        ? this.multilineAnswer(prefill, placeholder)
        : this.singleLineAnswer(prefill, placeholder);
      free.onChanged(() => {
        if (syncing) return;
        if (free.value.trim()) { // typing clears the option selection
          syncing = true;
          selected.clear();
          toggles.forEach(other => other.set_active(false));
          syncing = false;
        }
        update();
      });
      bodyHolder.append(free.widget);
      answers[index] = currentAnswer();
      syncActions();
    };

    back.connect('clicked', () => {
      if (index === 0) return;
      index--;
      render();
    });
    ignore.connect('clicked', () => this._ctx.respond(
      pending.id,
      {
        behavior: 'deny',
        scope: 'once',
        reason: 'The user declined to answer; continue in the conversation.',
      },
      [back, ignore, submit]
    ));
    submit.connect('clicked', () => {
      if (index < questions.length - 1) {
        index++;
        render();
        return;
      }
      const payload = {};
      questions.forEach((question, qi) => { payload[question.question] = answers[qi]; });
      this._ctx.respond(
        pending.id,
        { behavior: 'allow', answers: payload, reason: 'via usher GTK client' },
        [back, ignore, submit]
      );
    });

    render();
    return box;
  }

  _appendSource(box, source) {
    if (!source) return;
    const label = new Gtk.Label({
      label: `From ${source}`, xalign: 0, ellipsize: Pango.EllipsizeMode.END,
    });
    label.add_css_class('caption');
    label.add_css_class('dim-label');
    box.append(label);
  }

  singleLineAnswer(prefill, placeholder) {
    const entry = new Gtk.Entry({ placeholder_text: placeholder, hexpand: true });
    entry.set_text(prefill || '');
    return {
      widget: entry,
      get value() { return entry.get_text(); },
      setText: value => entry.set_text(value),
      onChanged: callback => entry.connect('changed', callback),
    };
  }

  // pi's editor dialogs ask for multi-line text. GtkTextView has no
  // placeholder, so one is overlaid the way the composer does it.
  multilineAnswer(prefill, placeholder) {
    const view = new Gtk.TextView({
      wrap_mode: Gtk.WrapMode.WORD_CHAR,
      top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8,
    });
    const buffer = view.get_buffer();
    buffer.set_text(prefill || '', -1);
    const scroll = new Gtk.ScrolledWindow({
      child: view, min_content_height: 90, max_content_height: 220,
      propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER,
    });
    const frame = new Gtk.Frame({ child: scroll, hexpand: true });
    frame.add_css_class('composer-frame');
    const hint = new Gtk.Label({
      label: placeholder, xalign: 0, halign: Gtk.Align.START,
      valign: Gtk.Align.START, margin_top: 9, margin_start: 9, can_target: false,
      visible: Boolean(placeholder) && !prefill,
    });
    hint.add_css_class('dim-label');
    const overlay = new Gtk.Overlay({ child: frame, hexpand: true });
    overlay.add_overlay(hint);
    const text = () => buffer.get_text(
      buffer.get_start_iter(), buffer.get_end_iter(), false);
    buffer.connect('changed', () => {
      hint.set_visible(Boolean(placeholder) && buffer.get_char_count() === 0);
    });
    return {
      widget: overlay,
      get value() { return text(); },
      setText: value => buffer.set_text(value, -1),
      onChanged: callback => buffer.connect('changed', callback),
    };
  }
}
