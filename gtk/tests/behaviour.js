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
const menuLabels = (model, out = []) => {
  for (let i = 0; i < model.get_n_items(); i++) {
    const section = model.get_item_link(i, Gio.MENU_LINK_SECTION);
    if (section) {
      menuLabels(section, out);
      continue;
    }
    const label = model.get_item_attribute_value(i, 'label', null);
    if (label) out.push(label.get_string()[0]);
  }
  return out;
};
const sidebarRows = win => {
  const out = [];
  for (let r = win._sidebar.sessionList.get_first_child(); r; r = r.get_next_sibling()) {
    out.push(r);
  }
  return out;
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

  it('reserves the status slot on every session row', () => {
    // Idle sessions show no dot, so the slot's job is to hold the column open
    // and keep the titles lined up.
    const widths = new Set();
    for (const row of win._sidebar.rows.values()) {
      if (row.subagentOf) continue; // read-only children carry no marks
      widths.add(row.get_child().get_first_child().get_size_request()[0]);
    }
    expect(widths.size).toBe(1);
  });

  it('hides the rows the search text does not match', async () => {
    const row = win._sidebar.rows.get(sessions[0].id);
    win._search.set_text('zzzz-nothing-matches-this');
    await until('the list to filter', () => !row.get_child_visible());
    win._search.set_text('');
    await until('the list to come back', () => row.get_child_visible());
  });

  it('opens a menu on the row and marks it while the menu is up', async () => {
    const row = win._sidebar.rows.get(sessions[0].id);
    win._showRowMenu(sessions[0], row, 4, 4);
    expect(row.has_css_class('has-open-popup')).toBeTruthy();
    const popover = descend(row).find(w => w instanceof Gtk.PopoverMenu);
    expect(popover).toBeTruthy();
    popover.popdown();
    await until('the row to be released', () => !row.has_css_class('has-open-popup'));
  });

  it('names the session actions in the menu model', () => {
    const labels = menuLabels(win._sessionMenuModel(sessions[0]));
    expect(labels).toContain('_Rename…');
    expect(labels).toContain('_Delete Permanently…');
    expect(labels.includes('_Pin') || labels.includes('Un_pin')).toBeTruthy();
  });

  it('folds a directory group\'s archived sessions behind one row', () => {
    const rows = sidebarRows(win);
    const toggle = rows.find(r => r.archivedToggle);
    if (!toggle) return; // nothing archived on this server
    const archived = rows.find(r => r.archived && r.groupKey === toggle.groupKey);
    expect(win._sidebar.rowMatches(archived)).toBeFalsy();
    toggle.onActivate();
    expect(win._sidebar.rowMatches(archived)).toBeTruthy();
    toggle.onActivate();
    expect(win._sidebar.rowMatches(archived)).toBeFalsy();
  });

  it('opens a session on activation, not on selection', async () => {
    const target = sessions[1];
    await win._selectSession(sessions[0].id);
    // GtkListBox moves the selection by itself when the list is filtered or
    // rebuilt; only a click or Enter may open a session.
    win._sidebar.select(win._sidebar.rows.get(target.id));
    expect(win._selectedId).toBe(sessions[0].id);
    win._sidebar.sessionList.emit('row-activated', win._sidebar.rows.get(target.id));
    await until('the session to open', () => win._selectedId === target.id);
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

  it('keeps following the bottom when a delta batch is taller than the threshold', () => {
    // The decision has to be sampled before the content grows, or a large
    // batch reads as the reader having scrolled up.
    const adjustment = win._chatScroll.get_vadjustment();
    adjustment.set_value(Math.max(0, adjustment.get_upper() - adjustment.get_page_size()));
    let sampledWhileAtBottom = null;
    const realNear = win._isNearBottom.bind(win);
    win._isNearBottom = () => {
      const near = realNear();
      if (sampledWhileAtBottom === null) sampledWhileAtBottom = near;
      return near;
    };
    try {
      win._growTranscript(() => {
        // Stand in for a tall batch: push the view far from the bottom.
        adjustment.set_value(0);
      });
      expect(sampledWhileAtBottom).toBeTruthy();
    } finally {
      win._isNearBottom = realNear;
    }
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

  it('drives the render mode from the toggle group', () => {
    const group = descend(win).find(w => w instanceof Adw.ToggleGroup);
    expect(group).toBeTruthy();
    expect(group.get_active_name()).toBe('md');
    group.set_active_name('raw');
    expect(win._rawMarkdown).toBeTruthy();
    group.set_active_name('md');
    expect(win._rawMarkdown).toBeFalsy();
  });

  it('wears the chosen backend\'s colour on the config picker', () => {
    win._modelCatalog = { backends: ['claude', 'codex'], models: {} };
    win._newBackend = 'codex';
    win._syncNewConfig();
    expect(win._newConfig.has_css_class('backend-codex')).toBeTruthy();
    expect(win._newConfig.has_css_class('backend-claude')).toBeFalsy();
    win._newBackend = 'claude';
    win._syncNewConfig();
    expect(win._newConfig.has_css_class('backend-claude')).toBeTruthy();
    expect(win._newConfig.has_css_class('backend-codex')).toBeFalsy();
  });

  it('shows context usage in the composer, beside send', () => {
    expect(descend(win._composer).includes(win._usage)).toBeTruthy();
    expect(win._usage.get_next_sibling()).toBe(win._send);
  });

  it('shows context usage once the backend reports tokens', () => {
    win._renderRuntime({ model: 'sonnet', effort: 'high', context_tokens: 42000, context_window: 200000 });
    expect(win._usage.get_visible()).toBeTruthy();
    expect(win._usageFraction).toBe(0.21);
    expect(win._usage.get_tooltip_text()).toBe('Context 21% used');
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
