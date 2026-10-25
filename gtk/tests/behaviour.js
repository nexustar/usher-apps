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
import * as diagram from '../src/diagram.js';
import * as markdown from '../src/markdown.js';

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
const sidebarItems = win => {
  const out = [];
  for (let i = 0; i < win._sidebar._store.get_n_items(); i++) {
    out.push(win._sidebar._store.get_item(i));
  }
  return out;
};
const visibleCount = win => win._sidebar._filtered.get_n_items();

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
    // Archived sessions are folded away in the sidebar; these tests click rows.
    sessions = (await api.listSessions()).filter(s => !s.subagent && !s.archived);
    if (sessions.length < 2) throw new Error('needs at least two unarchived sessions on the server');
  });

  it('lists the server\'s sessions in the sidebar', () => {
    expect(win._sidebar._store.get_n_items()).toBeWithin(sessions.length, Infinity);
  });

  it('reserves the status slot on every session row', () => {
    // One recycled row shell, so the slot is fixed by construction; check the
    // shells the view actually built. Idle sessions show no dot, and the slot
    // still holds the column open so the titles line up.
    const widths = new Set();
    for (const box of descend(win._sidebar.listView)) {
      if (!(box instanceof Gtk.Box) || !box.item) continue;
      widths.add(box.get_first_child().get_size_request()[0]);
    }
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBe(10);
  });

  it('rebuilds the list only when a row would look different', () => {
    const a = { id: 'a', title: 'A', cwd: '/w', status: 'idle',
      last_input_at: '2026-01-02T00:00:00Z' };
    const b = { id: 'b', title: 'B', cwd: '/w', status: 'idle',
      last_input_at: '2026-01-01T00:00:00Z' };
    try {
      win._sidebar.render([a, b]);
      const digest = win._sidebar.sessionsDigest;
      // A later event that reorders nothing and changes nothing on screen:
      // the poll delivers these constantly.
      win._sidebar.render([{ ...a, last_event_at: '2026-01-02T00:00:01Z' }, b]);
      expect(win._sidebar.sessionsDigest).toBe(digest);
      win._sidebar.render([{ ...a, title: 'A renamed' }, b]);
      expect(win._sidebar.sessionsDigest === digest).toBeFalsy();
    } finally {
      win._sidebar.sessionsDigest = null;
      win._renderSessions(sessions);
    }
  });

  it('hides the rows the search text does not match', async () => {
    const before = visibleCount(win);
    win._search.set_text('zzzz-nothing-matches-this');
    await until('the filter to empty the list', () => visibleCount(win) === 0);
    // With nothing left the empty page takes over from the list.
    expect(win._sidebar.widget.get_visible_child_name()).toBe('empty');
    expect(win._sidebar._placeholder.get_label()).toBe('No sessions match the search');
    win._search.set_text('');
    await until('the list to come back', () => visibleCount(win) === before);
    expect(win._sidebar.widget.get_visible_child_name()).toBe('list');
  });

  it('opens a menu on the row and marks it while the menu is up', async () => {
    const anchor = win._sidebar.listView;
    win._showRowMenu(sessions[0], anchor, 4, 4);
    expect(anchor.has_css_class('has-open-popup')).toBeTruthy();
    const popover = descend(anchor).find(w => w instanceof Gtk.PopoverMenu);
    expect(popover).toBeTruthy();
    popover.popdown();
    await until('the anchor to be released',
      () => !anchor.has_css_class('has-open-popup'));
  });

  it('names the session actions in the menu model', () => {
    const labels = menuLabels(win._sessionMenuModel(sessions[0]));
    expect(labels).toContain('_Rename…');
    expect(labels).toContain('_Delete Permanently…');
    expect(labels.includes('_Pin') || labels.includes('Un_pin')).toBeTruthy();
  });

  it('reveals a session\'s subagents from its menu', () => {
    const items = sidebarItems(win);
    const child = items.find(i => i.kind === 'subagent');
    if (!child) return; // no subagents on this server
    const parentId = child.subagentOf;
    expect(win._sidebar.subagentCount(parentId)).toBeWithin(1, Infinity);
    // Hidden until asked for, and the menu is the only way to ask.
    expect(win._sidebar.itemMatches(child)).toBeFalsy();
    const parent = win._sidebar.sessionsById.get(parentId);
    expect(menuLabels(win._sessionMenuModel(parent, { inSidebar: true }))
      .some(l => /Subagent/.test(l))).toBeTruthy();
    win._sidebar.toggleSubagents(parentId);
    expect(win._sidebar.itemMatches(child)).toBeTruthy();
    expect(menuLabels(win._sessionMenuModel(parent, { inSidebar: true }))
      .some(l => /_Hide/.test(l))).toBeTruthy();
    win._sidebar.toggleSubagents(parentId);
    expect(win._sidebar.itemMatches(child)).toBeFalsy();
  });

  it('folds a directory group\'s archived sessions behind one row', () => {
    const items = sidebarItems(win);
    const toggle = items.find(i => i.kind === 'disclosure' && i.disclosure === 'toggle');
    if (!toggle) return; // nothing archived on this server
    const archived = items.find(i => i.archived && i.groupKey === toggle.groupKey);
    expect(win._sidebar.itemMatches(archived)).toBeFalsy();
    win._sidebar._activateDisclosure(toggle);
    expect(win._sidebar.itemMatches(archived)).toBeTruthy();
    win._sidebar._activateDisclosure(toggle);
    expect(win._sidebar.itemMatches(archived)).toBeFalsy();
  });

  it('opens a session on a single click', () => {
    // GtkListBox activated on one click; a list view needs to be told to.
    expect(win._sidebar.listView.get_single_click_activate()).toBeTruthy();
  });

  it('opens a session on activation, not on selection', async () => {
    const target = sessions[1];
    await win._selectSession(sessions[0].id);
    // GtkListBox moves the selection by itself when the list is filtered or
    // rebuilt; only a click or Enter may open a session.
    win._sidebar.selectSession(target.id);
    expect(win._selectedId).toBe(sessions[0].id);
    let position = -1;
    for (let i = 0; i < win._sidebar._filtered.get_n_items(); i++) {
      const item = win._sidebar._filtered.get_item(i);
      if (item.kind !== 'disclosure' && item.session.id === target.id) position = i;
    }
    win._sidebar.listView.emit('activate', position);
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

  it('pages and catches up by turn cursor', async () => {
    let newest = null;
    let target = null;
    for (const s of sessions) {
      newest = await api.getTranscript(s.id, { limit: 3 });
      if (newest.more) { target = s; break; }
    }
    if (!target) return; // nothing long enough on this server
    expect(newest.turns).toHaveLength(3);
    expect(newest.turns.every(turn => turn.cursor)).toBeTruthy();
    const older = await api.getTranscript(target.id, { limit: 3, before: newest.turns[0].cursor });
    expect(older.turns.length > 0).toBeTruthy();
    expect(older.turns.at(-1).cursor === newest.turns[0].cursor).toBeFalsy();
    const caught = await api.getTranscript(target.id, { from: newest.turns[1].cursor });
    expect(caught.turns.map(turn => turn.cursor))
      .toEqual(newest.turns.slice(1).map(turn => turn.cursor));
  });

  it('pages older turns in without losing them on the next refresh', async () => {
    // Three turns a page, so any session with more than that can page.
    const real = api.getTranscript.bind(api);
    api.getTranscript = (id, opts = {}) => real(id, opts.from ? opts : { ...opts, limit: 3 });
    try {
      let target = null;
      for (const s of sessions) {
        if ((await api.getTranscript(s.id)).more) { target = s; break; }
      }
      if (!target) return; // nothing long enough on this server
      await win._selectSession(target.id);
      expect(win._renderedTurns).toHaveLength(3);
      expect(win._hasEarlier).toBeTruthy();
      const newest = win._renderedTurns.map(entry => entry.key);

      await win._loadEarlierMessages();
      expect(win._renderedTurns).toHaveLength(6);
      expect(win._renderedTurns.slice(3).map(entry => entry.key)).toEqual(newest);
      await win._loadTranscript(target.id);
      expect(win._renderedTurns).toHaveLength(6);
      expect(win._transcriptStore.get_n_items()).toBe(6);
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
    win._backendCatalog = { backends: ['claude', 'codex'], models: {}, approvals: {} };
    win._newBackend = 'codex';
    win._syncNewConfig();
    expect(win._newConfig.has_css_class('backend-codex')).toBeTruthy();
    expect(win._newConfig.has_css_class('backend-claude')).toBeFalsy();
    win._newBackend = 'claude';
    win._syncNewConfig();
    expect(win._newConfig.has_css_class('backend-claude')).toBeTruthy();
    expect(win._newConfig.has_css_class('backend-codex')).toBeFalsy();
    win._backendCatalog = null;
  });

  it('pins a size on the settings dialog', async () => {
    // Without one it measures against whatever the first page holds, so a
    // single agent leaves it too small for the form that editing one opens.
    win._showSettings('agents');
    // The dialog waits for its first load before presenting, and _showSettings
    // does not hand back that promise.
    await until('the settings dialog', () => win.get_visible_dialog());
    const dialog = win.get_visible_dialog();
    expect(dialog.get_content_width()).toBeWithin(1, Infinity);
    expect(dialog.get_content_height()).toBeWithin(1, Infinity);
    dialog.close();
  });

  it('shows context usage in the composer, beside send', () => {
    expect(descend(win._composer).includes(win._usage)).toBeTruthy();
    expect(win._usage.get_next_sibling()).toBe(win._send);
  });

  it('shows context usage once the backend reports tokens', () => {
    win._renderRuntime({ model: 'sonnet', effort: 'high', context_tokens: 42000, context_window: 200000 });
    expect(win._usage.get_visible()).toBeTruthy();
    expect(win._usageFraction).toBe(0.21);
    expect(win._usage.get_tooltip_text()).toBe('sonnet, high · Context 21% used');
    expect(win._usageLabel.get_label()).toBe('sonnet · high');
    expect(win._usageLabel.get_visible()).toBeTruthy();
    expect(win._usage.has_css_class('circular')).toBeFalsy();
    expect(labels(win._usageDetail)).toContain('sonnet');
    win._renderRuntime({ context_tokens: 0 });
    expect(win._usage.get_visible()).toBeFalsy();
  });

  it('switches the model and effort from the usage popover', async () => {
    await win._selectSession(sessions[0].id);
    const realCatalog = win._backendCatalog;
    const realPatch = api.patchSession;
    const patched = [];
    api.patchSession = async (id, fields) => {
      patched.push({ id, fields });
      return { ...win._currentSession, runtime: { ...win._runtime, ...fields } };
    };
    try {
      win._currentSession = { ...win._currentSession, backend: 'claude' };
      win._backendCatalog = {
        backends: ['claude'],
        models: { claude: [
          { id: 'opus', display_name: 'Opus', alias: true },
          { id: 'claude-a', display_name: 'A', thinking_levels: ['low', 'high'] },
          { id: 'claude-b', display_name: 'B', thinking_levels: ['high'] },
        ] },
        approvals: { claude: ['ask', 'auto', 'full'] },
      };
      win._runtimeKey = null;
      win._renderRuntime({ model: 'claude-a', effort: 'low' });
      const dropdowns = descend(win._usageDetail).filter(w => w instanceof Gtk.DropDown);
      expect(dropdowns).toHaveLength(2);
      // Aliases are left out; Claude can drop an effort switch.
      expect(dropdowns[0].get_model().get_n_items()).toBe(2);
      expect(dropdowns[1].get_model().get_string(0)).toBe('default');
      dropdowns[0].set_selected(1);
      await until('the model switch', () => patched.length === 1);
      expect(patched[0].fields).toEqual({ model: 'claude-b' });
    } finally {
      api.patchSession = realPatch;
      win._backendCatalog = realCatalog;
      win._runtimeKey = null;
    }
  });

  it('offers the backend\'s approvals and sets the session\'s', async () => {
    win._backendCatalog = null;
    await win._selectSession(sessions[0].id);
    await until('the catalog', () => win._backendCatalog);
    expect(win._approval.get_label()).toBe(`Approve: ${win._currentSession.approval || 'ask'}`);
    const items = menuLabels(win._approval.get_menu_model());
    expect(items.length).toBe(win._backendCatalog.approvals[win._currentSession.backend].length);
    const realPatch = api.patchSession;
    api.patchSession = async (_id, fields) => ({ ...win._currentSession, ...fields });
    try {
      win.activate_action('approval', GLib.Variant.new_string('full'));
      await until('the approval to apply', () => win._currentSession.approval === 'full');
      expect(win._approval.get_label()).toBe('Approve: full');
      expect(win._approval.has_css_class('unattended')).toBeTruthy();
    } finally {
      api.patchSession = realPatch;
      win._currentSession.approval = 'ask';
      win._syncApproval();
    }
  });

  it('starts a new session from the default agent', async () => {
    await win._showNewSession();
    await until('the catalogs to load', () => win._backendCatalog);
    win._defaultAgent = { name: 'default', backend: 'codex', model: 'gpt-5.5', effort: 'high', approval: 'auto' };
    win._backendCatalog = {
      backends: ['claude', 'codex'],
      models: { codex: [{ id: 'gpt-5.5', display_name: 'GPT-5.5', thinking_levels: ['low', 'high'] }] },
      approvals: { claude: ['ask', 'auto', 'full'], codex: ['ask', 'full'] },
    };
    win._useNewDefaults();
    expect([win._newBackend, win._newModel, win._newEffort]).toEqual(['codex', 'gpt-5.5', 'high']);
    // codex here offers no auto, so the pick falls back to asking.
    expect(win._approval.get_label()).toBe('Approve: ask');
    const created = [];
    const realCreate = api.createSession;
    api.createSession = async request => { created.push(request); throw new Error('stubbed'); };
    try {
      win._newCwd.set_text('/tmp');
      await win._createSession('hello');
      expect(created[0]).toEqual({
        initialMessage: 'hello', agent: '', cwd: '/tmp', backend: 'codex',
        model: 'gpt-5.5', effort: 'high',
      });
    } finally {
      api.createSession = realCreate;
      win._backendCatalog = null;
      await win._selectSession(sessions[0].id);
    }
  });

  it('opens the router conversation from the Router entry', async () => {
    const config = await api.getConfig();
    if (!config?.router?.session_id) return; // no router on this server
    win._routerEntry.emit('row-activated', win._routerEntry.get_row_at_index(0));
    await until('the router to open', () => win._selectedId === config.router.session_id &&
      win._chatScroll.get_visible());
    expect(win._title.get_title()).toBe('Router');
    expect(win._routerEntry.get_selected_row()).toBeTruthy();
    // No fork from the router: a branch of it would not be one.
    expect(descend(win._messages).some(w => w.has_css_class?.('turn-fork'))).toBeFalsy();
    const targets = [...win._routedTargets];
    if (!targets.length) return; // it has routed nothing yet
    // The focus is the session it handed work to last; the approval control
    // is that session's.
    expect(win._focusButton.get_visible()).toBeTruthy();
    expect(targets).toContain(win._routerFocus);
    expect(win._approval.get_visible()).toBeTruthy();
    expect(win._approvalTarget().id).toBe(win._routerFocus);
    await until('the replies to be placed', () => {
      for (let i = 0; i < win._transcriptStore.get_n_items(); i++) {
        if (win._transcriptStore.get_item(i).routed?.length) return true;
      }
      return false;
    });
    expect(descend(win._messages).some(w => w.has_css_class?.('routed-reply'))).toBeTruthy();
    expect(descend(win._messages).some(w => w.has_css_class?.('routed-part'))).toBeTruthy();
  });

  it('answers a routed session\'s permission from the router, naming it', async () => {
    if (!win._currentSession?.router || !win._routedTargets.size) return;
    const target = [...win._routedTargets][0];
    const realPending = win._pendingInteractions;
    try {
      win._interactionKey = null;
      win._updateInteractions([{ id: 'routed-p', session_id: target, kind: 'permission', tool_input: {} }]);
      expect(labels(win._permissionBox).some(l => l.startsWith('From '))).toBeTruthy();
    } finally {
      win._interactionKey = null;
      win._updateInteractions(realPending);
    }
  });

  it('starts a new router conversation on a chosen backend and model', async () => {
    await win._showRouter(true);
    await until('the backends', () => win._backendCatalog);
    expect(win._newMode).toBeTruthy();
    expect(win._newKind).toBe('router');
    expect(win._newBar.get_visible()).toBeFalsy();
    expect(win._upload.get_visible()).toBeFalsy();
    expect(win._approval.get_visible()).toBeFalsy();
    expect(win._routerEntry.get_selected_row()).toBeTruthy();
    const started = [];
    const realStart = api.startRouter;
    api.startRouter = async request => { started.push(request); throw new Error('stubbed'); };
    try {
      win._prompt.get_buffer().set_text('route this', -1);
      await win._sendMessage();
      expect(started[0].initialMessage).toBe('route this');
      expect(started[0].backend).toBe(win._newBackend);
      expect(started[0].model).toBe(win._newModel);
    } finally {
      api.startRouter = realStart;
      await win._selectSession(sessions[0].id);
    }
    expect(win._routerEntry.get_selected_row()).toBeFalsy();
    expect(win._upload.get_visible()).toBeTruthy();
  });

  it('groups the sidebar from the main menu', () => {
    win.activate_action('group-by', GLib.Variant.new_string('date'));
    expect(win._sidebar.groupByDate).toBeTruthy();
    expect(win.lookup_action('group-by').get_state().get_string()[0]).toBe('date');
    win.activate_action('group-by', GLib.Variant.new_string('folder'));
    expect(win._sidebar.groupByDate).toBeFalsy();
  });

  it('names the server, not the last session, when nothing is open', async () => {
    await win._selectSession(sessions[0].id);
    win._clearSessionSelection();
    expect(win._title.get_title()).toBe('usher');
    expect(win._emptyAction.get_visible()).toBeTruthy();
    await win._showNewSession();
    expect(win._emptyAction.get_visible()).toBeFalsy();
    await win._selectSession(sessions[0].id);
  });

  it('moves md/raw into the session menu when narrow', async () => {
    await win._selectSession(sessions[0].id);
    win._narrow = true;
    try {
      const labels = menuLabels(win._sessionMenuModel(win._currentSession));
      expect(labels).toContain('Ra_w Text');
      win.activate_action('render-mode', GLib.Variant.new_string('raw'));
      expect(win._renderMode.get_active_name()).toBe('raw');
      win.activate_action('render-mode', GLib.Variant.new_string('md'));
    } finally {
      win._narrow = false;
    }
    expect(menuLabels(win._sessionMenuModel(win._currentSession)).includes('Ra_w Text')).toBeFalsy();
  });

  it('groups the sidebar by date, naming each row\'s directory', () => {
    try {
      win._sidebar.setGroupByDate(true);
      const rows = sidebarItems(win).filter(i => i.kind === 'session' && !i.session.pinned);
      const buckets = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];
      const routerDir = win._routerDir;
      for (const row of rows) {
        if (routerDir && row.session.cwd === routerDir) {
          // The router's directory stays a group of its own.
          expect(row.sectionLabel).toBe(routerDir);
        } else {
          expect(buckets).toContain(row.sectionLabel);
          expect(row.cwdName).toBe(row.session.cwd.split('/').pop());
        }
      }
    } finally {
      win._sidebar.setGroupByDate(false);
    }
    expect(sidebarItems(win).every(i => !i.cwdName)).toBeTruthy();
  });

  it('links a session id in a message to that session', async () => {
    const target = sessions[1];
    await win._selectSession(sessions[0].id);
    const body = markdown.render(`Done in ${target.id.slice(0, 8)}, not in deadbeef.`);
    const label = descend(body).find(w => w instanceof Gtk.Label);
    expect(label.get_label()).toContain(`usher-session:${target.id}`);
    expect(label.get_label()).toContain('deadbeef.');
    expect(label.get_label().includes('usher-session:deadbeef')).toBeFalsy();
    label.emit('activate-link', `usher-session:${target.id}`);
    await until('the linked session to open', () => win._selectedId === target.id);
  });

  it('draws a closed mermaid fence and leaves an open one as code', async () => {
    await diagram.preload();
    const drawn = markdown.render('```mermaid\nflowchart LR\n  A[Start] --> B[End]\n```\n');
    const picture = descend(drawn).find(w => w instanceof Gtk.Picture);
    expect(picture?.get_paintable()).toBeTruthy();
    const streaming = markdown.render('```mermaid\nflowchart LR\n  A --> B\n');
    expect(descend(streaming).some(w => w instanceof Gtk.Picture)).toBeFalsy();
    const broken = markdown.render('```mermaid\nnot a diagram at all\n```\n');
    expect(descend(broken).some(w => w instanceof Gtk.Picture)).toBeFalsy();
  });

  it('notifies from the event stream like the server\'s push, not for the open session', () => {
    const app = win.get_application();
    const sent = [];
    const withdrawn = [];
    const realSend = app.send_notification;
    const realWithdraw = app.withdraw_notification;
    app.send_notification = id => sent.push(id);
    app.withdraw_notification = id => withdrawn.push(id);
    const realSelected = win._selectedId;
    try {
      win._selectedId = sessions[0].id;
      win._knownInteractions = new Set(['old']);
      win._notifiedInteractions = new Set();
      const pending = (id, sid) => ({ id, session_id: sid, kind: 'permission', tool_name: 'Bash' });
      // Replayed on connect, and already pending before: not news.
      win._onNotificationEvent('interaction.pending', pending('old', sessions[1].id), {});
      win._onNotificationEvent('interaction.pending', pending('new', sessions[1].id), {});
      win._onNotificationEvent('interaction.pending', pending('new', sessions[1].id), {});
      win._onNotificationEvent('interaction.pending', pending('here', sessions[0].id), {});
      expect(sent).toEqual(['perm-new']);
      win._onNotificationEvent('turn.ended', {}, { session_id: sessions[1].id });
      win._onNotificationEvent('turn.ended', {}, { session_id: sessions[0].id });
      expect(sent).toEqual(['perm-new', `turn-${sessions[1].id}`]);
      win._withdrawAnswered([]);
      expect(withdrawn).toEqual(['perm-new']);
    } finally {
      app.send_notification = realSend;
      app.withdraw_notification = realWithdraw;
      win._selectedId = realSelected;
    }
  });

  it('subscribes to the notification events once connected', () => {
    expect(win._notificationStream).toBeTruthy();
    expect(win._notificationStream._url).toContain('/api/v1/events?types=turn.ended,interaction.pending');
  });

  it('reopens the session that was open last on this server', async () => {
    await win._selectSession(sessions[1].id);
    win._clearSessionSelection();
    win._rememberSession(sessions[1].id);
    win._restoreLastSession();
    await until('the last session to reopen', () => win._selectedId === sessions[1].id);
  });

  it('matches every search word and opens the first match on Enter', async () => {
    const target = sessions[1];
    const words = (target.title || '').split(/\s+/).filter(w => w.length > 1).slice(0, 2);
    if (!words.length) return;
    try {
      win._search.set_text(words.join(' ').toLowerCase());
      await until('the filter', () => win._sidebar.firstMatch() !== null);
      win._search.set_text(`${words[0].toLowerCase()} zzzz-no-such-word`);
      await until('no match', () => win._sidebar.firstMatch() === null);
      win._search.set_text(target.title.toLowerCase());
      await until('the target first', () => win._sidebar.firstMatch() === target.id);
      win._search.emit('activate');
      await until('the session to open', () => win._selectedId === target.id);
    } finally {
      win._search.set_text('');
    }
  });

  it('names the server in the sidebar header and lists the others', () => {
    win._syncServerSwitcher();
    const labels = menuLabels(win._serverSwitcher.get_menu_model());
    expect(labels).toContain('_Manage Servers…');
  });

  it('lists Details among the session actions', () => {
    expect(menuLabels(win._sessionMenuModel(sessions[0]))).toContain('De_tails…');
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

  it('answers "always allow" with the always scope', () => {
    answered.length = 0;
    const card = cards.permissionWidget(
      { id: 'p9', kind: 'permission', tool_input: {}, allow_always: true }, 1);
    buttonLabelled(card, 'Always allow').emit('clicked');
    expect(answered[0].payload.scope).toBe('always');
  });

  it('shows a permission\'s preview and reason instead of its raw input', () => {
    const card = cards.permissionWidget({
      id: 'p', kind: 'permission', tool_name: 'Bash', tool_input: { command: 'ls -la' },
      reason: 'Needs a listing',
      preview: { type: 'tool', tool_name: 'Bash', tool_target: 'List files', tool_input: 'ls -la' },
    }, 1);
    const shown = labels(card);
    expect(shown).toContain('List files');
    expect(shown).toContain('Needs a listing');
    expect(shown).toContain('ls -la');
    expect(shown.some(l => l.includes('"command"'))).toBeFalsy();
  });

  it('asks to leave plan mode with the plan shown', () => {
    answered.length = 0;
    const card = cards.permissionWidget({
      id: 'plan1', kind: 'plan', preview: { type: 'tool', content: 'Step one' },
    }, 1);
    expect(labels(card)[0]).toBe('Plan');
    buttonLabelled(card, 'Keep Planning').emit('clicked');
    expect(answered[0].payload.behavior).toBe('deny');
    expect(answered[0].payload.reason).toBe('The user wants to keep planning.');
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
