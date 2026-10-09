import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { ApiClient } from './api-client.js';
import { isSandboxed } from './backend-process.js';
import { EventStream } from './event-stream.js';
import { deriveAuthCookie } from './local-auth.js';
import { DEFAULT_EMBEDDED_PORT, ServerStore } from './server-store.js';
import { InteractionCards } from './interaction.js';
import { Sidebar } from './sidebar.js';
import { BACKENDS } from './style.js';
import { clearPassword, lookupPassword, storePassword } from './keyring.js';
import { showSettingsDialog } from './settings.js';
import { ellipsize } from './text.js';
import { TranscriptView } from './transcript.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');

// Inline transcript images are capped to this box; clicking one opens it full
// size. Both are logical pixels, scaled down only (never up).
// One page of transcript history, matching the web client's window size.
const TRANSCRIPT_PAGE = 100;

// What an upload drops into the message box. An image goes in as markdown so
// the transcript renders it inline; the extensions are the ones /image will
// serve. A path with a space needs the <...> destination form.
export function fileRef(path) {
  if (!/\.(?:png|jpe?g|gif|webp)$/i.test(path)) return `[file: ${path}]`;
  const alt = path.split('/').pop().replace(/[[\]]/g, '');
  const dest = /\s/.test(path) ? `<${path}>` : path;
  return `![${alt}](${dest})`;
}

// A session whose worker is attached and can be paused.
const isBusy = session => session.status === 'live' || session.status === 'running' ||
  session.status === 'awaiting_permission';


const TranscriptItem = GObject.registerClass(
class TranscriptItem extends GObject.Object {
  _init(turn, key = '') {
    super._init();
    this.turn = turn;
    this.key = key;
    // Built on first bind and kept: GtkListView rebinds a row every time it
    // scrolls back into view, and building a turn costs a markdown parse. Any
    // change to a turn replaces its item, so the cache cannot go stale.
    this.widget = null;
  }
});

