// Behaviour that needs a live usher and a display: transcript paging,
// interaction cards, drafts, the new-session view. Enabled by -Dtest_url and
// -Dtest_display.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import { describe, it, expect, beforeAll, sleep, until, run } from './harness.js';
import { BackendProcess } from '../src/backend-process.js';
import { InteractionCards } from '../src/interaction.js';
import { installStyles } from '../src/style.js';
import { UsherWindow } from '../src/window.js';

const url = GLib.getenv('USHER_TEST_URL');
if (!url) throw new Error('USHER_TEST_URL is required');
GLib.setenv('XDG_CONFIG_HOME', GLib.dir_make_tmp('usher-behaviour-XXXXXX'), true);
// UsherWindow reconfigures the backend from its own server store, so the
// target has to arrive the way a user's environment override would.
GLib.setenv('USHER_BASE_URL', url, true);

const descend = (widget, out = []) => {
  for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) {
    out.push(c);
    descend(c, out);
  }
  return out;
};
const labels = widget => descend(widget)
  .filter(w => w instanceof Gtk.Label).map(l => l.get_label());
const buttonLabelled = (widget, text) => descend(widget)
  .find(w => w instanceof Gtk.Button && w.get_label() === text);
const promptText = win => {
  const b = win._prompt.get_buffer();
  return b.get_text(b.get_start_iter(), b.get_end_iter(), false);
};

let win = null;
let api = null;
let sessions = [];

describe('the app against a live usher', () => {
  beforeAll(async () => {
    const app = new Adw.Application({
      application_id: 'io.github.nexustar.Usher.Test',
      flags: Gio.ApplicationFlags.NON_UNIQUE,
    });
    app.register(null);
    installStyles();
    const backend = new BackendProcess();
    backend.configure({ url, binaryPath: '' });
    win = new UsherWindow({ application: app, backend });
    win.present();
    await win.start();
    // The poll would overwrite injected fixtures mid-test.
    if (win._pollId) {
      GLib.source_remove(win._pollId);
      win._pollId = 0;
    }
    api = win._api;
    sessions = (await api.listSessions()).filter(s => !s.is_subagent);
    if (sessions.length < 2) throw new Error('needs at least two sessions on the server');
  });

  it('lists the server\'s sessions in the sidebar', () => {
    expect(win._sidebar.rows.size).toBeWithin(sessions.length, Infinity);
  });

  it('keeps a draft with the session it was typed for', async () => {
    await win._selectSession(sessions[0].id);
    win._prompt.get_buffer().set_text('for the first', -1);
    await win._selectSession(sessions[1].id);
    expect(promptText(win)).toBe('');
    win._prompt.get_buffer().set_text('for the second', -1);
    await win._selectSession(sessions[0].id);
    expect(promptText(win)).toBe('for the first');
    await win._selectSession(sessions[1].id);
    expect(promptText(win)).toBe('for the second');
    win._prompt.get_buffer().set_text('', -1);
    await win._selectSession(sessions[0].id);
    win._prompt.get_buffer().set_text('', -1);
  });

  it('echoes a sent message before the server confirms it', () => {
    const before = win._transcriptStore.get_n_items();
    win._appendOptimisticTurn('hello there');
    expect(win._transcriptStore.get_n_items()).toBe(before + 1);
    win._appendUserTurn({ content: 'hello there', ts: new Date().toISOString() });
    const keys = [];
    for (let i = 0; i < win._transcriptStore.get_n_items(); i++) {
      keys.push(win._transcriptStore.get_item(i).key);
    }
    expect(keys.includes('__optimistic__')).toBeFalsy();
  });

  it('reports the transcript window position', async () => {
    const target = sessions.find(async s => (await api.getTranscript(s.id, { limit: 1 })).total > 4)
      || sessions[0];
    const newest = await api.getTranscript(target.id, { limit: 3 });
    expect(newest.offset).toBe(Math.max(0, newest.total - newest.turns.length));
    if (newest.offset > 0) {
      const older = await api.getTranscript(target.id, { limit: 3, before: newest.offset });
      expect(older.offset).toBe(Math.max(0, newest.offset - older.turns.length));
    }
  });

  it('pages older turns in without losing them on the next refresh', async () => {
    let target = null;
    for (const s of sessions) {
      const { total } = await api.getTranscript(s.id, { limit: 1 });
      if (total > 6) { target = { id: s.id, total }; break; }
    }
    if (!target) return; // nothing long enough on this server
    await win._selectSession(target.id);
    win._transcriptLimit = 3;
    await win._loadTranscript(target.id);
    expect(win._renderedTurns).toHaveLength(3);
    expect(win._windowStart).toBe(target.total - 3);

    const real = api.getTranscript.bind(api);
    api.getTranscript = (id, opts = {}) =>
      real(id, (opts.before ?? -1) >= 0 ? { ...opts, limit: 3 } : opts);
    try {
      await win._loadEarlierMessages();
      expect(win._renderedTurns).toHaveLength(6);
      expect(win._transcriptLimit).toBe(6);
      await win._loadTranscript(target.id);
      expect(win._renderedTurns).toHaveLength(6);
    } finally {
      api.getTranscript = real;
    }
  });

  it('opens the new-session view in place of the transcript', async () => {
    await win._showNewSession();
    await until('the catalogs to load', () => win._newConfig.get_menu_model() !== null);
    expect(win._newMode).toBeTruthy();
    expect(win._newBar.get_visible()).toBeTruthy();
    expect(win._chatScroll.get_visible()).toBeFalsy();
    expect(win._status.get_title()).toBe('New session');
    expect(win.get_visible_dialog()).toBeFalsy();
    expect(win._send.get_visible()).toBeTruthy();
    await win._selectSession(sessions[0].id);
    expect(win._newMode).toBeFalsy();
    expect(win._newBar.get_visible()).toBeFalsy();
  });

  it('offers the backend\'s slash commands while a command is being typed', async () => {
    await win._selectSession(sessions[0].id);
    await sleep(300);
    win._commands = [
      { name: 'model', description: 'switch model' },
      { name: 'compact', description: 'compact context' },
    ];
    win._commandSource = 'claude';
    win._prompt.get_buffer().set_text('/mod', -1);
    await until('the popup', async () => win._commandPopup.get_visible());
    expect(win._commandList.get_row_at_index(0).get_title()).toBe('/model');
    expect(win._commandList.get_row_at_index(1)).toBeFalsy();
    win._prompt.get_buffer().set_text('hello /model', -1);
    await sleep(150);
    expect(win._commandPopup.get_visible()).toBeFalsy();
    win._prompt.get_buffer().set_text('', -1);
  });

  it('shows context usage once the backend reports tokens', () => {
    win._renderRuntime({ model: 'sonnet', effort: 'high', context_tokens: 42000, context_window: 200000 });
    expect(win._usage.get_visible()).toBeTruthy();
    expect(win._usageLabel.get_label()).toBe('21%');
    expect(labels(win._usageDetail)).toContain('sonnet');
    win._renderRuntime({ context_tokens: 0 });
    expect(win._usage.get_visible()).toBeFalsy();
  });
});

