import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { ApiClient } from './api-client.js';
import { EventStream } from './event-stream.js';
import { deriveAuthCookie } from './local-auth.js';
import { ServerStore } from './server-store.js';
import * as markdown from './markdown.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');

const TranscriptItem = GObject.registerClass(
class TranscriptItem extends GObject.Object {
  _init(turn, key = '') {
    super._init();
    this.turn = turn;
    this.key = key;
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
    this._transcriptLimit = 100;
    this._eventStream = null;
    this._started = false;
    this._rows = new Map();
    this._liveTurn = null;
    this._selectionEpoch = 0;
    this._turnRunning = false;
    this._sendInFlight = false;
    this._streamDisconnected = false;
    this._renderedTurns = [];
    this._scrollPending = false;
    this._connectionEpoch = 0;
    this._sessionsDigest = null;
    this._pendingInteractions = [];
    this._interactionKey = null;
    this._pollBusy = false;
    this._previewRefreshId = 0;

    this._buildUi();

    // Interactions (permission requests / questions) have no SSE channel;
    // the server expects clients to poll, like the web UI does. The same
    // tick keeps the session sidebar fresh (new sessions, status icons).
    this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      this._pollTick();
      return GLib.SOURCE_CONTINUE;
    });
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
    const server = new Gtk.Button({
      icon_name: 'network-server-symbolic',
      tooltip_text: 'Connect to an usher server',
    });
    server.connect('clicked', () => this._showConnectionDialog());
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
    header.pack_end(this._sessionMenu);
    contentToolbar.add_top_bar(header);

    const sidebarBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    sidebarBox.set_size_request(300, -1);
    this._search = new Gtk.SearchEntry({ placeholder_text: 'Search sessions' });
    this._search.connect('search-changed', () => this._filterSessions());
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
    sidebarHeader.pack_start(server);
    const newSession = new Gtk.Button({
      icon_name: 'list-add-symbolic',
      tooltip_text: 'New session',
    });
    newSession.connect('clicked', () => this._showNewSessionDialog());
    sidebarHeader.pack_start(newSession);
    sidebarToolbar.add_top_bar(sidebarHeader);

    this._sessionList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
    this._sessionList.add_css_class('navigation-sidebar');
    this._sessionList.set_filter_func(row => this._rowMatches(row));
    this._sessionList.set_header_func((row, before) => {
      if (before && before.groupKey === row.groupKey) {
        row.set_header(null);
        return;
      }
      const headerBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
      headerBox.set_margin_top(6);
      headerBox.set_margin_bottom(2);
      headerBox.set_margin_start(8);
      headerBox.set_margin_end(8);
      const label = new Gtk.Label({
        label: row.groupLabel,
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.MIDDLE,
        max_width_chars: 32,
        tooltip_text: row.groupLabel,
      });
      label.add_css_class('caption-heading');
      label.add_css_class('dim-label');
      headerBox.append(label);
      row.set_header(headerBox);
    });
    this._sessionList.connect('row-selected', (_list, row) => {
      if (row?.sessionId && row.sessionId !== this._selectedId) {
        this._selectSession(row.sessionId);
      }
    });
    const sidebarScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER });
    sidebarScroll.set_child(this._sessionList);
    sidebarScroll.set_vexpand(true);
    sidebarBox.append(sidebarScroll);
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
      listItem.set_child(this._turnWidget(item.turn));
    });
    transcriptFactory.connect('unbind', (_factory, listItem) => listItem.set_child(null));
    this._messages = new Gtk.ListView({
      model: transcriptSelection,
      factory: transcriptFactory,
      single_click_activate: false,
      hexpand: true,
      vexpand: true,
    });
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
    });
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
    this._autoApprove.connect('toggled', () => this._toggleAutoApprove());
    composerBar.append(this._autoApprove);
    const sendBox = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END, hexpand: true });
    this._send = new Gtk.Button({ icon_name: 'send-to-symbolic', tooltip_text: 'Send message' });
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
      return false;
    });
    this._prompt.add_controller(promptKeys);
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
        'Add a remote server URL or configure a local usher binary.'
      ));
      this._showConnectionDialog();
      return;
    }
    this._started = true;
    try {
      await this._backend.ensureRunning();
      // A locally managed backend shares this machine's usher data dir, so
      // authenticate the same way _connectTo does for the embedded server.
      if (this._backend.binaryPath) {
        const cookie = deriveAuthCookie();
        if (cookie) this._api.setAuthCookie(cookie);
      }
      this._title.set_subtitle(this._backend.baseUrl);
      const sessions = await this._api.listSessions();
      this._renderSessions(sessions || []);
    } catch (error) {
      this._showError('Could not connect to usher', error);
      this._started = false;
      // A saved connection remains selected even when it is temporarily
      // unavailable. Do not interrupt startup with a modal; the server button
      // remains available for editing or switching it explicitly.
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

  _renderSessions(sessions) {
    const recent = session => Date.parse(session.last_input_at) ||
      Date.parse(session.last_event_at) || 0;
    const groupRecent = new Map();
    for (const session of sessions) {
      const cwd = session.cwd || '(unknown)';
      groupRecent.set(cwd, Math.max(groupRecent.get(cwd) || 0, recent(session)));
    }
    sessions.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return recent(b) - recent(a);
      const ac = a.cwd || '(unknown)';
      const bc = b.cwd || '(unknown)';
      if (ac !== bc) return (groupRecent.get(bc) || 0) - (groupRecent.get(ac) || 0);
      return recent(b) - recent(a);
    });

    this._sessionsById = new Map(sessions.map(session => [session.id, session]));

    // Rebuilding tears down open popovers and selection feedback, so skip
    // the write when the poll delivered identical data.
    const digest = JSON.stringify(sessions);
    if (digest === this._sessionsDigest) return;
    this._sessionsDigest = digest;

    let child;
    while ((child = this._sessionList.get_first_child())) this._sessionList.remove(child);
    this._rows.clear();

    for (const session of sessions) {
      const row = new Gtk.ListBoxRow({
        activatable: true,
        selectable: true,
        tooltip_text: session.title || '(untitled)',
      });
      const rowContent = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 8,
        margin_end: 8,
      });
      const title = new Gtk.Label({
        label: session.title || '(untitled)',
        xalign: 0,
        hexpand: true,
        single_line_mode: true,
        ellipsize: Pango.EllipsizeMode.END,
      });
      rowContent.append(title);
      row.sessionId = session.id;
      row.groupKey = session.pinned ? '\u0000pinned' : (session.cwd || '(unknown)');
      row.groupLabel = session.pinned ? 'Pinned' : (session.cwd || '(unknown)');
      row.searchText = `${session.title || ''} ${session.cwd || ''}`.toLowerCase();
      if (session.status === 'running' || session.status === 'awaiting_permission') {
        const status = new Gtk.Image({
          icon_name: session.status === 'awaiting_permission'
            ? 'dialog-password-symbolic' : 'media-playback-start-symbolic',
          tooltip_text: session.status.replace('_', ' '),
        });
        status.add_css_class(session.status === 'awaiting_permission' ? 'warning' : 'accent');
        rowContent.prepend(status);
      }
      row.set_child(rowContent);
      if (session.archived) {
        row.add_css_class('dim-label');
        row.archived = true;
      }
      this._sessionList.append(row);
      this._rows.set(session.id, row);
    }
    this._sessionList.invalidate_filter();
    this._sessionList.invalidate_headers();
    const selected = this._selectedId ? this._rows.get(this._selectedId) : null;
    if (selected) {
      this._sessionList.select_row(selected);
    } else if (this._selectedId) {
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

  // The header's session-actions menu always reflects the selected session's
  // current flags; rebuilt after every list render (fresh pin/archive state)
  // and on selection changes.
  _syncSessionMenu() {
    const session = this._selectedId
      ? (this._sessionsById?.get(this._selectedId) || this._currentSession)
      : null;
    if (!session || session.is_subagent) {
      this._sessionMenu.set_visible(false);
      this._sessionMenu.set_popover(null);
      return;
    }
    this._sessionMenu.set_visible(true);
    this._sessionMenu.set_popover(this._sessionActionsPopover(session));
  }

  _filterSessions() {
    this._sessionList.invalidate_filter();
    this._sessionList.invalidate_headers();
  }

  _rowMatches(row) {
    const query = this._search?.get_text().trim().toLowerCase() || '';
    return !query || row.searchText?.includes(query);
  }

  _sessionActionsPopover(session) {
    const popover = new Gtk.Popover();
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    box.set_margin_top(6);
    box.set_margin_bottom(6);
    box.set_margin_start(6);
    box.set_margin_end(6);
    const add = (icon, label, callback, danger = false) => {
      const button = new Gtk.Button({ halign: Gtk.Align.FILL });
      const content = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
      content.append(new Gtk.Image({ icon_name: icon }));
      content.append(new Gtk.Label({ label, xalign: 0, hexpand: true }));
      button.set_child(content);
      button.add_css_class('flat');
      if (danger) button.add_css_class('destructive-action');
      button.connect('clicked', () => {
        popover.popdown();
        callback();
      });
      box.append(button);
    };
    add('document-edit-symbolic', 'Rename', () => this._showRenameDialog(session));
    add(
      session.pinned ? 'starred-symbolic' : 'non-starred-symbolic',
      session.pinned ? 'Unpin' : 'Pin',
      () => this._runSessionAction(
        () => this._api.setPinned(session.id, !session.pinned),
        session.pinned ? 'Session unpinned' : 'Session pinned'
      )
    );
    add(
      session.archived ? 'folder-open-symbolic' : 'folder-symbolic',
      session.archived ? 'Restore from archive' : 'Archive',
      () => this._runSessionAction(
        () => this._api.setArchived(session.id, !session.archived),
        session.archived ? 'Session restored' : 'Session archived'
      )
    );
    if (session.status === 'live' || session.status === 'running' ||
        session.status === 'awaiting_permission') {
      add(
        'media-playback-pause-symbolic',
        'Pause worker',
        () => this._runSessionAction(
          () => this._api.pauseSession(session.id),
          'Session worker paused'
        )
      );
    }
    add('user-trash-symbolic', 'Delete permanently…', () => this._showDeleteDialog(session), true);
    popover.set_child(box);
    return popover;
  }

  async _runSessionAction(operation, successMessage) {
    try {
      await operation();
      await this.refresh();
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
      body: `“${this._displayText(session.title || '(untitled)', 120)}” and its transcript will be deleted. This cannot be undone.`,
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
    this._selectionEpoch++;
    this._selectedId = null;
    this._interactionKey = null;
    this._updateInteractions(this._pendingInteractions);
    this._syncSessionMenu();
    this._eventStream?.stop();
    this._eventStream = null;
    this._renderedTurns = [];
    this._transcriptStore.remove_all();
    this._liveTurn = null;
    this._sessionList.unselect_all();
    this._status.set_title('Select a session');
    this._status.set_description('Choose a conversation from the sidebar.');
    this._status.set_visible(true);
    this._chatScroll.set_visible(false);
    this._loadEarlier.set_visible(false);
    this._composer.set_visible(false);
    if (this._splitView.get_collapsed()) this._splitView.set_show_sidebar(true);
  }

  _showNewSessionDialog() {
    const dialog = new Adw.PreferencesDialog({ title: 'New Session' });
    const page = new Adw.PreferencesPage({
      title: 'New Session',
      icon_name: 'list-add-symbolic',
    });
    const group = new Adw.PreferencesGroup({
      title: 'Conversation',
      description: 'The working directory must be an absolute path on the usher host.',
    });
    const cwd = new Adw.EntryRow({ title: 'Working directory' });
    const model = new Adw.EntryRow({ title: 'Model (optional)' });
    const message = new Adw.EntryRow({ title: 'Initial message' });
    group.add(cwd);
    group.add(model);
    group.add(message);
    page.add(group);
    const actions = new Adw.PreferencesGroup();
    const createRow = new Adw.ActionRow({
      title: 'Create session',
      subtitle: 'Starts the first turn immediately.',
    });
    const create = new Gtk.Button({ label: 'Create', valign: Gtk.Align.CENTER });
    create.add_css_class('suggested-action');
    createRow.add_suffix(create);
    createRow.set_activatable_widget(create);
    actions.add(createRow);
    page.add(actions);
    dialog.add(page);
    create.connect('clicked', async () => {
      const workingDirectory = cwd.get_text().trim();
      const initialMessage = message.get_text().trim();
      if (!workingDirectory || !initialMessage) {
        this._showToast('Working directory and initial message are required');
        return;
      }
      create.set_sensitive(false);
      try {
        const result = await this._api.createSession(
          workingDirectory,
          initialMessage,
          model.get_text().trim()
        );
        dialog.close();
        await this.refresh();
        const row = this._rows.get(result.id);
        if (row) this._sessionList.select_row(row);
        else await this._selectSession(result.id);
      } catch (error) {
        create.set_sensitive(true);
        this._showToast(error.message || String(error));
      }
    });
    dialog.present(this);
  }

  async _selectSession(id) {
    const epoch = ++this._selectionEpoch;
    this._selectedId = id;
    this._eventStream?.stop();
    this._eventStream = null;
    this._liveTurn = null;
    this._renderedTurns = [];
    this._sendInFlight = false;
    this._transcriptStore.remove_all();
    this._setTurnRunning(false);
    this._transcriptLimit = 100;
    this._status.set_title('Loading session…');
    this._status.set_description('');
    this._status.set_visible(true);
    this._chatScroll.set_visible(false);
    this._loadEarlier.set_visible(false);
    this._composer.set_visible(false);
    try {
      const session = await this._api.getSession(id);
      if (this._selectionEpoch !== epoch || this._selectedId !== id) return;
      this._title.set_title(session.title || '(untitled)');
      this._title.set_subtitle(this._displayText(`${session.backend} · ${session.cwd}`, 200));
      this._currentSession = session;
      this._syncAutoApprove();
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
      this._sessionList.unselect_all();
      this._syncSessionMenu();
      this._showError('Could not open session', error);
    }
  }

  // Renders the selected session's pending interactions (tool permission
  // requests and AskUserQuestion) above the composer, one at a time, mirroring
  // the web UI. `list` is the full /api/interactions payload; a keyed
  // comparison skips rebuilds so a poll can't yank buttons out from under a
  // click.
  _updateInteractions(list) {
    this._pendingInteractions = list;
    const here = this._selectedId
      ? list.filter(p => p.session_id === this._selectedId)
      : [];
    const key = here.map(p => p.id).join('\n');
    if (key === this._interactionKey) return;
    this._interactionKey = key;
    let child;
    while ((child = this._permissionBox.get_first_child())) this._permissionBox.remove(child);
    if (!here.length) {
      this._permissionBox.set_visible(false);
      return;
    }
    this._permissionBox.set_visible(true);
    this._permissionBox.append(this._interactionWidget(here[0], here.length));
    this._scrollToBottom();
  }

  _interactionWidget(pending, total) {
    const questions = pending.tool_name === 'AskUserQuestion' &&
      Array.isArray(pending.tool_input?.questions) &&
      pending.tool_input.questions.length > 0
      ? pending.tool_input.questions : null;
    const body = questions
      ? this._askQuestionWidget(pending, questions)
      : this._permissionWidget(pending, total);
    body.set_margin_top(10);
    body.set_margin_bottom(10);
    body.set_margin_start(12);
    body.set_margin_end(12);
    const frame = new Gtk.Frame({ child: body, hexpand: true });
    frame.add_css_class('card');
    frame.add_css_class('permission-card');
    return frame;
  }

  _permissionWidget(pending, total) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    const heading = new Gtk.Label({
      label: `Permission: ${pending.tool_name || pending.event || 'tool'}` +
        (total > 1 ? ` (1 of ${total})` : ''),
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.END,
    });
    heading.add_css_class('heading');
    box.append(heading);

    let inputText = '';
    try { inputText = JSON.stringify(pending.tool_input ?? {}, null, 2); }
    catch (_) { inputText = String(pending.tool_input || ''); }
    const input = new Gtk.Label({
      label: this._displayText(inputText, 4000),
      xalign: 0,
      yalign: 0,
      selectable: true,
      wrap: true,
      wrap_mode: Pango.WrapMode.WORD_CHAR,
    });
    input.add_css_class('monospace');
    input.add_css_class('caption');
    box.append(new Gtk.ScrolledWindow({
      child: input,
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      max_content_height: 150,
      propagate_natural_height: true,
      hexpand: true,
    }));

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

    const respond = (behavior, scope) => this._respondInteraction(
      pending.id,
      { behavior, scope, reason: 'via usher GTK client' },
      buttons
    );
    deny.connect('clicked', () => respond('deny', 'once'));
    allow.connect('clicked', () => respond('allow', 'once'));
    always?.connect('clicked', () => respond('allow', 'session'));
    return box;
  }

  // AskUserQuestion renders as a choice picker instead of allow/deny: picked
  // labels (or free text) go back as `answers`, which the server feeds into
  // the tool's updatedInput. "Ignore" denies, which the agent treats as "skip
  // the question, continue in chat".
  _askQuestionWidget(pending, questions) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    const heading = new Gtk.Label({ label: 'Question from the agent', xalign: 0 });
    heading.add_css_class('heading');
    box.append(heading);

    const state = questions.map(() => ({ selected: new Set(), entry: null, buttons: [] }));
    const answerFor = index => {
      const typed = state[index].entry.get_text().trim();
      if (typed) return typed;
      // Join all selected labels — a single-select question has at most one.
      return [...state[index].selected].sort((a, b) => a - b)
        .map(i => questions[index].options?.[i]?.label || '')
        .filter(Boolean)
        .join(', ');
    };
    let submit = null;
    const recompute = () => submit.set_sensitive(questions.every((_, i) => answerFor(i)));
    let syncing = false;

    questions.forEach((question, qi) => {
      if (question.header) {
        const header = new Gtk.Label({ label: question.header, xalign: 0 });
        header.add_css_class('caption-heading');
        header.add_css_class('dim-label');
        box.append(header);
      }
      const text = new Gtk.Label({
        label: (question.question || '') +
          (question.multiSelect ? ' (select all that apply)' : ''),
        xalign: 0,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
      });
      box.append(text);

      (question.options || []).forEach((option, oi) => {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        content.append(new Gtk.Label({ label: option.label || '', xalign: 0 }));
        if (option.description) {
          const description = new Gtk.Label({
            label: option.description,
            xalign: 0,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
          });
          description.add_css_class('caption');
          description.add_css_class('dim-label');
          content.append(description);
        }
        const button = new Gtk.ToggleButton({ child: content });
        state[qi].buttons.push(button);
        button.connect('toggled', () => {
          if (syncing) return;
          syncing = true;
          if (button.get_active()) {
            if (!question.multiSelect) {
              state[qi].selected.clear();
              state[qi].buttons.forEach((b, i) => { if (i !== oi) b.set_active(false); });
            }
            state[qi].selected.add(oi);
            state[qi].entry.set_text(''); // picking an option clears free text
          } else {
            state[qi].selected.delete(oi);
          }
          syncing = false;
          recompute();
        });
        box.append(button);
      });

      const entry = new Gtk.Entry({
        placeholder_text: 'Or type your own answer…',
        hexpand: true,
      });
      state[qi].entry = entry;
      entry.connect('changed', () => {
        if (syncing) return;
        if (entry.get_text().trim()) { // typing clears the option selection
          syncing = true;
          state[qi].selected.clear();
          state[qi].buttons.forEach(b => b.set_active(false));
          syncing = false;
        }
        recompute();
      });
      box.append(entry);
    });

    const actions = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END });
    const ignore = new Gtk.Button({ label: 'Ignore' });
    submit = new Gtk.Button({ label: 'Answer', sensitive: false });
    submit.add_css_class('suggested-action');
    actions.append(ignore);
    actions.append(submit);
    box.append(actions);

    ignore.connect('clicked', () => this._respondInteraction(
      pending.id,
      {
        behavior: 'deny',
        scope: 'once',
        reason: 'The user declined to answer; continue in the conversation.',
      },
      [ignore, submit]
    ));
    submit.connect('clicked', () => {
      const answers = {};
      questions.forEach((question, qi) => { answers[question.question] = answerFor(qi); });
      this._respondInteraction(
        pending.id,
        { behavior: 'allow', answers, reason: 'via usher GTK client' },
        [ignore, submit]
      );
    });
    return box;
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

  _syncAutoApprove() {
    const enabled = Boolean(this._currentSession?.auto_approve);
    this._updatingAutoApprove = true;
    this._autoApprove.set_active(enabled);
    this._autoApprove.set_label(`Approve: ${enabled ? 'auto' : 'ask'}`);
    this._updatingAutoApprove = false;
  }

  async _toggleAutoApprove() {
    if (this._updatingAutoApprove || !this._selectedId || !this._currentSession) return;
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
    if (!this._selectedId) return;
    try {
      const file = await new Gtk.FileDialog({ title: 'Upload File' }).open(this, null);
      if (!file) return;
      this._upload.set_sensitive(false);
      const [bytes] = await file.load_bytes_async(null);
      const filename = file.get_basename();
      const [contentType] = Gio.content_type_guess(filename, null);
      const result = await this._api.upload(this._selectedId, filename, contentType, bytes);
      const buffer = this._prompt.get_buffer();
      const current = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      buffer.set_text(`${current}${prefix}[file: ${result.path}] `, -1);
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

  async _loadTranscript(id, epoch = this._selectionEpoch) {
    const initialLoad = this._renderedTurns.length === 0;
    const { turns, total } = await this._api.getTranscript(id, this._transcriptLimit);
    if (this._selectionEpoch !== epoch || this._selectedId !== id) return false;
    const incoming = (turns || []).map(turn => ({ key: this._turnKey(turn), turn }));
    let common = 0;
    while (common < incoming.length && common < this._renderedTurns.length &&
           incoming[common].key === this._renderedTurns[common].key) {
      common++;
    }
    while (this._transcriptStore.get_n_items() > common)
      this._transcriptStore.remove(common);
    this._renderedTurns.length = common;
    this._liveTurn = null;
    for (let i = common; i < incoming.length; i++) {
      this._transcriptStore.append(new TranscriptItem(incoming[i].turn, incoming[i].key));
      this._renderedTurns.push(incoming[i]);
    }
    this._scrollToBottom(initialLoad);
    this._loadEarlier.set_visible(total > incoming.length);
    return true;
  }

  async _loadEarlierMessages() {
    this._transcriptLimit += 200;
    this._loadEarlier.set_sensitive(false);
    try {
      await this._loadTranscript(this._selectedId);
    } catch (error) {
      this._showToast(error.message || String(error));
    } finally {
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
  _turnHeader(name, ts, alignEnd) {
    const header = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      halign: alignEnd ? Gtk.Align.END : Gtk.Align.START,
    });
    const who = new Gtk.Label({ label: name });
    who.add_css_class('caption-heading');
    who.add_css_class('dim-label');
    header.append(who);
    const time = new Date(ts || '');
    if (!Number.isNaN(time.getTime())) {
      const stamp = new Gtk.Label({
        label: `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`,
      });
      stamp.add_css_class('caption');
      stamp.add_css_class('dim-label');
      header.append(stamp);
    }
    return header;
  }

  _agentName() {
    const backend = this._currentSession?.backend || '';
    return backend ? backend.charAt(0).toUpperCase() + backend.slice(1) : 'Assistant';
  }

  // A fork is a prefix copy of the transcript up to this turn — edit-copy is
  // the closest icon Adwaita ships (there is no dedicated branch/fork glyph).
  _forkButton(uuid) {
    const button = new Gtk.Button({
      icon_name: 'edit-copy-symbolic',
      valign: Gtk.Align.CENTER,
      tooltip_text: 'Fork the conversation from here',
    });
    button.add_css_class('flat');
    button.add_css_class('dim-label');
    button.connect('clicked', async () => {
      button.set_sensitive(false);
      try {
        await this._forkTurn(uuid);
      } finally {
        button.set_sensitive(true);
      }
    });
    return button;
  }

  async _forkTurn(uuid) {
    if (!this._selectedId) return;
    try {
      const result = await this._api.fork(this._selectedId, uuid);
      await this.refresh();
      const row = this._rows.get(result.id);
      if (row) this._sessionList.select_row(row);
      else await this._selectSession(result.id);
      this._showToast('Forked to a new session');
    } catch (error) {
      this._showToast(error.message || String(error));
    }
  }

  _turnWidget(turn) {
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    outer.set_margin_top(6);
    outer.set_margin_bottom(6);
    outer.set_margin_start(12);
    outer.set_margin_end(12);

    if (turn.role === 'assistant') {
      const header = this._turnHeader(this._agentName(), turn.ts, false);
      if (turn.uuid && !turn.live) header.append(this._forkButton(turn.uuid));
      outer.append(header);
      const flow = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
      for (const part of turn.parts || []) {
        if (part.type === 'tool') {
          flow.append(this._toolWidget(part));
        } else {
          flow.append(markdown.render(part.content || ''));
        }
      }
      if (turn.live && turn.previewText) {
        const preview = markdown.render(turn.previewText);
        preview.add_css_class('dim-label');
        flow.append(preview);
      }
      if (turn.live && !flow.get_first_child()) {
        const thinking = new Gtk.Label({ label: 'Thinking…', xalign: 0 });
        thinking.add_css_class('dim-label');
        flow.append(thinking);
      }
      outer.append(flow);
    } else if (turn.role !== 'user' && turn.role !== 'assistant') {
      // Context-compaction markers and similar system notices: a centered,
      // dim, compact marker instead of a speech bubble.
      const marker = new Gtk.Label({
        label: turn.content || turn.role,
        halign: Gtk.Align.CENTER,
      });
      marker.add_css_class('caption');
      marker.add_css_class('dim-label');
      outer.append(marker);
    } else {
      const name = turn.role === 'user' ? 'You' : (turn.role || 'You');
      outer.append(this._turnHeader(name, turn.ts, true));
      const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
      inner.set_margin_top(8);
      inner.set_margin_bottom(8);
      inner.set_margin_start(12);
      inner.set_margin_end(12);
      inner.append(markdown.render(turn.content || ''));
      const bubble = new Gtk.Box({ halign: Gtk.Align.END });
      bubble.add_css_class('user-bubble');
      bubble.append(inner);
      // Keep the bubble clear of the left edge so even a long prompt still
      // reads as right-aligned speech.
      bubble.set_margin_start(48);
      outer.append(bubble);
    }
    return new Adw.Clamp({
      child: outer,
      maximum_size: 900,
      tightening_threshold: 700,
    });
  }

  _toolWidget(part) {
    const expander = new Gtk.Expander();
    expander.set_label_widget(this._toolHeader(part));
    expander.connect('notify::expanded', () => {
      if (!expander.get_expanded() || expander.get_child()) return;
      const body = markdown.render(part.content || '');
      body.add_css_class('tool-body');
      expander.set_child(body);
    });
    const frame = new Gtk.Frame({ child: expander, hexpand: true });
    frame.add_css_class('tool-card');
    if (/^(Edit|Write)$/i.test(part.toolName || '')) expander.set_expanded(true);
    return frame;
  }

  _toolHeader(part) {
    const full = `${part.toolName || 'Tool'}  ${part.toolTarget || ''}`.trim();
    const label = new Gtk.Label({
      label: this._displayText(full, 160),
      tooltip_text: full,
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.END,
      max_width_chars: 80,
      hexpand: true,
    });
    label.add_css_class('tool-header');
    return label;
  }

  _displayText(value, limit) {
    const text = String(value || '');
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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
      },
      (state, error) => this._setStreamState(state, error)
    );
    this._eventStream.start();
  }

  async _sendMessage() {
    // The in-flight guard matters for Ctrl+Enter, which bypasses the
    // desensitized send button.
    if (!this._selectedId || this._sendInFlight) return;
    const id = this._selectedId;
    const epoch = this._selectionEpoch;
    const buffer = this._prompt.get_buffer();
    const text = buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
    if (!text) return;
    this._sendInFlight = true;
    this._syncComposerActions();
    try {
      await this._api.send(id, text);
      if (this._selectionEpoch === epoch && this._selectedId === id) {
        buffer.set_text('', -1);
        this._setTurnRunning(true);
      }
    } catch (error) {
      if (this._selectionEpoch === epoch && this._selectedId === id) {
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
    this._syncComposerActions();
  }

  _syncComposerActions() {
    this._send.set_visible(!this._turnRunning);
    this._send.set_sensitive(!this._turnRunning && !this._sendInFlight);
    this._cancel.set_visible(this._turnRunning);
    this._cancel.set_sensitive(this._turnRunning);
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
    const localGroup = new Adw.PreferencesGroup({ title: 'Local' });
    if (errorMessage) localGroup.set_description(errorMessage);
    const pathRow = new Adw.EntryRow({ title: 'Binary path' });
    pathRow.set_text(this._servers.embeddedPath);
    localGroup.add(pathRow);

    const isEmbeddedActive = this._currentServer?.id === '__embedded__' && this._started;
    const startRow = new Adw.ActionRow({
      title: isEmbeddedActive ? 'Embedded usher' : 'Start embedded usher',
      subtitle: isEmbeddedActive
        ? '127.0.0.1:17777 · Connected'
        : '127.0.0.1:17777',
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
      this._servers.setEmbeddedPath(path);
      startButton.set_sensitive(false);
      startRow.set_subtitle('Starting…');
      const ok = await this._connectTo({
        id: '__embedded__',
        name: 'Embedded usher',
        url: '',
        binaryPath: path,
      });
      if (ok) {
        this._servers.selectEmbedded();
        dialog.close();
      } else {
        startButton.set_sensitive(true);
        startRow.set_subtitle('Connection failed');
      }
    });
    localGroup.add(startRow);
    page.add(localGroup);

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
      if (serverConfig.id === '__embedded__' && !password) {
        const cookie = deriveAuthCookie();
        if (cookie) this._api.setAuthCookie(cookie);
      }
      if (password) await this._api.login(password);
      const sessions = await this._api.listSessions();
      if (serverConfig.id === '__embedded__') {
        this._servers.selectEmbedded();
      } else {
        const saved = this._servers.upsert(serverConfig);
        this._servers.select(saved.id);
        serverConfig = saved;
      }
      this._currentServer = serverConfig;
      this._sessionsDigest = null;
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
    this._sessionsDigest = null;
    this._sessionsById = new Map();
    this._interactionKey = null;
    this._updateInteractions([]);
    this._syncSessionMenu();
    let child;
    while ((child = this._sessionList.get_first_child())) this._sessionList.remove(child);
    this._rows.clear();
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

  _appendUserTurn(data) {
    if (!data?.content) return;
    const turn = { role: 'user', content: data.content, ts: data.ts || '' };
    const key = this._turnKey(turn);
    if (this._renderedTurns.some(item => item.key === key)) return;
    const item = new TranscriptItem(turn, key);
    const liveIndex = this._liveTurn ? this._transcriptStore.get_n_items() - 1 : -1;
    if (liveIndex >= 0) this._transcriptStore.insert(liveIndex, item);
    else this._transcriptStore.append(item);
    this._renderedTurns.push({ key, turn });
    this._scrollToBottom();
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
    this._refreshLiveTurn();
    this._scrollToBottom();
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
      if (this._liveTurn) {
        this._refreshLiveTurn();
        this._scrollToBottom();
      }
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
    if (count > 0 && typeof this._messages.scroll_to === 'function') {
      this._messages.scroll_to(count - 1, Gtk.ListScrollFlags.NONE, null);
      return;
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
      title: this._displayText(String(message).replace(/\s+/g, ' '), 240),
      timeout: 4,
    }));
  }

  vfunc_close_request() {
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
