// The session list: grouping by directory, archived disclosure, and the
// subagents hanging off their parent.
//
// The sidebar owns the list widget and the state that only it reads — which
// groups are expanded, how many archived rows have been paged in. Everything
// about the selection stays with the window.

import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

// Archived sessions come in at this many per click, as in the web sidebar.
const ARCHIVED_PAGE_SIZE = 20;

// Where .navigation-sidebar puts a row's content: 6px of row margin plus 8px
// of row padding. Group headings match it; rows add nothing on top of it.
const ROW_INSET = 14;

// The status dot gets a slot of its own so every title starts in one column.
// The auto-approve bolt does not: it is rare, and reserving a column for it
// would push every title across the sidebar to buy alignment on a few rows.
// The web sidebar sets both inline for the same reason.
const STATUS_SLOT = 10;
const SLOT_GAP = 4;

// Where the titles start, and so where a subagent row and a disclosure row
// start too.
const TITLE_INSET = STATUS_SLOT + SLOT_GAP;

// ctx: { selectedId(), searchQuery(), onSelect(id) }
export class Sidebar {
  constructor(ctx) {
    this._ctx = ctx;
    this.rows = new Map();
    this.sessionsById = new Map();
    this.sessionsDigest = null;
    this.expandedSubagents = new Set();
    this.expandedArchived = new Set();
    this.archivedPages = new Map();
    this._subagentCounts = new Map();
    this._disclosures = new Map();
    this.sessionList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
    this.sessionList.add_css_class('navigation-sidebar');
    this.sessionList.add_css_class('session-list');
    this.sessionList.set_filter_func(row => this.rowMatches(row));
    this.sessionList.set_header_func((row, before) => this._setHeader(row, before));
    // Activation, not selection, is what opens a session. GtkListBox moves the
    // selection on its own whenever filtering or a rebuild disturbs which row
    // is current, and treating that as a choice would load a session nobody
    // asked for — and file the draft being typed under it. Activation only
    // comes from a click or Enter, which is the same split arrow-key
    // navigation expects.
    this.sessionList.connect('row-activated', (_list, row) => {
      if (row.onActivate) return row.onActivate();
      if (row.sessionId && row.sessionId !== this._ctx.selectedId()) {
        this._ctx.onSelect(row.sessionId);
      }
    });
    // The context menu has to be reachable without a pointer.
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_controller, keyval, _code, state) => {
      const menuKey = keyval === Gdk.KEY_Menu ||
        (keyval === Gdk.KEY_F10 && (state & Gdk.ModifierType.SHIFT_MASK));
      if (!menuKey) return false;
      const row = this.sessionList.get_selected_row();
      const session = row && this.sessionsById.get(row.sessionId);
      if (!session) return false;
      this._ctx.onContextMenu(session, row, 0, row.get_height() / 2);
      return true;
    });
    this.sessionList.add_controller(keys);
    this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER });
    this.widget.set_child(this.sessionList);
    this.widget.set_vexpand(true);
  }

  _setHeader(row, before) {
    if (before && before.groupKey === row.groupKey) {
      row.set_header(null);
      return;
    }
    const label = new Gtk.Label({
      label: row.groupLabel,
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.MIDDLE,
      max_width_chars: 32,
      tooltip_text: row.groupLabel,
      margin_top: 12,
      margin_bottom: 4,
      // Lines the heading up with the row content below it: rows carry a 6px
      // margin and 8px of padding from .navigation-sidebar.
      margin_start: ROW_INSET,
      margin_end: ROW_INSET,
    });
    label.add_css_class('caption-heading');
    label.add_css_class('dim-label');
    row.set_header(label);
  }

  rowFor(id) {
    return this.rows.get(id);
  }

  select(row) {
    this.sessionList.select_row(row);
  }

  unselectAll() {
    this.sessionList.unselect_all();
  }

  clear() {
    let child;
    while ((child = this.sessionList.get_first_child())) this.sessionList.remove(child);
    this.rows.clear();
    this.sessionsById = new Map();
    this.sessionsDigest = null;
  }

  refilter() {
    this.sessionList.invalidate_filter();
    this.sessionList.invalidate_headers();
  }

  render(all) {
    // Subagents are read-only children of the session that spawned them; they
    // hang off their parent row rather than competing with it in the list.
    const sessions = all.filter(s => !s.is_subagent);
    const children = new Map();
    for (const session of all) {
      if (!session.is_subagent || !session.parent_id) continue;
      if (!children.has(session.parent_id)) children.set(session.parent_id, []);
      children.get(session.parent_id).push(session);
    }

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
      // Archived sessions sit at the end of their group, which is what
      // paging them in from the bottom relies on.
      if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
      return recent(b) - recent(a);
    });

    this.sessionsById = new Map(all.map(session => [session.id, session]));

    // Rebuilding tears down open popovers and selection feedback, so skip
    // the write when the poll delivered identical data. Pending interactions
    // are part of what a row draws, so they are part of what makes it stale.
    const digest = JSON.stringify(all) + all.map(session =>
      `${this._ctx.interactionCount(session.id)}${this._ctx.isUnread(session.id)}`).join(',');
    if (digest === this.sessionsDigest) return;
    this.sessionsDigest = digest;

    let child;
    while ((child = this.sessionList.get_first_child())) this.sessionList.remove(child);
    this.rows.clear();
    this._disclosures.clear();

    // Each directory group ends with its own archived disclosure. It is a real
    // row rather than a filtered-away header control, because a group whose
    // sessions are *all* archived would otherwise disappear entirely, leaving
    // nothing to click.
    let openGroup = null;
    let archivedInGroup = 0;
    const closeGroup = () => {
      if (openGroup === null || !archivedInGroup) {
        openGroup = null;
        archivedInGroup = 0;
        return;
      }
      for (const row of this.archivedRows(openGroup, archivedInGroup)) {
        this.sessionList.append(row);
      }
      openGroup = null;
      archivedInGroup = 0;
    };

    for (const session of sessions) {
      this._subagentCounts.set(session.id, (children.get(session.id) || []).length);
      const row = this._sessionRow(session);
      row.groupKey = session.pinned ? '\u0000pinned' : (session.cwd || '(unknown)');
      row.groupLabel = session.pinned ? 'Pinned' : (session.cwd || '(unknown)');
      if (row.groupKey !== openGroup) closeGroup();
      openGroup = row.groupKey;
      if (session.archived) row.archivedIndex = archivedInGroup++;
      this.sessionList.append(row);
      this.rows.set(session.id, row);

      for (const child of children.get(session.id) || []) {
        const childRow = this._sessionRow(child, { child: true });
        childRow.subagentOf = session.id;
        childRow.groupKey = row.groupKey;
        childRow.groupLabel = row.groupLabel;
        this.sessionList.append(childRow);
        this.rows.set(child.id, childRow);
      }
    }
    closeGroup();
    this.refilter();
  }

  // One row: the leading marks, the title, and — when a session is holding
  // decisions — a count at the end.
  //
  // Per-session actions live in a context menu rather than a button on each
  // row, which is what GTK sidebars do (GNOME Builder's project tree,
  // Fractal's room list); the conversation header offers the same menu.
  _sessionRow(session, { child = false } = {}) {
    const title = child
      ? (session.agent_name || session.title || '(subagent)')
      : (session.title || '(untitled)');
    const row = new Gtk.ListBoxRow({
      activatable: true,
      selectable: true,
      tooltip_text: title,
    });
    row.sessionId = session.id;
    row.searchText = `${title} ${session.cwd || ''}`.toLowerCase();

    // No margins of our own: .navigation-sidebar already insets the row and
    // sets its height.
    const content = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: SLOT_GAP,
      margin_start: child ? TITLE_INSET : 0,
    });
    // A subagent is a read-only child of the turn that spawned it: no state of
    // its own to act on, so no marks — it starts where its parent's title
    // does and the web sidebar's dash is what says it is nested.
    if (!child) {
      content.append(this._slot(STATUS_SLOT, this._statusDot(session)));
      if (session.auto_approve) content.append(this._autoMark());
    }
    const label = new Gtk.Label({
      label: child ? `- ${title}` : title,
      xalign: 0,
      hexpand: true,
      single_line_mode: true,
      ellipsize: Pango.EllipsizeMode.END,
    });
    // Subagents step down in size, not in contrast — dim is what archived
    // looks like.
    if (child) {
      label.add_css_class('caption');
      row.add_css_class('subagent');
    }
    content.append(label);

    const waiting = this._ctx.interactionCount(session.id);
    if (waiting) {
      const badge = new Gtk.Label({ label: `${waiting}`, valign: Gtk.Align.CENTER });
      badge.add_css_class('session-count');
      badge.set_tooltip_text(
        `${waiting} decision${waiting === 1 ? '' : 's'} waiting`);
      content.append(badge);
    }
    row.set_child(content);
    if (session.archived) {
      // On the content, not the row: dimming the row would take its selection
      // highlight with it.
      content.add_css_class('dim-label');
      row.archived = true;
    }

    // The row is read back off the gesture rather than captured: a closure a
    // widget owns that also refers to that widget is a cycle across the JS and
    // GObject heaps, and nothing can collect it. The list rebuilds on every
    // change, so one such row per rebuild is a steady leak.
    const menu = new Gtk.GestureClick({ button: 3 });
    menu.connect('pressed', (gesture, _n, x, y) => {
      // Claim it, or the list box treats the same press as a click on the row.
      gesture.set_state(Gtk.EventSequenceState.CLAIMED);
      this._ctx.onContextMenu(session, gesture.get_widget(), x, y);
    });
    row.add_controller(menu);
    const held = new Gtk.GestureLongPress({ touch_only: true });
    held.connect('pressed', (gesture, x, y) => {
      gesture.set_state(Gtk.EventSequenceState.CLAIMED);
      this._ctx.onContextMenu(session, gesture.get_widget(), x, y);
    });
    row.add_controller(held);
    return row;
  }

  // hexpand must stay off: it would propagate to the slot and let it compete
  // with the title for the row's spare width.
  _slot(width, child) {
    const slot = new Gtk.Box({
      valign: Gtk.Align.CENTER,
      halign: Gtk.Align.CENTER,
      hexpand: false,
    });
    slot.set_size_request(width, -1);
    if (child) slot.append(child);
    return slot;
  }

  // Idle — no process held for the session — shows nothing; the slot stays to
  // keep the titles in one column.
  _statusDot(session) {
    const state = this._ctx.interactionCount(session.id) > 0 ||
      session.status === 'awaiting_permission' ? 'permission'
      : this._ctx.isUnread(session.id) ? 'unread'
        : session.status === 'running' ? 'running'
          : session.status === 'live' ? 'live' : '';
    if (!state) return null;
    const dot = new Gtk.Label({ label: '●', valign: Gtk.Align.CENTER });
    dot.add_css_class('session-dot');
    dot.add_css_class(state);
    dot.set_tooltip_text(state === 'permission' ? 'Waiting for a decision'
      : state === 'unread' ? 'New response'
        : state === 'running' ? 'Running' : 'Worker live');
    return dot;
  }

  // The web sidebar's mark for a session that runs tools unattended.
  _autoMark() {
    const auto = new Gtk.Label({ label: 'ϟ', valign: Gtk.Align.CENTER });
    auto.add_css_class('session-auto');
    auto.set_tooltip_text('Approves tool calls automatically');
    return auto;
  }

  subagentCount(sessionId) {
    return [...this.rows.values()].filter(r => r.subagentOf === sessionId).length ||
      this._subagentCounts.get(sessionId) || 0;
  }

  toggleSubagents(sessionId) {
    if (this.expandedSubagents.has(sessionId)) this.expandedSubagents.delete(sessionId);
    else this.expandedSubagents.add(sessionId);
    // The child rows are always built; only the filter decides who sees them.
    this.refilter();
    return this.expandedSubagents.has(sessionId);
  }

  // The rows that end a directory group: one that folds the group's archived
  // sessions away, and — once it is open and any are still held back — one
  // that pages in the next batch. Rows rather than buttons inside a row: a
  // list entry whose whole job is to be pressed is a row, which is how the
  // collapsible sections in GNOME's own sidebars are built.
  // The pair is kept on the sidebar, not closed over by the rows' handlers: a
  // handler a row owns that refers back to that row (or to its sibling, which
  // refers back in turn) is a cycle across the JS and GObject heaps that
  // nothing can collect. The map is dropped on the next rebuild, so the rows
  // go with it.
  archivedRows(groupKey, count) {
    const arrow = new Gtk.Image({
      icon_name: 'pan-up-symbolic',
      valign: Gtk.Align.CENTER,
    });
    arrow.add_css_class('session-disclosure');
    const toggle = this._disclosureRow(groupKey, arrow, 'toggle');
    const more = this._disclosureRow(groupKey, null, 'more');
    this._disclosures.set(groupKey, { toggle, more, arrow, count });
    this._syncDisclosure(groupKey);
    return [toggle, more];
  }

  _activateDisclosure(groupKey, which) {
    if (which === 'toggle') {
      if (this.expandedArchived.has(groupKey)) {
        this.expandedArchived.delete(groupKey);
        this.archivedPages.delete(groupKey);
      } else {
        this.expandedArchived.add(groupKey);
        this.archivedPages.set(groupKey, ARCHIVED_PAGE_SIZE);
      }
    } else {
      this.archivedPages.set(
        groupKey, this.archivedVisible(groupKey) + ARCHIVED_PAGE_SIZE);
    }
    this._syncDisclosure(groupKey);
    this.refilter();
  }

  _syncDisclosure(groupKey) {
    const group = this._disclosures.get(groupKey);
    if (!group) return;
    const expanded = this.expandedArchived.has(groupKey);
    group.toggle.setLabel(`${group.count} archived`);
    if (expanded) group.arrow.remove_css_class('collapsed');
    else group.arrow.add_css_class('collapsed');
    const held = expanded
      ? Math.max(0, group.count - this.archivedVisible(groupKey)) : 0;
    group.more.setLabel(`Show ${held} more`);
    group.more.set_visible(held > 0);
  }

  _disclosureRow(groupKey, arrow, which) {
    const row = new Gtk.ListBoxRow({ activatable: true, selectable: false });
    row.archivedToggle = true;
    row.groupKey = groupKey;
    row.groupLabel = groupKey;
    row.onActivate = () => this._activateDisclosure(groupKey, which);
    const content = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: SLOT_GAP,
      // Starts where the session titles above it start.
      margin_start: TITLE_INSET,
    });
    const text = new Gtk.Label({ xalign: 0, hexpand: true });
    text.add_css_class('caption');
    text.add_css_class('dim-label');
    content.append(text);
    if (arrow) content.append(arrow);
    row.set_child(content);
    row.setLabel = value => text.set_label(value);
    return row;
  }

  archivedVisible(groupKey) {
    return this.archivedPages.get(groupKey) || ARCHIVED_PAGE_SIZE;
  }

  // Archived sessions stay folded into their directory group until that
  // group's disclosure is opened. A search reaches them regardless — looking
  // for something is exactly when a hidden session should turn up — and the
  // disclosure rows step aside while the search is active.
  rowMatches(row) {
    const query = this._ctx.searchQuery();
    if (row.archivedToggle) return !query;
    if (row.subagentOf && !this.expandedSubagents.has(row.subagentOf)) return false;
    if (query) return Boolean(row.searchText?.includes(query));
    if (!row.archived) return true;
    return this.expandedArchived.has(row.groupKey) &&
      row.archivedIndex < this.archivedVisible(row.groupKey);
  }
}