describe('interaction cards', () => {
  const answered = [];
  const cards = new InteractionCards({
    respond: (id, payload) => answered.push({ id, payload }),
  });

  it('treats kind, not the tool name, as the signal', () => {
    const questions = { questions: [{ question: 'q' }] };
    expect(cards.isQuestion({ kind: 'choice', tool_input: questions })).toBeTruthy();
    expect(cards.isQuestion({ kind: 'text', tool_input: questions })).toBeTruthy();
    expect(cards.isQuestion({ kind: 'permission', tool_input: questions })).toBeFalsy();
    expect(cards.isQuestion({ tool_name: 'AskUserQuestion', tool_input: questions })).toBeFalsy();
  });

  it('falls back to the kind when a permission has no tool name', () => {
    const card = cards.permissionWidget({ id: 'p', kind: 'permission', tool_input: {} }, 1);
    expect(labels(card)[0]).toBe('Permission: permission');
  });

  it('offers "always allow" only when the backend advertised it', () => {
    const plain = cards.permissionWidget({ id: 'p', kind: 'permission', tool_input: {} }, 1);
    expect(buttonLabelled(plain, 'Always allow')).toBeFalsy();
    const always = cards.permissionWidget(
      { id: 'p', kind: 'permission', tool_input: {}, allow_always: true }, 1);
    expect(buttonLabelled(always, 'Always allow')).toBeTruthy();
  });

  it('walks a multi-question card one question at a time', async () => {
    const card = cards.questionWidget({
      id: 'q', kind: 'choice', tool_input: { questions: [
        { question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Second?', options: [{ label: 'C' }] },
      ] },
    }, 1);
    expect(labels(card)).toContain('1 of 2');
    expect(labels(card)).toContain('First?');
    expect(labels(card).includes('Second?')).toBeFalsy();

    const next = buttonLabelled(card, 'Next');
    expect(next.get_sensitive()).toBeFalsy();
    const back = buttonLabelled(card, 'Back');
    expect(back.get_visible()).toBeFalsy();

    descend(card).filter(w => w instanceof Gtk.ToggleButton)[0].set_active(true);
    expect(next.get_sensitive()).toBeTruthy();
    next.emit('clicked');
    expect(labels(card)).toContain('Second?');
    expect(buttonLabelled(card, 'Answer')).toBeTruthy();

    buttonLabelled(card, 'Back').emit('clicked');
    expect(descend(card).filter(w => w instanceof Gtk.ToggleButton)[0].get_active()).toBeTruthy();
  });

  it('renders a text question as free text, with its prefill', () => {
    const card = cards.questionWidget({
      id: 'q', kind: 'text', tool_input: { questions: [
        { question: 'Describe it', placeholder: 'type…', prefill: 'seed', multiline: true },
      ] },
    }, 1);
    const views = descend(card).filter(w => w instanceof Gtk.TextView);
    expect(views).toHaveLength(1);
    const buffer = views[0].get_buffer();
    expect(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false)).toBe('seed');
    expect(descend(card).filter(w => w instanceof Gtk.ToggleButton)).toHaveLength(0);
    expect(buttonLabelled(card, 'Answer').get_sensitive()).toBeTruthy();
  });

  it('sends the answers back keyed by question', () => {
    answered.length = 0;
    const card = cards.questionWidget({
      id: 'q7', kind: 'choice', tool_input: { questions: [
        { question: 'Pick', options: [{ label: 'Chosen' }] },
      ] },
    }, 1);
    descend(card).filter(w => w instanceof Gtk.ToggleButton)[0].set_active(true);
    buttonLabelled(card, 'Answer').emit('clicked');
    expect(answered).toHaveLength(1);
    expect(answered[0].id).toBe('q7');
    expect(answered[0].payload.behavior).toBe('allow');
    expect(answered[0].payload.answers.Pick).toBe('Chosen');
  });
});

await run();