export const UsherWindow = GObject.registerClass(
class UsherWindow extends Adw.ApplicationWindow {
  _init(params) {
    const backend = params.backend;
    delete params.backend;
    super._init({ ...params, title: 'usher', default_width: 1100, default_height: 760 });
    this._backend = backend;
    this._servers = new ServerStore();
    const environmentServer = GLib.getenv('USHER_BASE_URL') || GLib.getenv('USHER_BACKEND')
      ? {
          id: '',
          name: 'Environment',
          url: GLib.getenv('USHER_BASE_URL') || '',
          binaryPath: GLib.getenv('USHER_BACKEND') || '',
        }
      : null;
    this._currentServer = environmentServer || this._servers.active;
    this._backend.configure(this._currentServer || {});
    this._api = new ApiClient(backend.baseUrl);
    this._selectedId = null;
    this._hasEarlier = false;
    this._loadingEarlier = false;
    this._eventStream = null;
    this._started = false;
    this._liveTurn = null;
    this._selectionEpoch = 0;
    this._turnRunning = false;
    this._sendInFlight = false;
    this._streamDisconnected = false;
    this._renderedTurns = [];
    this._scrollPending = false;
    this._connectionEpoch = 0;
    this._pendingInteractions = [];
    this._interactionKey = null;
    this._pollBusy = false;
    this._previewRefreshId = 0;
    this._editorURL = '';
    this._commands = [];
    this._commandSource = '';
    this._newMode = false;
    this._newAgent = '';
    this._newBackend = '';
    this._newModel = '';
    this._modelCatalog = null;
    this._agentProfiles = [];
    this._drafts = new Map();
    this._unread = new Set();
    this._previousStatus = new Map();
    this._rawMarkdown = false;
    this._optimisticTurn = null;

    this._sidebar = new Sidebar({
      selectedId: () => this._selectedId,
      searchQuery: () => this._search?.get_text().trim().toLowerCase() || '',
      onSelect: id => this._selectSession(id),
      interactionCount: id =>
        this._pendingInteractions.filter(p => p.session_id === id).length,
      isUnread: id => this._unread.has(id),
      onContextMenu: (session, row, x, y) => this._showRowMenu(session, row, x, y),
    });
    this._interactions = new InteractionCards({
      respond: (id, payload, buttons) => this._respondInteraction(id, payload, buttons),
    });
    this._transcript = new TranscriptView({
      window: this,
      api: this._api,
      sessionId: () => this._selectedId,
      backendName: () => this._currentSession?.backend || '',
      rawMarkdown: () => this._rawMarkdown,
      onFork: uuid => this._forkTurn(uuid),
      onImageLoaded: () => this._scrollToBottom(),
    });

    this._buildUi();

    // Only a backend this app owns reports its lifetime here.
    this._backend.onState = (state, detail) => this._onBackendState(state, detail);

    // Interactions (permission requests / questions) have no SSE channel;
    // the server expects clients to poll, like the web UI does. The same
    // tick keeps the session sidebar fresh (new sessions, status icons).
    this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      this._pollTick();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _installWindowActions() {
    const add = (name, callback) => {
      const action = new Gio.SimpleAction({ name });
      action.connect('activate', callback);
      this.add_action(action);
      return action;
    };
    add('settings', (_action, parameter) => this._showSettings(parameter?.get_string()[0]));
    add('servers', () => this._showConnectionDialog());

    // Per-session actions. Both menus that offer them — the sidebar's context
    // menu and the header's — name the session by setting _menuSession before
    // they open, so the actions themselves stay parameterless.
    const onSession = (name, callback) => add(name, () => {
      if (this._menuSession) callback(this._menuSession);
    });
    // toggleSubagents re-runs the filter itself; the rows already exist.
    onSession('session-subagents', session => this._sidebar.toggleSubagents(session.id));
    onSession('session-rename', session => this._showRenameDialog(session));
    onSession('session-pin', session => this._runSessionAction(
      () => this._api.setPinned(session.id, !session.pinned),
      session.pinned ? 'Session unpinned' : 'Session pinned'
    ));
    onSession('session-archive', session => this._runSessionAction(
      () => this._api.setArchived(session.id, !session.archived),
      session.archived ? 'Session restored' : 'Session archived'
    ));
    onSession('session-worker', session => (isBusy(session)
      ? this._runSessionAction(
        () => this._api.pauseSession(session.id), 'Session worker paused')
      // Wakes the backend without adding a turn — useful before steering a
      // session that has gone idle.
      : this._runSessionAction(
        () => this._api.resumeSession(session.id), 'Session worker resumed')));
    onSession('session-editor', session => this._openInEditor(session.cwd));
    onSession('session-delete', session => this._showDeleteDialog(session));

    // Reading the message as the model wrote it, markup and all.
    const render = new Gio.SimpleAction({
      name: 'render-mode',
      parameter_type: GLib.VariantType.new('s'),
      state: GLib.Variant.new_string('md'),
    });
    render.connect('activate', (action, parameter) => {
      const mode = parameter.get_string()[0];
      action.set_state(GLib.Variant.new_string(mode));
      this._rawMarkdown = mode === 'raw';
      this._rerenderTranscript();
    });
    this.add_action(render);

    // Radio state for the new-session config menu.
    const choice = (name, apply) => {
      const action = new Gio.SimpleAction({
        name,
        parameter_type: GLib.VariantType.new('s'),
        state: GLib.Variant.new_string(''),
      });
      action.connect('activate', (_action, parameter) => {
        apply(parameter.get_string()[0]);
      });
      this.add_action(action);
    };
    choice('new-agent', value => this._applyNewAgent(value));
    choice('new-backend', value => {
      this._newBackend = value;
      this._newModel = ''; // the previous model belongs to the previous backend
      this._newAgent = '';
      this._syncNewConfig();
    });
    choice('new-model', value => {
      this._newModel = value;
      this._syncNewConfig();
    });
  }

  _showSettings(page = '') {
    showSettingsDialog(this, {
      api: this._api,
      page,
      toast: message => this._showToast(message),
      // The working directories already on screen are the ones worth
      // suggesting in the agent and task forms.
      recentCwds: [...new Set(
        [...(this._sidebar.sessionsById?.values() || [])].map(s => s.cwd).filter(Boolean)
      )].sort(),
      onSessionStarted: id => this._selectSession(id).catch(() => {}),
    }).catch(error => this._showToast(error.message || String(error)));
  }

  async _pollTick() {
    if (!this._started || this._pollBusy) return;
    this._pollBusy = true;
    const epoch = this._connectionEpoch;
    try {
      const interactions = await this._api.listInteractions();
      if (this._connectionEpoch !== epoch || !this._started) return;
      this._updateInteractions(interactions || []);
      const sessions = await this._api.listSessions();
      if (this._connectionEpoch !== epoch || !this._started) return;
      this._renderSessions(sessions || []);
    } catch (_) {
      // Transient poll failure; the SSE indicator reports connectivity.
    } finally {
      this._pollBusy = false;
    }
  }

  _buildUi() {
    const contentToolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar();
    this._title = new Adw.WindowTitle({ title: 'usher', subtitle: 'Connecting…' });
    header.set_title_widget(this._title);

    const sidebarToggle = new Gtk.ToggleButton({
      icon_name: 'sidebar-show-symbolic',
      tooltip_text: 'Toggle session list',
    });
    header.pack_start(sidebarToggle);
    const refresh = new Gtk.Button({ icon_name: 'view-refresh-symbolic', tooltip_text: 'Refresh' });
    refresh.set_action_name('app.refresh');
    header.pack_start(refresh);
    this._connectionStatus = new Gtk.Image({
      icon_name: 'network-offline-symbolic',
      tooltip_text: 'Live updates disconnected; reconnecting…',
      visible: false,
    });
    this._connectionStatus.add_css_class('warning');
    header.pack_end(this._connectionStatus);
    this._sessionMenu = new Gtk.MenuButton({
      icon_name: 'view-more-symbolic',
      tooltip_text: 'Session actions',
      visible: false,
    });
    // The sidebar's context menu leaves _menuSession pointing at the row it
    // was opened on; the header menu always acts on the selected session.
    this._sessionMenu.connect('notify::active', button => {
      if (button.get_active()) this._menuSession = this._selectedSession();
    });
    header.pack_end(this._sessionMenu);
    // How a message is rendered is a standing choice, so it stays visible and
    // says which mode is on — as in the web header — rather than hiding in the
    // primary menu. AdwToggleGroup is the platform's segmented control; it
    // carries the linked shape, the sizing and the radio behaviour.
    const renderMode = new Adw.ToggleGroup({ valign: Gtk.Align.CENTER });
    renderMode.add_css_class('render-mode');
    renderMode.add(new Adw.Toggle({
      name: 'md', label: 'md', tooltip: 'Render markdown',
    }));
    renderMode.add(new Adw.Toggle({
      name: 'raw', label: 'raw', tooltip: 'Show the message as the model wrote it',
    }));
    // AdwToggleGroup is not GtkActionable, so the group drives the action by
    // hand; the action stays the one place the mode lives.
    renderMode.set_active_name('md');
    renderMode.connect('notify::active-name', group => {
      const mode = group.get_active_name();
      if (mode) this.activate_action('render-mode', GLib.Variant.new_string(mode));
    });
    header.pack_end(renderMode);
    contentToolbar.add_top_bar(header);

    const sidebarBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    sidebarBox.set_size_request(300, -1);
    this._search = new Gtk.SearchEntry({ placeholder_text: 'Search sessions' });
    this._search.connect('search-changed', () => this._sidebar.refilter());
    const searchBar = new Gtk.SearchBar({ child: this._search });
    searchBar.set_key_capture_widget(this);
    sidebarBox.append(searchBar);

    const sidebarToolbar = new Adw.ToolbarView();
    const sidebarHeader = new Adw.HeaderBar();
    sidebarHeader.set_title_widget(new Adw.WindowTitle({ title: 'Sessions' }));
    const searchToggle = new Gtk.ToggleButton({
      icon_name: 'system-search-symbolic',
      tooltip_text: 'Search sessions',
    });
    searchToggle.bind_property(
      'active', searchBar, 'search-mode-enabled',
      GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE
    );
    sidebarHeader.pack_end(searchToggle);
    // Primary menu: app-scoped destinations, per the HIG. Session-scoped
    // actions stay in the conversation header's own menu.
    const primaryMenu = new Gio.Menu();
    const appSection = new Gio.Menu();
    // Server profiles are client-local and switching one changes what
    // Settings shows, so the two stay separate entries.
    appSection.append('_Servers…', 'win.servers');
    appSection.append('_Settings', 'win.settings');
    primaryMenu.append_section(null, appSection);
    sidebarHeader.pack_end(new Gtk.MenuButton({
      icon_name: 'open-menu-symbolic',
      tooltip_text: 'Main menu',
      menu_model: primaryMenu,
      primary: true,
    }));
    const newSession = new Gtk.Button({
      icon_name: 'list-add-symbolic',
      tooltip_text: 'New session',
    });
    newSession.connect('clicked', () => this._showNewSession());
    sidebarHeader.pack_start(newSession);
    sidebarToolbar.add_top_bar(sidebarHeader);
    this._installWindowActions();

    sidebarBox.append(this._sidebar.widget);
    sidebarToolbar.set_content(sidebarBox);

    const content = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      hexpand: true,
      vexpand: true,
    });
    this._status = new Adw.StatusPage({
      icon_name: 'utilities-terminal-symbolic',
      title: 'Select a session',
      description: 'Choose a conversation from the sidebar.',
    });
    content.append(this._status);

    this._loadEarlier = new Gtk.Button({
      label: 'Load earlier messages',
      halign: Gtk.Align.CENTER,
      visible: false,
    });
    this._loadEarlier.add_css_class('flat');
    this._loadEarlier.add_css_class('caption');
    this._loadEarlier.set_margin_top(4);
    this._loadEarlier.set_margin_bottom(4);
    this._loadEarlier.connect('clicked', () => this._loadEarlierMessages());
    content.append(this._loadEarlier);

    this._chatScroll = new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      hexpand: true,
      vexpand: true,
      visible: false,
    });
    this._transcriptStore = new Gio.ListStore({ item_type: TranscriptItem });
    const transcriptSelection = new Gtk.NoSelection({ model: this._transcriptStore });
    const transcriptFactory = new Gtk.SignalListItemFactory();
    transcriptFactory.connect('bind', (_factory, listItem) => {
      listItem.set_activatable(false);
      listItem.set_selectable(false);
      const item = listItem.get_item();
      if (!item.widget) item.widget = this._transcript.turnWidget(item.turn);
      listItem.set_child(item.widget);
    });
    transcriptFactory.connect('unbind', (_factory, listItem) => listItem.set_child(null));
    this._messages = new Gtk.ListView({
      model: transcriptSelection,
      factory: transcriptFactory,
      single_click_activate: false,
      hexpand: true,
      vexpand: true,
    });
    this._messages.add_css_class('transcript-list');
    this._messages.set_margin_top(12);
    this._messages.set_margin_bottom(12);
    this._messages.set_margin_start(12);
    this._messages.set_margin_end(12);
    this._chatScroll.set_child(this._messages);
    const adjustment = this._chatScroll.get_vadjustment();
    adjustment.connect('notify::upper', () => {
      if (this._scrollPending) this._applyScrollToBottom();
    });
    content.append(this._chatScroll);

    const composer = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 8,
      hexpand: true,
    });
    composer.set_margin_top(8);
    composer.set_margin_bottom(8);
    composer.set_margin_start(16);
    composer.set_margin_end(16);
    this._permissionBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 6,
      visible: false,
    });
    composer.append(this._permissionBox);
    // Only the new-session view shows this: the working directory is the one
    // thing a session needs that a message cannot carry.
    this._newBar = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      visible: false,
    });
    const cwdLabel = new Gtk.Label({ label: 'Directory' });
    cwdLabel.add_css_class('dim-label');
    cwdLabel.add_css_class('caption');
    this._newBar.append(cwdLabel);
    this._newCwd = new Gtk.Entry({
      placeholder_text: '/absolute/path/to/project',
      hexpand: true,
    });
    this._newBar.append(this._newCwd);
    this._newCwdSuggestions = new Gtk.MenuButton({
      icon_name: 'view-list-symbolic',
      tooltip_text: 'Recent working directories',
      valign: Gtk.Align.CENTER,
    });
    this._newCwdSuggestions.add_css_class('flat');
    this._newBar.append(this._newCwdSuggestions);
    composer.append(this._newBar);
    this._prompt = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, accepts_tab: false });
    this._prompt.set_hexpand(true);
    this._prompt.set_top_margin(8);
    this._prompt.set_bottom_margin(8);
    this._prompt.set_left_margin(8);
    this._prompt.set_right_margin(8);
    this._prompt.set_size_request(-1, 72);
    const promptScroll = new Gtk.ScrolledWindow({
      child: this._prompt,
      hexpand: true,
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      min_content_height: 72,
      max_content_height: 160,
      propagate_natural_width: false,
      propagate_natural_height: true,
    });
    const promptFrame = new Gtk.Frame({ hexpand: true, child: promptScroll });
    promptFrame.add_css_class('composer-frame');
    this._promptPlaceholder = new Gtk.Label({
      label: 'Write a message — Ctrl+Enter to send',
      xalign: 0,
      halign: Gtk.Align.START,
      valign: Gtk.Align.START,
      margin_top: 9,
      margin_start: 9,
      can_target: false,
    });
    this._promptPlaceholder.add_css_class('dim-label');
    const promptOverlay = new Gtk.Overlay({ child: promptFrame, hexpand: true });
    promptOverlay.add_overlay(this._promptPlaceholder);
    const promptBuffer = this._prompt.get_buffer();
    promptBuffer.connect('changed', () => {
      this._promptPlaceholder.set_visible(promptBuffer.get_char_count() === 0);
      this._updateCommandPopup();
    });
    this._buildCommandPopup();
    composer.append(promptOverlay);
    const composerBar = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      hexpand: true,
    });
    this._upload = new Gtk.Button({
      icon_name: 'mail-attachment-symbolic',
      tooltip_text: 'Attach a file to this session',
    });
    this._upload.add_css_class('flat');
    this._upload.connect('clicked', () => this._chooseUpload());
    composerBar.append(this._upload);
    this._autoApprove = new Gtk.ToggleButton({
      label: 'Approve: ask',
      tooltip_text: 'Ask before tool calls; enable to approve automatically',
    });
    this._autoApprove.add_css_class('flat');
    this._autoApprove.add_css_class('approve-toggle');
    this._autoApprove.connect('toggled', () => this._toggleAutoApprove());
    composerBar.append(this._autoApprove);
    // Agent / backend / model for a session that does not exist yet.
    this._newConfig = new Gtk.MenuButton({
      visible: false,
      tooltip_text: 'Agent, backend, and model for the new session',
    });
    this._newConfig.add_css_class('flat');
    composerBar.append(this._newConfig);
    const sendBox = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END, hexpand: true });
    // Context usage belongs beside send: it says how full the window the next
    // message goes into is, which is a fact about composing, not about the
    // conversation's identity.
    this._usage = new Gtk.MenuButton({
      visible: false,
      tooltip_text: 'Context usage',
      valign: Gtk.Align.CENTER,
    });
    this._usage.add_css_class('flat');
    this._usage.add_css_class('circular');
    // A ring rather than a percentage, as in the web composer: the number is
    // in the popover, and the arc is what gets read at a glance.
    this._usageFraction = 0;
    // content-width is a minimum, so without the alignment the area stretches
    // to fill the button and the ring is drawn at the button's size.
    this._usageRing = new Gtk.DrawingArea({
      content_width: 22,
      content_height: 22,
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
    });
    this._usageRing.set_draw_func((area, cr, width, height) => {
      const stroke = 3;
      const radius = (Math.min(width, height) - stroke) / 2;
      const track = area.get_color();
      const accent = Adw.StyleManager.get_default().get_accent_color_rgba();
      cr.setLineWidth(stroke);
      cr.setSourceRGBA(track.red, track.green, track.blue, track.alpha * 0.25);
      cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
      cr.stroke();
      if (this._usageFraction > 0) {
        const start = -Math.PI / 2;
        cr.setSourceRGBA(accent.red, accent.green, accent.blue, accent.alpha);
        cr.arc(width / 2, height / 2, radius, start,
          start + 2 * Math.PI * this._usageFraction);
        cr.stroke();
      }
      // GJS hands out a Cairo context that has to be released by hand.
      cr.$dispose();
    });
    this._usage.set_child(this._usageRing);
    this._usageDetail = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 6,
      margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
    });
    this._usage.set_popover(new Gtk.Popover({ child: this._usageDetail }));
    sendBox.append(this._usage);
    this._send = new Gtk.Button({
      icon_name: 'io.github.nexustar.Usher-send-symbolic',
      tooltip_text: 'Send message',
    });
    this._send.add_css_class('suggested-action');
    this._send.add_css_class('circular');
    this._send.connect('clicked', () => this._sendMessage());
    sendBox.append(this._send);
    this._cancel = new Gtk.Button({
      icon_name: 'media-playback-stop-symbolic',
      tooltip_text: 'Cancel current turn',
      visible: false,
    });
    this._cancel.add_css_class('destructive-action');
    this._cancel.add_css_class('circular');
    this._cancel.connect('clicked', () => this._cancelTurn());
    sendBox.append(this._cancel);
    composerBar.append(sendBox);
    composer.append(composerBar);
    const promptKeys = new Gtk.EventControllerKey();
    promptKeys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
      if (keyval === Gdk.KEY_Return && (state & Gdk.ModifierType.CONTROL_MASK)) {
        this._sendMessage();
        return true;
      }
      return this._handleCommandKey(keyval);
    });
    this._prompt.add_controller(promptKeys);
    this._watchDraft();
    // The composer lives in the ToolbarView's bottom bar so it gets native
    // toolbar styling (background + separator) instead of floating in the
    // content area. Visibility is toggled on the clamp.
    const composerClamp = new Adw.Clamp({
      child: composer,
      maximum_size: 900,
      tightening_threshold: 700,
      visible: false,
    });
    this._composer = composerClamp;
    contentToolbar.add_bottom_bar(composerClamp);
    contentToolbar.set_bottom_bar_style(Adw.ToolbarStyle.RAISED);
    contentToolbar.set_content(content);

    // An overlay split view (not a navigation one): on narrow windows the
    // session list stays a sidebar sliding over the conversation, toggled
    // from the header, instead of turning into a back-navigation page.
    this._splitView = new Adw.OverlaySplitView({
      sidebar: sidebarToolbar,
      content: contentToolbar,
      min_sidebar_width: 250,
      max_sidebar_width: 380,
      sidebar_width_fraction: 0.3,
    });
    this._splitView.bind_property(
      'show-sidebar', sidebarToggle, 'active',
      GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE
    );
    const breakpoint = new Adw.Breakpoint({
      condition: Adw.BreakpointCondition.parse('max-width: 700sp'),
    });
    breakpoint.add_setter(this._splitView, 'collapsed', true);
    this.add_breakpoint(breakpoint);

    this._toastOverlay = new Adw.ToastOverlay({ child: this._splitView });
    this.set_content(this._toastOverlay);
  }

  async start() {
    if (this._started) return;
    if (!this._currentServer) {
      this._showError('No usher server configured', new Error(
        isSandboxed()
          ? 'Run usher on this machine, then add its address as a server.'
          : 'Add a remote server URL or configure a local usher binary.'
      ));
      this._showConnectionDialog();
      return;
    }
    this._started = true;
    try {
      await this._backend.ensureRunning();
      this._authenticateOwnBackend();
      this._title.set_subtitle(this._backend.baseUrl);
      const sessions = await this._api.listSessions();
      this._renderSessions(sessions || []);
      this._loadServerConfig();
    } catch (error) {
      this._showError('Could not connect to usher', error);
      this._started = false;
      // A saved connection remains selected even when it is temporarily
      // unavailable. Do not interrupt startup with a modal; the server button
      // remains available for editing or switching it explicitly.
    }
  }

  _onBackendState(state, detail) {
    if (state === 'restarting') {
      this._showToast('usher stopped unexpectedly — restarting it');
      this._backendDetail = detail;
      return;
    }
    if (state === 'running') {
      this._showToast('usher restarted');
      this._backendDetail = '';
      this.refresh().catch(() => {});
      return;
    }
    // Failed for good: polling and the event stream will fail from here on,
    // and their indicator says only "disconnected".
    this._backendDetail = detail;
    this._showError('The local usher backend stopped',
      new Error(detail || 'It exited repeatedly and was not restarted.'));
  }

  // A backend we spawned shares this account's data directory, so its cookie
  // can be derived from disk. One that was merely already listening need not —
  // its data directory may be another one — so it authenticates like any
  // other server.
  _authenticateOwnBackend() {
    if (!this._backend.startedHere) return;
    const cookie = deriveAuthCookie();
    if (cookie) this._api.setAuthCookie(cookie);
  }

  // editor_url is optional server configuration; without it the session menu
  // simply omits the editor entry.
  async _loadServerConfig() {
    const epoch = this._connectionEpoch;
    try {
      const config = await this._api.getConfig();
      if (this._connectionEpoch !== epoch) return;
      this._editorURL = config?.editor_url || '';
    } catch (_) {
      this._editorURL = '';
    }
  }

  async refresh() {
    try {
      const sessions = await this._api.listSessions();
      this._renderSessions(sessions || []);
      if (this._selectedId) await this._loadTranscript(this._selectedId);
    } catch (error) {
      this._showToast(error.message || String(error));
    }
  }

  // Pinning, archiving and the rest change the list, never the conversation.
  // Reloading the transcript for them costs a fetch and a rebuild of every
  // turn, which is what made those buttons feel slow.
  async refreshSessions() {
    try {
      this._renderSessions(await this._api.listSessions() || []);
    } catch (error) {
      this._showToast(error.message || String(error));
    }
  }

  // A session that finished answering while it was not on screen stays unread
  // until it is opened. The first poll has no previous status, so a fresh
  // start marks nothing.
  _reconcileUnread(sessions) {
    for (const session of sessions) {
      const previous = this._previousStatus.get(session.id);
      if (session.id === this._selectedId || session.status === 'running' ||
          session.archived) {
        this._unread.delete(session.id);
      } else if (previous === 'running') {
        this._unread.add(session.id);
      }
      this._previousStatus.set(session.id, session.status);
    }
  }

  _renderSessions(sessions) {
    this._reconcileUnread(sessions);
    this._sidebar.render(sessions);
    const selected = this._selectedId && this._sidebar.selectSession(this._selectedId);
    if (!selected && this._selectedId) {
      this._selectionEpoch++;
      this._selectedId = null;
      this._eventStream?.stop();
      this._status.set_title('Select a session');
      this._status.set_description('Choose a conversation from the sidebar.');
      this._status.set_visible(true);
      this._chatScroll.set_visible(false);
      this._loadEarlier.set_visible(false);
      this._composer.set_visible(false);
    }
    this._syncSessionMenu();
  }

  // Per-session actions on secondary click, the way a list of items is
  // expected to behave. The same menu is on the conversation header, which is
  // how these actions stay reachable from the keyboard.
  // One popover moved between rows, not one per click: showing a popover
  // gives it its own surface and renderer, and those do not come back when it
  // is dropped. Fractal's sidebar shares a single row menu for the same
  // reason.
  _showRowMenu(session, row, x, y) {
    this._menuSession = session;
    if (!this._rowMenu) {
      this._rowMenu = new Gtk.PopoverMenu({
        has_arrow: false,
        halign: Gtk.Align.START,
      });
      // Read the popover back off the signal instead of capturing it: a
      // closure an object owns that also refers to that object cannot be
      // collected.
      this._rowMenu.connect('closed', menu => {
        menu.get_parent()?.remove_css_class('has-open-popup');
        menu.unparent();
      });
    }
    if (this._rowMenu.get_parent()) {
      this._rowMenu.get_parent().remove_css_class('has-open-popup');
      this._rowMenu.unparent();
    }
    this._rowMenu.set_menu_model(this._sessionMenuModel(session, { inSidebar: true }));
    this._rowMenu.set_parent(row);
    this._rowMenu.set_pointing_to(new Gdk.Rectangle({ x, y, width: 1, height: 1 }));
    // libadwaita keeps a row highlighted while it owns an open popup, which is
    // the only cue on touch that the menu belongs to this row.
    row.add_css_class('has-open-popup');
    this._rowMenu.popup();
  }

  _selectedSession() {
    if (!this._selectedId) return null;
    return this._sidebar.sessionsById?.get(this._selectedId) || this._currentSession;
  }

  // The header's session-actions menu always reflects the selected session's
  // current flags; rebuilt after every list render (fresh pin/archive state)
  // and on selection changes.
  _syncSessionMenu() {
    const session = this._selectedSession();
    if (!session || session.is_subagent) {
      this._sessionMenu.set_visible(false);
      this._sessionMenu.set_menu_model(null);
      return;
    }
    this._sessionMenu.set_visible(true);
    this._sessionMenu.set_menu_model(this._sessionMenuModel(session));
  }

  // Sections separate the reversible actions from the destructive one, and
  // deleting keeps its confirmation dialog. Menu items carry no icons: GNOME
  // menus are text, and the mnemonics are what makes them keyboard-driven.
  _sessionMenuModel(session, { inSidebar = false } = {}) {
    const menu = new Gio.Menu();
    const subagents = inSidebar ? this._sidebar.subagentCount(session.id) : 0;
    if (subagents) {
      // Subagents are hidden by default; this is the only way to reveal them.
      const shown = this._sidebar.expandedSubagents.has(session.id);
      const section = new Gio.Menu();
      section.append(
        `${shown ? '_Hide' : '_Show'} ${subagents} Subagent${subagents > 1 ? 's' : ''}`,
        'win.session-subagents'
      );
      menu.append_section(null, section);
    }
    const main = new Gio.Menu();
    main.append('_Rename…', 'win.session-rename');
    main.append(session.pinned ? 'Un_pin' : '_Pin', 'win.session-pin');
    main.append(session.archived ? 'Restore from _Archive' : '_Archive', 'win.session-archive');
    main.append(isBusy(session) ? 'Pause _Worker' : 'Resume _Worker', 'win.session-worker');
    if (this._editorURL && session.cwd) main.append('Open in _Editor', 'win.session-editor');
    menu.append_section(null, main);
    const destructive = new Gio.Menu();
    destructive.append('_Delete Permanently…', 'win.session-delete');
    menu.append_section(null, destructive);
    return menu;
  }

  // The server supplies a URL template with {cwd} substituted verbatim.
  _openInEditor(cwd) {
    const url = this._editorURL.replace('{cwd}', cwd);
    try {
      Gtk.UriLauncher.new(url).launch(this, null, null);
    } catch (error) {
      this._showToast(`Could not open the editor: ${error.message || error}`);
    }
  }

  async _runSessionAction(operation, successMessage) {
    try {
      await operation();
      await this.refreshSessions();
      this._showToast(successMessage);
    } catch (error) {
      this._showToast(error.message || String(error));
    }
  }

  _showRenameDialog(session) {
    const dialog = new Adw.AlertDialog({
      heading: 'Rename session',
      body: 'Choose a title for this conversation.',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('rename', 'Rename');
    dialog.set_response_appearance('rename', Adw.ResponseAppearance.SUGGESTED);
    dialog.set_default_response('rename');
    dialog.set_close_response('cancel');
    const entry = new Gtk.Entry({
      text: session.title || '',
      activates_default: true,
      hexpand: true,
    });
    entry.set_size_request(360, -1);
    dialog.set_extra_child(entry);
    dialog.connect('response', async (_dialog, response) => {
      if (response !== 'rename') return;
      await this._runSessionAction(
        () => this._api.renameSession(session.id, entry.get_text().trim()),
        'Session renamed'
      );
    });
    dialog.present(this);
  }

  _showDeleteDialog(session) {
    const dialog = new Adw.AlertDialog({
      heading: 'Delete session permanently?',
      body: `“${ellipsize(session.title || '(untitled)', 120)}” and its transcript will be deleted. This cannot be undone.`,
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('delete', 'Delete');
    dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_close_response('cancel');
    dialog.connect('response', async (_dialog, response) => {
      if (response !== 'delete') return;
      try {
        await this._api.deleteSession(session.id);
        if (this._selectedId === session.id) this._clearSessionSelection();
        await this.refresh();
        this._showToast('Session deleted');
      } catch (error) {
        this._showToast(error.message || String(error));
      }
    });
    dialog.present(this);
  }

  _clearSessionSelection() {
    this._leaveNewSession();
    this._selectionEpoch++;
    this._selectedId = null;
    this._prompt.get_buffer().set_text('', -1);
    this._interactionKey = null;
    this._updateInteractions(this._pendingInteractions);
    this._syncSessionMenu();
    this._eventStream?.stop();
    this._eventStream = null;
    this._renderedTurns = [];
    this._transcriptStore.remove_all();
    this._liveTurn = null;
    this._sidebar.unselectAll();
    this._status.set_title('Select a session');
    this._status.set_description('Choose a conversation from the sidebar.');
    this._status.set_visible(true);
    this._chatScroll.set_visible(false);
    this._loadEarlier.set_visible(false);
    this._composer.set_visible(false);
    if (this._splitView.get_collapsed()) this._splitView.set_show_sidebar(true);
  }

  // Takes over the conversation surface: the ordinary composer, plus the
  // controls a session needs before it exists.
  async _showNewSession() {
    this._selectionEpoch++;
    this._selectedId = null;
    this._eventStream?.stop();
    this._eventStream = null;
    this._liveTurn = null;
    this._renderedTurns = [];
    this._transcriptStore.remove_all();
    this._sidebar.unselectAll();
    this._newMode = true;
    this._newAgent = '';
    this._newBackend = '';
    this._newModel = '';
    this._currentSession = null;

    this._title.set_title('New session');
    this._title.set_subtitle('');
    this._status.set_title('New session');
    this._status.set_description(
      'Set a working directory, then write the first message.');
    this._status.set_visible(true);
    this._chatScroll.set_visible(false);
    this._loadEarlier.set_visible(false);
    this._usage.set_visible(false);
    this._syncSessionMenu();
    this._interactionKey = null;
    this._updateInteractions(this._pendingInteractions);
    this._commands = [];
    this._newBar.set_visible(true);
    this._newConfig.set_visible(true);
    this._composer.set_visible(true);
    this._syncAutoApprove();
    this._syncComposerActions();
    if (this._splitView.get_collapsed()) this._splitView.set_show_sidebar(false);
    this._newCwdSuggestions.set_popover(this._cwdSuggestionPopover());
    this._prompt.grab_focus();

    // The catalogs only decorate the picker; the view is usable (and the
    // request valid) with everything left at its default.
    try {
      const [catalog, agentList] = await Promise.all([
        this._api.listModels(), this._api.listAgents(),
      ]);
      if (!this._newMode) return;
      this._modelCatalog = catalog;
      this._agentProfiles = agentList?.agents || [];
    } catch (_) {
      this._modelCatalog = null;
      this._agentProfiles = [];
    }
    this._syncNewConfig();
  }

  _leaveNewSession() {
    if (!this._newMode) return;
    // Blank it first: once _newMode is off the composer's contents count as a
    // draft, and this text was never one.
    this._prompt.get_buffer().set_text('', -1);
    this._newMode = false;
    this._newBar.set_visible(false);
    this._newConfig.set_visible(false);
    this._newCwd.set_text('');
  }

  // Directories already in the session list are the ones worth offering.
  _cwdSuggestionPopover() {
    const cwds = [...new Set(
      [...(this._sidebar.sessionsById?.values() || [])].map(s => s.cwd).filter(Boolean)
    )].sort();
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    list.add_css_class('boxed-list');
    list.set_size_request(320, -1);
    const popover = new Gtk.Popover({
      child: new Gtk.ScrolledWindow({
        child: list, max_content_height: 320, propagate_natural_height: true,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
      }),
    });
    if (!cwds.length) {
      const empty = new Adw.ActionRow({ title: 'No recent directories' });
      empty.add_css_class('dim-label');
      list.append(empty);
      return popover;
    }
    for (const cwd of cwds) {
      const row = new Adw.ActionRow({ title: cwd, activatable: true });
      row.connect('activated', () => {
        this._newCwd.set_text(cwd);
        popover.popdown();
      });
      list.append(row);
    }
    return popover;
  }

  // Rebuilds the composer's config menu and its summary label. Agents are
  // top-level radio items (the common choice); backend and model are submenus,
  // because the model list depends on the backend.
  _syncNewConfig() {
    const backends = this._modelCatalog?.backends || [];
    const backend = this._newBackend || backends[0] || '';
    const models = this._modelCatalog?.models?.[backend] || [];

    const menu = new Gio.Menu();
    if (this._agentProfiles?.length) {
      const agents = new Gio.Menu();
      agents.append('Custom', 'win.new-agent::');
      for (const profile of this._agentProfiles) {
        agents.append(profile.name, `win.new-agent::${profile.name}`);
      }
      menu.append_section(null, agents);
    }
    const runtime = new Gio.Menu();
    if (backends.length) {
      const backendMenu = new Gio.Menu();
      for (const name of backends) backendMenu.append(name, `win.new-backend::${name}`);
      runtime.append_submenu('Backend', backendMenu);
    }
    if (models.length) {
      const modelMenu = new Gio.Menu();
      modelMenu.append('Default', 'win.new-model::');
      for (const model of models) {
        modelMenu.append(model.display_name || model.id, `win.new-model::${model.id}`);
      }
      runtime.append_submenu('Model', modelMenu);
    }
    menu.append_section(null, runtime);
    this._newConfig.set_menu_model(menu);

    this.lookup_action('new-agent')?.set_state(GLib.Variant.new_string(this._newAgent));
    this.lookup_action('new-backend')?.set_state(GLib.Variant.new_string(backend));
    this.lookup_action('new-model')?.set_state(GLib.Variant.new_string(this._newModel));

    const modelLabel = models.find(m => m.id === this._newModel)?.display_name ||
      this._newModel;
    const summary = this._newAgent ||
      [backend, modelLabel].filter(Boolean).join(' · ') || 'Default';
    this._newConfig.set_label(ellipsize(summary, 28));
    // The picker wears the backend's colour, as the web one does; that is what
    // carries the choice once the label is elided down to the model.
    for (const name of BACKENDS) this._newConfig.remove_css_class(`backend-${name}`);
    if (BACKENDS.includes(backend)) this._newConfig.add_css_class(`backend-${backend}`);
    this._title.set_subtitle(this._newAgent ? `agent: ${this._newAgent}` : '');
  }

  // Choosing an agent fills in what that agent has an opinion about; the
  // fields stay editable, so anything changed afterwards is sent as an
  // override.
  _applyNewAgent(name) {
    this._newAgent = name;
    const profile = this._agentProfiles?.find(p => p.name === name);
    if (profile) {
      if (profile.cwd) this._newCwd.set_text(profile.cwd);
      if (profile.backend) this._newBackend = profile.backend;
      this._newModel = profile.model || '';
      this._updatingAutoApprove = true;
      this._autoApprove.set_active(Boolean(profile.auto_approve));
      this._autoApprove.set_label(`Approve: ${profile.auto_approve ? 'auto' : 'ask'}`);
      this._updatingAutoApprove = false;
    }
    this._syncNewConfig();
  }

  async _createSession(text) {
    const request = {
      cwd: this._newCwd.get_text().trim(),
      initialMessage: text,
      backend: this._newBackend,
      model: this._newModel,
      agent: this._newAgent,
      autoApprove: this._autoApprove.get_active(),
    };
    // An agent can supply the working directory; without one it is required.
    if (!request.cwd && !request.agent) {
      this._showToast('Choose an agent or set a working directory');
      return;
    }
    this._sendInFlight = true;
    this._syncComposerActions();
    try {
      const result = await this._api.createSession(request);
      this._leaveNewSession();
      await this.refresh();
      // Selecting the row only moves the highlight; opening the session is a
      // separate step now that the list no longer drives it.
      await this._selectSession(result.id);
      this._sidebar.selectSession(result.id);
    } catch (error) {
      this._showToast(error.message || String(error));
    } finally {
      this._sendInFlight = false;
      this._syncComposerActions();
    }
  }

  // Unsent text belongs to the session it was typed for. Without this the
  // composer carries it to whatever is opened next — and sends it there.
  // A draft belongs to the session that was on screen while it was typed, so
  // it is recorded as it is typed. Filing it at switch time instead would put
  // it under the wrong session whenever a selection arrives from the list
  // rather than from the user — GtkListBox emits one whenever filtering or a
  // rebuild disturbs which row is current.
  _watchDraft() {
    this._prompt.get_buffer().connect('changed', buffer => {
      if (this._newMode || !this._selectedId) return;
      const text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
      if (text) this._drafts.set(this._selectedId, text);
      else this._drafts.delete(this._selectedId);
    });
  }

  _restoreDraft(id) {
    this._prompt.get_buffer().set_text(this._drafts.get(id) || '', -1);
  }

  async _selectSession(id) {
    this._leaveNewSession();
    const epoch = ++this._selectionEpoch;
    this._selectedId = id;
    this._restoreDraft(id);
    // Opening a session is what clears its "new response" mark.
    if (this._unread.delete(id) && this._sidebar.sessionsById.size) {
      this._renderSessions([...this._sidebar.sessionsById.values()]);
    }
    this._eventStream?.stop();
    this._eventStream = null;
    this._liveTurn = null;
    this._renderedTurns = [];
    this._sendInFlight = false;
    this._transcriptStore.remove_all();
    this._setTurnRunning(false);
    this._hasEarlier = false;
    this._loadingEarlier = false;
    // Blank, not a status page: opening a session is quick enough that a
    // "Loading…" screen only registers as a flash. A failure replaces this
    // with the error page anyway.
    this._status.set_visible(false);
    this._chatScroll.set_visible(false);
    this._loadEarlier.set_visible(false);
    this._composer.set_visible(false);
    try {
      const session = await this._api.getSession(id);
      if (this._selectionEpoch !== epoch || this._selectedId !== id) return;
      this._title.set_title(session.title || '(untitled)');
      this._title.set_subtitle(ellipsize(`${session.backend} · ${session.cwd}`, 200));
      this._currentSession = session;
      this._syncAutoApprove();
      this._renderRuntime(session.runtime);
      this._loadCommands(id, epoch);
      if (!await this._loadTranscript(id, epoch)) return;
      if (this._selectionEpoch !== epoch || this._selectedId !== id) return;
      this._status.set_visible(false);
      this._chatScroll.set_visible(true);
      this._composer.set_visible(!session.is_subagent);
      if (this._splitView.get_collapsed()) this._splitView.set_show_sidebar(false);
      this._interactionKey = null;
      this._updateInteractions(this._pendingInteractions);
      this._syncSessionMenu();
      this._openEvents(id, epoch);
    } catch (error) {
      if (this._selectionEpoch !== epoch || this._selectedId !== id) return;
      this._selectionEpoch++;
      this._selectedId = null;
      this._sidebar.unselectAll();
      this._syncSessionMenu();
      this._showError('Could not open session', error);
    }
  }

  // The server tags each interaction with a kind: "permission" is allow/deny,
  // "choice" and "text" are answered by picking or typing. One of each can be
  // pending at once. The keyed comparison skips rebuilds, or a poll would yank
  // buttons out from under a click and clear half-typed answers.
  _updateInteractions(list) {
    this._pendingInteractions = list;
    const mine = this._selectedId
      ? list.filter(p => p.session_id === this._selectedId)
      : [];
    const permissions = mine.filter(p => !this._interactions.isQuestion(p));
    const questions = mine.filter(p => this._interactions.isQuestion(p));
    const key = `${permissions[0]?.id || ''}|${questions[0]?.id || ''}`;
    if (key === this._interactionKey) return;
    this._interactionKey = key;
    let child;
    while ((child = this._permissionBox.get_first_child())) this._permissionBox.remove(child);
    if (!permissions.length && !questions.length) {
      this._permissionBox.set_visible(false);
      return;
    }
    this._permissionBox.set_visible(true);
    if (permissions.length) {
      this._permissionBox.append(this._interactions.interactionCard(
        this._interactions.permissionWidget(permissions[0], permissions.length)));
    }
    if (questions.length) {
      this._permissionBox.append(this._interactions.interactionCard(
        this._interactions.questionWidget(questions[0], questions.length)));
    }
    this._scrollToBottom();
  }

  async _respondInteraction(id, payload, buttons) {
    for (const button of buttons) button.set_sensitive(false);
    try {
      await this._api.respondInteraction(id, payload);
      this._interactionKey = null;
      this._updateInteractions(this._pendingInteractions.filter(p => p.id !== id));
    } catch (error) {
      for (const button of buttons) button.set_sensitive(true);
      this._showToast(error.message || String(error));
    }
  }

  // The backend's own command catalog (/model, /compact, …). A backend that
  // cannot answer reports available:false, which is not an error — the
  // composer simply offers no completions.
  async _loadCommands(id, epoch) {
    this._commands = [];
    this._commandSigil = '/';
    try {
      const catalog = await this._api.listCommands(id);
      if (this._selectionEpoch !== epoch || this._selectedId !== id) return;
      if (catalog?.available) this._commands = catalog.commands || [];
      this._commandSource = catalog?.source || '';
    } catch (_) {
      // Leave the composer without completions; sending still works.
    }
  }

  // Codex exposes skills under a different sigil than commands.
  _sigilFor(command) {
    return this._commandSource === 'codex' && command.kind === 'skill' ? '$' : '/';
  }

  // The token being completed: the whole prompt, only while it is a single
  // leading "/word" — the same rule the web composer uses, which keeps the
  // popup out of the way of prose that merely contains a slash.
  _commandToken() {
    const buffer = this._prompt.get_buffer();
    const text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
    const match = /^[/$]([\w:-]*)$/.exec(text);
    return match ? match[1] : null;
  }

  _buildCommandPopup() {
    this._commandList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
    this._commandList.add_css_class('boxed-list');
    this._commandList.connect('row-activated', (_list, row) => this._applyCommand(row.command));
    const scroll = new Gtk.ScrolledWindow({
      child: this._commandList,
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      max_content_height: 260,
      propagate_natural_height: true,
    });
    scroll.set_size_request(360, -1);
    this._commandPopup = new Gtk.Popover({
      child: scroll,
      autohide: false,
      has_arrow: false,
      position: Gtk.PositionType.TOP,
    });
    this._commandPopup.set_parent(this._prompt);
  }

  _updateCommandPopup() {
    const token = this._commandToken();
    if (token === null || !this._commands?.length) {
      this._commandPopup.popdown();
      return;
    }
    const query = token.toLowerCase();
    const matches = this._commands
      .filter(command => command.name.toLowerCase().includes(query))
      .slice(0, 12);
    let child;
    while ((child = this._commandList.get_first_child())) this._commandList.remove(child);
    if (!matches.length) {
      this._commandPopup.popdown();
      return;
    }
    for (const command of matches) {
      const row = new Adw.ActionRow({
        title: `${this._sigilFor(command)}${command.name}`,
        subtitle: command.description || '',
      });
      row.command = command;
      this._commandList.append(row);
    }
    this._commandList.select_row(this._commandList.get_row_at_index(0));
    this._commandPopup.popup();
  }

  _applyCommand(command) {
    if (!command) return;
    this._prompt.get_buffer().set_text(`${this._sigilFor(command)}${command.name} `, -1);
    this._commandPopup.popdown();
    this._prompt.grab_focus();
  }

  // Arrow keys and Tab/Enter drive the popup while it is up; everything else
  // falls through to the text view.
  _handleCommandKey(keyval) {
    if (!this._commandPopup?.get_visible()) return false;
    const selected = this._commandList.get_selected_row();
    const index = selected ? selected.get_index() : 0;
    const move = step => {
      const count = [...this._commandRows()].length;
      if (!count) return true;
      const next = (index + step + count) % count;
      this._commandList.select_row(this._commandList.get_row_at_index(next));
      return true;
    };
    if (keyval === Gdk.KEY_Down) return move(1);
    if (keyval === Gdk.KEY_Up) return move(-1);
    if (keyval === Gdk.KEY_Escape) { this._commandPopup.popdown(); return true; }
    if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_Return) {
      this._applyCommand(selected?.command);
      return true;
    }
    return false;
  }

  *_commandRows() {
    for (let i = 0; ; i++) {
      const row = this._commandList.get_row_at_index(i);
      if (!row) return;
      yield row;
    }
  }

  _renderRuntime(runtime) {
    const context = Number(runtime?.context_tokens) || 0;
    if (context <= 0) {
      this._usage.set_visible(false);
      return;
    }
    const window = Number(runtime?.context_window) || 0;
    const percent = window > 0 ? Math.min(100, Math.round(context / window * 100)) : 0;
    this._usage.set_visible(true);
    this._usageFraction = window > 0 ? percent / 100 : 0;
    this._usageRing.queue_draw();
    this._usage.set_tooltip_text(window > 0
      ? `Context ${percent}% used` : 'Context limit unavailable');

    let child;
    while ((child = this._usageDetail.get_first_child())) this._usageDetail.remove(child);
    const addRow = (name, value) => {
      const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 18 });
      const key = new Gtk.Label({ label: name, xalign: 0, hexpand: true });
      key.add_css_class('dim-label');
      row.append(key);
      row.append(new Gtk.Label({ label: value, xalign: 1 }));
      this._usageDetail.append(row);
    };
    if (runtime.model) addRow('Model', runtime.model);
    if (runtime.effort) addRow('Effort', runtime.effort);
    addRow('Context', window > 0
      ? `${this._formatTokens(context)} / ${this._formatTokens(window)}`
      : `${this._formatTokens(context)} / unavailable`);
    if (window > 0) {
      const bar = new Gtk.LevelBar({ min_value: 0, max_value: 100, value: percent });
      bar.set_size_request(200, -1);
      this._usageDetail.append(bar);
    }
  }

  _formatTokens(count) {
    if (count < 1000) return String(count);
    if (count < 1000000) return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`.replace('.0', '');
    return `${(count / 1000000).toFixed(1)}m`.replace('.0', '');
  }

  _syncAutoApprove() {
    // In the new-session view the toggle is a preset for a session that does
    // not exist yet, so it keeps whatever the user (or a chosen agent) set.
    const enabled = this._newMode
      ? this._autoApprove.get_active()
      : Boolean(this._currentSession?.auto_approve);
    this._updatingAutoApprove = true;
    this._autoApprove.set_active(enabled);
    this._autoApprove.set_label(`Approve: ${enabled ? 'auto' : 'ask'}`);
    this._updatingAutoApprove = false;
  }

  async _toggleAutoApprove() {
    if (this._updatingAutoApprove) return;
    if (this._newMode) {
      // Nothing to persist yet; it rides along with the create request.
      this._autoApprove.set_label(
        `Approve: ${this._autoApprove.get_active() ? 'auto' : 'ask'}`);
      return;
    }
    if (!this._selectedId || !this._currentSession) return;
    const session = this._currentSession;
    const sessionId = this._selectedId;
    const enabled = this._autoApprove.get_active();
    const previous = Boolean(session.auto_approve);
    this._autoApprove.set_label(`Approve: ${enabled ? 'auto' : 'ask'}`);
    this._autoApprove.set_sensitive(false);
    try {
      await this._api.setAutoApprove(sessionId, enabled);
      session.auto_approve = enabled;
    } catch (error) {
      session.auto_approve = previous;
      if (this._currentSession === session) this._syncAutoApprove();
      this._showToast(`Auto-approve update failed: ${error.message || error}`);
    } finally {
      this._autoApprove.set_sensitive(true);
    }
  }

  async _chooseUpload() {
    if (!this._selectedId && !this._newMode) return;
    try {
      const file = await new Gtk.FileDialog({ title: 'Upload File' }).open(this, null);
      if (!file) return;
      this._upload.set_sensitive(false);
      const [bytes] = await file.load_bytes_async(null);
      const filename = file.get_basename();
      const [contentType] = Gio.content_type_guess(filename, null);
      // Before a session exists the file goes to the shared drafts directory;
      // either way the prompt just carries the resulting path.
      const result = await this._api.upload(
        this._newMode ? null : this._selectedId, filename, contentType, bytes);
      const buffer = this._prompt.get_buffer();
      const current = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      buffer.set_text(`${current}${prefix}${fileRef(result.path)} `, -1);
      this._prompt.grab_focus();
      this._showToast(`Uploaded ${filename}`);
    } catch (error) {
      if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) &&
          !error.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED)) {
        this._showToast(`Upload failed: ${error.message || error}`);
      }
    } finally {
      this._upload.set_sensitive(true);
    }
  }

  // Catches up from the last turn that has a cursor, or reads the newest page
  // when there is none or the server no longer knows it.
  async _loadTranscript(id, epoch = this._selectionEpoch) {
    const stale = () => this._selectionEpoch !== epoch || this._selectedId !== id;
    const initialLoad = this._renderedTurns.length === 0;
    // A turn the event stream delivered has no cursor until a refresh.
    const held = this._renderedTurns.findLast(entry => entry.turn.cursor)?.turn.cursor;
    let page = null;
    if (held) {
      page = await this._api.getTranscript(id, { from: held });
      if (stale()) return false;
    }
    let base = page?.turns.length
      ? this._renderedTurns.findIndex(entry => entry.turn.cursor === held) : -1;
    if (base < 0) {
      page = await this._api.getTranscript(id, { limit: TRANSCRIPT_PAGE });
      if (stale()) return false;
      base = 0;
      this._hasEarlier = page.more;
    }
    const incoming = page.turns.map(turn => ({ key: this._turnKey(turn), turn }));
    let common = 0;
    while (common < incoming.length && base + common < this._renderedTurns.length &&
           incoming[common].key === this._renderedTurns[base + common].key) {
      this._renderedTurns[base + common].turn = incoming[common].turn;
      common++;
    }
    // Everything past the common prefix goes, which is also how the live turn
    // and the optimistic echo are reconciled away.
    this._renderedTurns.length = base + common;
    this._optimisticTurn = null;
    this._liveTurn = null;
    // One splice rather than a remove and an append per turn: each of those
    // is an items-changed the list view has to answer.
    const added = incoming.slice(common)
      .map(entry => new TranscriptItem(entry.turn, entry.key));
    this._transcriptStore.splice(
      base + common, this._transcriptStore.get_n_items() - base - common, added);
    for (let i = common; i < incoming.length; i++) this._renderedTurns.push(incoming[i]);
    this._scrollToBottom(initialLoad);
    this._loadEarlier.set_visible(this._hasEarlier);
    return true;
  }

  // Inserts the page of turns ahead of the oldest one rendered.
  async _loadEarlierMessages() {
    const id = this._selectedId;
    const epoch = this._selectionEpoch;
    const oldest = this._renderedTurns[0]?.turn.cursor;
    if (!id || this._loadingEarlier || !this._hasEarlier || !oldest) return;
    this._loadingEarlier = true;
    this._loadEarlier.set_sensitive(false);
    try {
      const { turns, more } = await this._api.getTranscript(
        id, { limit: TRANSCRIPT_PAGE, before: oldest });
      if (this._selectionEpoch !== epoch || this._selectedId !== id) return;
      this._hasEarlier = more && turns.length > 0;
      this._loadEarlier.set_visible(this._hasEarlier);
      if (!turns.length) return;
      const entries = turns.map(turn => ({ key: this._turnKey(turn), turn }));
      this._transcriptStore.splice(
        0, 0, entries.map(e => new TranscriptItem(e.turn, e.key)));
      this._renderedTurns.unshift(...entries);
      // Put the turn that was at the top back at the top, so the inserted
      // history does not yank the reader.
      this._messages.scroll_to(entries.length, Gtk.ListScrollFlags.NONE, null);
    } catch (error) {
      this._showToast(error.message || String(error));
    } finally {
      this._loadingEarlier = false;
      this._loadEarlier.set_sensitive(true);
    }
  }

  _turnKey(turn) {
    return JSON.stringify({
      role: turn.role || '',
      content: turn.content || '',
      parts: turn.parts || [],
      ts: turn.ts || '',
    });
  }

  // Speaker identity follows the pattern shared by Fractal and Alpaca: a
  // small sender header on every turn (bold name + dim timestamp), with
  // alignment and a tinted bubble as the secondary cue — user prompts sit
  // right-aligned in a bubble, assistant turns flow plainly at full width.
  async _forkTurn(uuid) {
    if (!this._selectedId) return;
    try {
      const result = await this._api.fork(this._selectedId, uuid);
      await this.refresh();
      // Selecting the row only moves the highlight; opening the session is a
      // separate step now that the list no longer drives it.
      await this._selectSession(result.id);
      this._sidebar.selectSession(result.id);
      this._showToast('Forked to a new session');
    } catch (error) {
      this._showToast(error.message || String(error));
    }
  }

  _openEvents(id, epoch = this._selectionEpoch) {
    this._eventStream?.stop();
    this._eventStream = new EventStream(
      this._api.session,
      `${this._backend.baseUrl}/api/sessions/${encodeURIComponent(id)}/events`,
      (name, data) => {
        if (this._selectionEpoch !== epoch || this._selectedId !== id) return;
        if (name === 'turn.active' || name === 'subprocess.started') {
          this._setTurnRunning(true);
          this._beginLiveTurn();
        }
        if (name === 'turn.idle' || name === 'subprocess.exit' || name === 'error') {
          if (name === 'error') {
            this._showToast(`Turn failed: ${data?.message || 'unknown error'}`);
          }
          this._setTurnRunning(false);
          this._loadTranscript(id).catch(error => this._showToast(error.message));
        }
        if (name === 'turn.user') {
          this._appendUserTurn(data);
        }
        if (name === 'part') this._appendLivePart(data);
        if (name === 'part.delta') this._appendLiveDelta(data);
        if (name === 'session.runtime') this._renderRuntime(data);
        // The backend says it is reasoning before it emits anything to show.
        if (name === 'turn.status' && data?.status === 'thinking') {
          this._beginLiveTurn();
          this._setLiveStatus('Thinking…');
        }
      },
      (state, error) => this._setStreamState(state, error)
    );
    this._eventStream.start();
  }

  // An unconfirmed echo of what was just sent. It carries no key, so the
  // transcript diff in _loadTranscript treats it as surplus and drops it once
  // the persisted turn arrives — the same reconciliation a live turn gets.
  _appendOptimisticTurn(text) {
    this._optimisticTurn = { role: 'user', content: text, ts: '', optimistic: true };
    const index = this._liveTurn ? this._transcriptStore.get_n_items() - 1 : -1;
    const item = new TranscriptItem(this._optimisticTurn, '__optimistic__');
    if (index >= 0) this._transcriptStore.insert(index, item);
    else this._transcriptStore.append(item);
    this._scrollToBottom(true);
  }

  _removeOptimisticTurn() {
    if (!this._optimisticTurn) return;
    for (let i = this._transcriptStore.get_n_items() - 1; i >= 0; i--) {
      if (this._transcriptStore.get_item(i).key === '__optimistic__') {
        this._transcriptStore.remove(i);
        break;
      }
    }
    this._optimisticTurn = null;
  }

  async _sendMessage() {
    // The in-flight guard matters for Ctrl+Enter, which bypasses the
    // desensitized send button.
    if (this._sendInFlight) return;
    if (this._newMode) {
      const buffer = this._prompt.get_buffer();
      const text = buffer.get_text(
        buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
      if (text) await this._createSession(text);
      return;
    }
    if (!this._selectedId) return;
    const id = this._selectedId;
    const epoch = this._selectionEpoch;
    const buffer = this._prompt.get_buffer();
    const text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
    if (!text) return;
    this._sendInFlight = true;
    this._syncComposerActions();
    // The canonical turn replaces this echo when turn.user lands.
    buffer.set_text('', -1);
    this._drafts.delete(id);
    this._appendOptimisticTurn(text);
    try {
      await this._api.send(id, text);
      if (this._selectionEpoch === epoch && this._selectedId === id) {
        this._setTurnRunning(true);
      }
    } catch (error) {
      if (this._selectionEpoch === epoch && this._selectedId === id) {
        this._removeOptimisticTurn();
        buffer.set_text(text, -1); // hand the message back rather than lose it
        this._showToast(error.message || String(error));
      }
    } finally {
      if (this._selectionEpoch === epoch && this._selectedId === id) {
        this._sendInFlight = false;
        this._syncComposerActions();
      }
    }
  }

  async _cancelTurn() {
    if (!this._selectedId || !this._turnRunning) return;
    const id = this._selectedId;
    this._cancel.set_sensitive(false);
    try {
      await this._api.cancel(id);
    } catch (error) {
      if (this._selectedId === id) {
        this._cancel.set_sensitive(true);
        this._showToast(error.message || String(error));
      }
    }
  }

  _setTurnRunning(running) {
    this._turnRunning = running;
    // Paging in older turns mid-stream would rebuild the list under the live
    // turn, so it waits until the turn is done.
    this._loadEarlier.set_sensitive(!running);
    this._syncComposerActions();
  }

  _syncComposerActions() {
    // Nothing is running in the new-session view, so send is always the
    // action there — the stop button belongs to a turn that exists.
    const running = this._turnRunning && !this._newMode;
    this._send.set_visible(!running);
    this._send.set_sensitive(!running && !this._sendInFlight);
    this._cancel.set_visible(running);
    this._cancel.set_sensitive(running);
  }

  _setStreamState(state, error = null) {
    const disconnected = state !== 'connected';
    this._connectionStatus.set_visible(disconnected);
    if (disconnected && !this._streamDisconnected) {
      this._showToast(error?.message || 'Live updates disconnected; reconnecting…');
    }
    this._streamDisconnected = disconnected;
  }

  _showConnectionDialog(errorMessage = '') {
    const dialog = new Adw.PreferencesDialog({ title: 'Connections' });
    const page = new Adw.PreferencesPage({
      title: 'Connections',
      icon_name: 'network-server-symbolic',
    });

    // --- Local group ---
    // Sandboxed builds cannot start anything on the host, so instead of a
    // control that could only fail, the Local group explains how to run usher
    // outside the sandbox and add it below as a server.
    if (isSandboxed()) {
      const sandboxGroup = new Adw.PreferencesGroup({ title: 'Local' });
      if (errorMessage) sandboxGroup.set_description(errorMessage);
      const explain = new Gtk.Label({
        label: 'This build runs in a sandbox and cannot start usher for you.\n\n' +
          'Run it yourself on this machine:\n' +
          '    usher serve\n\n' +
          'then add http://127.0.0.1:7777 as a remote server below. ' +
          'If you have set a password, usher will ask for it.',
        xalign: 0,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
        selectable: true,
        // Selectable so the command can be copied, but not focusable: as the
        // dialog's first focusable widget it would open with everything
        // highlighted.
        can_focus: false,
      });
      explain.set_margin_top(12);
      explain.set_margin_bottom(12);
      explain.set_margin_start(12);
      explain.set_margin_end(12);
      const frame = new Gtk.Frame({ child: explain });
      frame.add_css_class('card');
      sandboxGroup.add(frame);
      page.add(sandboxGroup);
      return this._addRemoteGroup(dialog, page);
    }

    const localGroup = new Adw.PreferencesGroup({ title: 'Local' });
    if (errorMessage) localGroup.set_description(errorMessage);
    const pathRow = new Adw.EntryRow({ title: 'Binary path' });
    pathRow.set_text(this._servers.embeddedPath);
    localGroup.add(pathRow);
    const portRow = new Adw.SpinRow({
      title: 'Port',
      subtitle: `usher's own default is 7777; this one defaults to ${DEFAULT_EMBEDDED_PORT}`,
      adjustment: new Gtk.Adjustment({
        lower: 1, upper: 65535, step_increment: 1, page_increment: 100,
        value: this._servers.embeddedPort,
      }),
    });
    localGroup.add(portRow);
    const address = () => `127.0.0.1:${portRow.get_value()}`;

    const isEmbeddedActive = this._currentServer?.id === '__embedded__' && this._started;
    const startRow = new Adw.ActionRow({
      title: isEmbeddedActive ? 'Embedded usher' : 'Start embedded usher',
      subtitle: isEmbeddedActive ? `${address()} · Connected` : address(),
    });
    portRow.connect('notify::value', () => {
      if (!isEmbeddedActive) startRow.set_subtitle(address());
    });
    if (isEmbeddedActive) {
      startRow.add_prefix(new Gtk.Image({
        icon_name: 'object-select-symbolic',
        valign: Gtk.Align.CENTER,
      }));
    }
    const startButton = new Gtk.Button({
      label: isEmbeddedActive ? 'Reconnect' : 'Start',
      valign: Gtk.Align.CENTER,
    });
    startButton.add_css_class('suggested-action');
    startRow.add_suffix(startButton);
    startRow.set_activatable_widget(startButton);
    startButton.connect('clicked', async () => {
      const path = pathRow.get_text().trim();
      if (!path) { pathRow.grab_focus(); return; }
      const port = Math.round(portRow.get_value());
      this._servers.setEmbeddedPath(path);
      this._servers.setEmbeddedPort(port);
      startButton.set_sensitive(false);
      startRow.set_subtitle('Starting…');
      const config = {
        id: '__embedded__',
        name: 'Embedded usher',
        url: '',
        binaryPath: path,
        port,
      };
      const result = await this._connectTo(config);
      if (result === true) {
        this._servers.selectEmbedded();
        if (this._backend.adopted) {
          this._showToast('Connected to the usher already running on this port');
        }
        dialog.close();
        return;
      }
      startButton.set_sensitive(true);
      if (result === 'auth') {
        // Something was already listening and it is not ours to authenticate
        // to from disk, so it takes a password like any other server.
        startRow.set_subtitle('Password required');
        this._promptPassword({ ...config, name: 'usher on this port' }, dialog);
        return;
      }
      // The reason arrives as a toast from _connectTo; the row keeps a marker
      // in case that toast is missed.
      startRow.set_subtitle(`${address()} · not started`);
    });
    localGroup.add(startRow);
    page.add(localGroup);

    this._addRemoteGroup(dialog, page);
  }

  // Shared by the ordinary dialog and the sandboxed one, which has no
  // local group to offer.
  _addRemoteGroup(dialog, page) {
    // --- Remote group ---
    const remoteGroup = new Adw.PreferencesGroup({ title: 'Remote' });
    for (const server of this._servers.servers) {
      const row = new Adw.ActionRow({
        title: server.name,
        subtitle: server.url,
        activatable: true,
      });
      if (this._currentServer?.id === server.id && this._started) {
        row.add_prefix(new Gtk.Image({
          icon_name: 'object-select-symbolic',
          valign: Gtk.Align.CENTER,
        }));
      }
      const editBtn = new Gtk.Button({
        icon_name: 'document-edit-symbolic',
        valign: Gtk.Align.CENTER,
      });
      editBtn.add_css_class('flat');
      editBtn.connect('clicked', () => {
        dialog.push_subpage(this._buildRemoteFormSubpage(dialog, server));
      });
      row.add_suffix(editBtn);
      const deleteBtn = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        valign: Gtk.Align.CENTER,
      });
      deleteBtn.add_css_class('flat');
      deleteBtn.connect('clicked', () => {
        const wasCurrent = this._currentServer?.id === server.id;
        clearPassword(server.id);
        this._servers.remove(server.id);
        remoteGroup.remove(row);
        if (wasCurrent) this._disconnect();
      });
      row.add_suffix(deleteBtn);
      row.connect('activated', async () => {
        const result = await this._connectTo(server);
        if (result === true) dialog.close();
        else if (result === 'auth') this._promptPassword(server, dialog);
      });
      remoteGroup.add(row);
    }

    const addRow = new Adw.ActionRow({
      title: 'Add remote server',
      activatable: true,
    });
    addRow.add_prefix(new Gtk.Image({
      icon_name: 'list-add-symbolic',
      valign: Gtk.Align.CENTER,
    }));
    addRow.add_suffix(new Gtk.Image({
      icon_name: 'go-next-symbolic',
      valign: Gtk.Align.CENTER,
    }));
    addRow.connect('activated', () => {
      dialog.push_subpage(this._buildRemoteFormSubpage(dialog));
    });
    remoteGroup.add(addRow);
    page.add(remoteGroup);

    dialog.add(page);
    dialog.present(this);
  }

  _buildRemoteFormSubpage(dialog, editServer = null) {
    const subpage = new Adw.NavigationPage({
      title: editServer ? 'Edit server' : 'Add remote server',
    });
    const toolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar();
    const connectBtn = new Gtk.Button({ label: 'Connect' });
    connectBtn.add_css_class('suggested-action');
    header.pack_end(connectBtn);
    toolbar.add_top_bar(header);

    const prefs = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
      description: 'Saved after a successful connection.',
    });
    const nameRow = new Adw.EntryRow({ title: 'Name' });
    nameRow.set_text(editServer?.name || '');
    group.add(nameRow);

    const urlRow = new Adw.EntryRow({
      title: 'URL',
      input_purpose: Gtk.InputPurpose.URL,
    });
    urlRow.set_text(editServer?.url || 'https://');
    group.add(urlRow);

    const passwordRow = new Adw.PasswordEntryRow({ title: 'Password' });
    group.add(passwordRow);
    prefs.add(group);
    toolbar.set_content(prefs);

    connectBtn.connect('clicked', async () => {
      const url = urlRow.get_text().trim();
      if (!url) { urlRow.grab_focus(); return; }
      if (!/^https?:\/\//i.test(url)) {
        this._showToast('URL must start with http:// or https://');
        urlRow.grab_focus();
        return;
      }
      const candidate = {
        id: editServer?.id || '',
        name: nameRow.get_text().trim() || url,
        url,
      };
      connectBtn.set_sensitive(false);
      const result = await this._connectTo(candidate, passwordRow.get_text());
      if (result === true) {
        dialog.close();
      } else {
        connectBtn.set_sensitive(true);
        if (result === 'auth') this._showToast('Incorrect password');
      }
    });

    subpage.set_child(toolbar);
    return subpage;
  }

  async _connectTo(serverConfig, password = '') {
    const previous = this._started ? this._currentServer : null;
    this._eventStream?.stop();
    this._eventStream = null;
    this._selectionEpoch++;
    this._connectionEpoch++;
    this._selectedId = null;
    this._backend.configure(serverConfig);
    this._api.setBaseUrl(this._backend.baseUrl);
    this._title.set_title('usher');
    this._title.set_subtitle('Connecting…');
    try {
      await this._backend.ensureRunning();
      // A password kept from an earlier session spares the user retyping it.
      if (!password && serverConfig.id) {
        password = await lookupPassword(serverConfig.id);
      }
      if (!password) this._authenticateOwnBackend();
      if (password) await this._api.login(password);
      const sessions = await this._api.listSessions();
      if (serverConfig.id === '__embedded__') {
        this._servers.selectEmbedded();
      } else {
        const saved = this._servers.upsert(serverConfig);
        this._servers.select(saved.id);
        serverConfig = saved;
      }
      if (password) storePassword(serverConfig.id, password, serverConfig.name);
      this._currentServer = serverConfig;
      this._sidebar.sessionsDigest = null;
      this._renderSessions(sessions || []);
      this._interactionKey = null;
      this._updateInteractions([]);
      this._status.set_title('Select a session');
      this._status.set_description('Choose a conversation from the sidebar.');
      this._status.set_visible(true);
      this._chatScroll.set_visible(false);
      this._composer.set_visible(false);
      this._started = true;
      this._title.set_subtitle(serverConfig.name || this._backend.baseUrl);
      this._loadServerConfig();
      return true;
    } catch (error) {
      // Point the client back at the previously working server so the
      // session list it still shows stays actionable.
      if (previous) {
        this._backend.configure(previous);
        this._api.setBaseUrl(this._backend.baseUrl);
        try {
          await this._backend.ensureRunning();
        } catch (_) {
          // The old server may be gone too; the user can reconnect explicitly.
        }
        this._title.set_subtitle(previous.name || this._backend.baseUrl);
        this._started = true;
      } else {
        this._started = false;
      }
      if (error.status === 401) return 'auth';
      if (!previous) this._showError('Could not connect', error);
      this._showToast(error.message || 'Connection failed');
      return false;
    }
  }

  _promptPassword(serverConfig, parentDialog = null) {
    const dialog = new Adw.AlertDialog({
      heading: 'Password required',
      body: serverConfig.name || serverConfig.url,
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('login', 'Login');
    dialog.set_response_appearance('login', Adw.ResponseAppearance.SUGGESTED);
    dialog.set_default_response('login');
    dialog.set_close_response('cancel');
    const entry = new Gtk.PasswordEntry({
      show_peek_icon: true,
      activates_default: true,
    });
    entry.set_margin_start(12);
    entry.set_margin_end(12);
    dialog.set_extra_child(entry);
    dialog.connect('response', async (_d, response) => {
      if (response !== 'login') return;
      const result = await this._connectTo(serverConfig, entry.get_text());
      if (result === true) {
        parentDialog?.close();
      } else if (result === 'auth') {
        this._showToast('Incorrect password');
        this._promptPassword(serverConfig, parentDialog);
      }
    });
    dialog.present(this);
  }

  _disconnect() {
    this._selectionEpoch++;
    this._connectionEpoch++;
    this._eventStream?.stop();
    this._backend.stop();
    this._currentServer = null;
    this._started = false;
    this._selectedId = null;
    this._sidebar.sessionsDigest = null;
    this._sidebar.sessionsById = new Map();
    this._interactionKey = null;
    this._updateInteractions([]);
    this._syncSessionMenu();
    this._sidebar.clear();
    this._showError('Disconnected', new Error('Select a server to connect.'));
  }

  _beginLiveTurn() {
    if (this._liveTurn) return;
    this._liveTurn = {
      role: 'assistant',
      parts: [],
      live: true,
      previewText: '',
      acceptDeltas: true,
    };
    this._transcriptStore.append(new TranscriptItem(this._liveTurn, '__live__'));
    this._scrollToBottom();
  }

  // Rebuilds every rendered turn from the data already held, which is what
  // switching between rendered and raw markdown needs; the factory builds the
  // widgets afresh for the replacement items.
  // Fresh items, so the cached widgets go and every turn is built against the
  // new render mode. One splice rather than a remove and an append per turn:
  // each of those is an items-changed the list view has to answer.
  _rerenderTranscript() {
    const items = this._renderedTurns
      .map(item => new TranscriptItem(item.turn, item.key));
    if (this._optimisticTurn) {
      items.push(new TranscriptItem(this._optimisticTurn, '__optimistic__'));
    }
    if (this._liveTurn) {
      items.push(new TranscriptItem(this._liveTurn, '__live__'));
    }
    this._transcriptStore.splice(0, this._transcriptStore.get_n_items(), items);
  }

  // Replaces the live turn's placeholder text while it has nothing to show.
  _setLiveStatus(status) {
    if (!this._liveTurn || this._liveTurn.parts.length) return;
    this._liveTurn.status = status;
    this._refreshLiveTurn();
  }

  _appendUserTurn(data) {
    if (!data?.content) return;
    const turn = { role: 'user', content: data.content, ts: data.ts || '' };
    const key = this._turnKey(turn);
    // This is the canonical version of what was echoed on send: drop the echo
    // rather than show the message twice. A prompt from another frontend has
    // no echo to adopt and simply renders.
    if (this._optimisticTurn?.content === data.content) this._removeOptimisticTurn();
    if (this._renderedTurns.some(item => item.key === key)) return;
    const item = new TranscriptItem(turn, key);
    this._growTranscript(() => {
      const liveIndex = this._liveTurn ? this._transcriptStore.get_n_items() - 1 : -1;
      if (liveIndex >= 0) this._transcriptStore.insert(liveIndex, item);
      else this._transcriptStore.append(item);
      this._renderedTurns.push({ key, turn });
    });
  }

  // A 'part' SSE event wraps the server-rendered TurnPart:
  // { role, ts, model, part: {type, content, toolName, toolTarget} }.
  _appendLivePart(data) {
    const part = data?.part;
    if (!part) return;
    if (part.type !== 'tool' && !part.content) return;
    this._beginLiveTurn();
    this._liveTurn.parts.push(part);
    if (part.type === 'tool') {
      this._liveTurn.acceptDeltas = true; // a later text item starts a new preview
    } else {
      // The canonical text part replaces the delta preview built for it.
      this._liveTurn.previewText = '';
      this._liveTurn.acceptDeltas = false;
    }
    this._growTranscript(() => this._refreshLiveTurn());
  }

  // 'part.delta' grows an ephemeral text preview; the complete JSONL-derived
  // part remains canonical and replaces it when it arrives. Re-rendering the
  // whole live turn per token would thrash the ListView, so refreshes are
  // batched on a short timer.
  _appendLiveDelta(data) {
    if (!data?.delta) return;
    this._beginLiveTurn();
    if (!this._liveTurn.acceptDeltas) return;
    this._liveTurn.previewText += data.delta;
    if (this._previewRefreshId) return;
    this._previewRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      this._previewRefreshId = 0;
      if (this._liveTurn) this._growTranscript(() => this._refreshLiveTurn());
      return GLib.SOURCE_REMOVE;
    });
  }

  _refreshLiveTurn() {
    if (!this._liveTurn) return;
    const index = this._transcriptStore.get_n_items() - 1;
    if (index < 0) return;
    this._transcriptStore.splice(
      index, 1,
      [new TranscriptItem({ ...this._liveTurn, parts: [...this._liveTurn.parts] }, '__live__')]
    );
  }

  // Whether to follow has to be decided before the content grows. A batch of
  // deltas taller than the 120px threshold would otherwise read as the reader
  // having scrolled up, and the view would stop following for the rest of the
  // turn — the regression usher fixed in the web client in fe5e715.
  _growTranscript(mutate) {
    const stick = this._isNearBottom();
    mutate();
    if (stick) this._scrollToBottom(true);
  }

  _isNearBottom() {
    const adjustment = this._chatScroll.get_vadjustment();
    return adjustment.get_value() + adjustment.get_page_size() >=
      adjustment.get_upper() - 120;
  }

  // Sticks to the bottom only when the user is already there (or force=true,
  // for a freshly opened session); a reader scrolled up stays put while new
  // parts stream in.
  _scrollToBottom(force = false) {
    if (!force && !this._isNearBottom()) return;
    this._scrollPending = true;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (this._scrollPending) this._applyScrollToBottom();
      return GLib.SOURCE_REMOVE;
    });
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      if (this._scrollPending) this._applyScrollToBottom();
      this._scrollPending = false;
      return GLib.SOURCE_REMOVE;
    });
  }

  _applyScrollToBottom() {
    const count = this._transcriptStore.get_n_items();
    // scroll_to realizes the last row, which a virtualized list may not have
    // measured yet; the adjustment then lands on the true bottom. Both are
    // needed: scroll_to alone only brings the row's *top* into view, leaving
    // the end of a row taller than the viewport (images, long answers) unseen.
    if (count > 0 && typeof this._messages.scroll_to === 'function') {
      this._messages.scroll_to(count - 1, Gtk.ListScrollFlags.NONE, null);
    }
    const adjustment = this._chatScroll.get_vadjustment();
    adjustment.set_value(Math.max(0, adjustment.get_upper() - adjustment.get_page_size()));
  }

  _showError(title, error) {
    this._status.set_title(title);
    this._status.set_description(error.message || String(error));
    this._status.set_visible(true);
    this._chatScroll.set_visible(false);
    this._loadEarlier.set_visible(false);
    this._composer.set_visible(false);
  }

  _showToast(message) {
    this._toastOverlay.add_toast(new Adw.Toast({
      title: ellipsize(String(message).replace(/\s+/g, ' '), 240),
      timeout: 4,
    }));
  }

  vfunc_close_request() {
    // A popover with set_parent() is not owned by the widget tree; without an
    // explicit unparent GTK warns about it at teardown.
    this._commandPopup?.unparent();
    if (this._pollId) {
      GLib.source_remove(this._pollId);
      this._pollId = 0;
    }
    if (this._previewRefreshId) {
      GLib.source_remove(this._previewRefreshId);
      this._previewRefreshId = 0;
    }
    this._eventStream?.stop();
    return super.vfunc_close_request();
  }
});
