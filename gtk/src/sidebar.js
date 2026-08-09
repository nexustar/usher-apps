// The session list: grouping by directory, archived disclosure, and the
// subagents hanging off their parent.
//
// A GtkListView over list models rather than rows appended to a GtkListBox:
// the view recycles a handful of row widgets instead of building one per
// session, filtering is the model's job, and the directory headings come from
// the view's header factory.
//
// The order is still computed here. Expressing "pinned first, then directories
// by recency, subagents under their parent, archived at the end" as a
// comparator over a heterogeneous list is far less readable than one pass, so
// each item carries the position that pass gave it and the sorters only read
// those numbers back.
//
// The sidebar owns the list widget and the state that only it reads — which
// groups are expanded, how many archived rows have been paged in. Everything
// about the selection stays with the window.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

// Archived sessions come in at this many per click, as in the web sidebar.
const ARCHIVED_PAGE_SIZE = 20;

// Where .navigation-sidebar puts a row's content: 6px of row margin plus 8px
// of row padding. Group headings match it; rows add nothing on top of it.
const ROW_INSET = 14;

// The status icon sits in a slot of its own whether or not the session has
// one to show, so every title starts in the same column. The slot is sized
// for the mark rather than for a full icon: this list is titles, and a wider
// gutter would push every one of them across the sidebar.
const STATUS_SLOT = 10;
const SLOT_GAP = 4;

// Where the titles start, and so where a disclosure row starts too.
const TITLE_INSET = STATUS_SLOT + SLOT_GAP;

// Subagents sit one step further in than their parent's title, which is what
// says they are nested — no marker glyph.
const CHILD_INDENT = TITLE_INSET + 16;

const DOT_STATES = ['permission', 'unread', 'running', 'live'];

// One entry in the list. Sessions, their subagents and the archived
// disclosures all travel as these, because a list view takes one model.
const SidebarItem = GObject.registerClass(
class SidebarItem extends GObject.Object {
  _init(fields) {
    super._init();
    Object.assign(this, fields);
  }
});

// ctx: { selectedId(), searchQuery(), onSelect(id), onContextMenu(),
//        interactionCount(id), isUnread(id) }
export class Sidebar {
  constructor(ctx) {
    this._ctx = ctx;
    this.sessionsById = new Map();
    this.sessionsDigest = null;
    this.expandedSubagents = new Set();
    this.expandedArchived = new Set();
    this.archivedPages = new Map();
    this._subagentCounts = new Map();
    this._archivedCounts = new Map();

    this._store = new Gio.ListStore({ item_type: SidebarItem });
    const sorted = new Gtk.SortListModel({
      model: this._store,
      sorter: Gtk.CustomSorter.new((a, b) => a.order - b.order),
      // Coarser than the sorter above, which is what a section sorter has to
      // be: it reads back the group the same pass assigned.
      section_sorter: Gtk.CustomSorter.new((a, b) => a.sectionOrder - b.sectionOrder),
    });
    this._filtered = new Gtk.FilterListModel({
      model: sorted,
      filter: Gtk.CustomFilter.new(item => this.itemMatches(item)),
    });
    this._selection = new Gtk.SingleSelection({
      model: this._filtered,
      autoselect: false,
      can_unselect: true,
    });

    this.listView = new Gtk.ListView({
      model: this._selection,
      factory: this._rowFactory(),
      header_factory: this._headerFactory(),
      // GtkListBox activates on a single click; a list view does not unless
      // told to, which would leave a session needing a double click to open.
      single_click_activate: true,
    });
    this.listView.add_css_class('navigation-sidebar');
    this.listView.add_css_class('session-list');
    // Activation, not selection, is what opens a session. A selection model
    // moves the selection on its own whenever filtering disturbs which row is
    // current, and treating that as a choice would load a session nobody
    // asked for — and file the draft being typed under it. Activation only
    // comes from a click or Enter, the same split arrow-key navigation wants.
    this.listView.connect('activate', (_view, position) => {
      const item = this._filtered.get_item(position);
      if (!item) return;
      if (item.kind === 'disclosure') return this._activateDisclosure(item);
      if (item.session.id !== this._ctx.selectedId()) {
        this._ctx.onSelect(item.session.id);
      }
    });
    // The context menu has to be reachable without a pointer.
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_controller, keyval, _code, state) => {
      const menuKey = keyval === Gdk.KEY_Menu ||
        (keyval === Gdk.KEY_F10 && (state & Gdk.ModifierType.SHIFT_MASK));
      if (!menuKey) return false;
      const item = this._selection.get_selected_item();
      if (!item || item.kind === 'disclosure') return false;
      this._ctx.onContextMenu(item.session, this.listView, 0, 0);
      return true;
    });
    this.listView.add_controller(keys);

    const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER });
    scroller.set_child(this.listView);
    scroller.set_vexpand(true);

    // A list view has no placeholder of its own, so the empty state is a
    // sibling page: it covers both an empty server and a search that matched
    // nothing.
    this._placeholder = new Gtk.Label({
      label: 'No sessions found',
      margin_top: 12,
      margin_start: ROW_INSET,
      margin_end: ROW_INSET,
      wrap: true,
      xalign: 0,
      valign: Gtk.Align.START,
    });
    this._placeholder.add_css_class('dim-label');
    this.widget = new Gtk.Stack({ vexpand: true });
    this.widget.add_named(scroller, 'list');
    this.widget.add_named(this._placeholder, 'empty');
    this._filtered.connect('items-changed', () => this._syncPlaceholder());
    this._syncPlaceholder();
  }

  _syncPlaceholder() {
    this._placeholder.set_label(this._ctx.searchQuery()
      ? 'No sessions match the search' : 'No sessions found');
    this.widget.set_visible_child_name(
      this._filtered.get_n_items() === 0 ? 'empty' : 'list');
  }

  // One row widget, reused by the view for whatever item lands in it. setup
  // builds the shell once; bind only fills it in, which is the point of a
  // list view — the old list box rebuilt every row on every change.
  _rowFactory() {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, listItem) => {
      const content = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: SLOT_GAP,
      });
      const slot = new Gtk.Box({
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.CENTER,
        hexpand: false,
      });
      slot.set_size_request(STATUS_SLOT, -1);
      // A symbolic icon rather than a bullet character: it is what GNOME uses
      // for a status mark, and it is not at the mercy of the font.
      const dot = new Gtk.Image({
        icon_name: 'io.github.nexustar.Usher-dot-symbolic',
        pixel_size: STATUS_SLOT,
        valign: Gtk.Align.CENTER,
      });
      dot.add_css_class('session-dot');
      slot.append(dot);
      content.append(slot);
      const title = new Gtk.Label({
        xalign: 0,
        hexpand: true,
        single_line_mode: true,
        ellipsize: Pango.EllipsizeMode.END,
      });
      content.append(title);
      const badge = new Gtk.Label({ valign: Gtk.Align.CENTER, visible: false });
      badge.add_css_class('session-count');
      content.append(badge);
      const arrow = new Gtk.Image({
        icon_name: 'pan-up-symbolic', valign: Gtk.Align.CENTER, visible: false,
      });
      arrow.add_css_class('session-disclosure');
      content.append(arrow);
      listItem.set_child(content);
      listItem.parts = { slot, dot, title, badge, arrow, content };

      // The row is read back off the gesture rather than captured: a closure a
      // widget owns that also refers to that widget is a cycle across the JS
      // and GObject heaps, and nothing can collect it.
      const menu = new Gtk.GestureClick({ button: 3 });
      menu.connect('pressed', (gesture, _n, x, y) => {
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        this._openMenuFor(gesture.get_widget(), x, y);
      });
      content.add_controller(menu);
      const held = new Gtk.GestureLongPress({ touch_only: true });
      held.connect('pressed', (gesture, x, y) => {
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        this._openMenuFor(gesture.get_widget(), x, y);
      });
      content.add_controller(held);
    });

    factory.connect('bind', (_f, listItem) => this._bindRow(listItem));
    return factory;
  }

  _bindRow(listItem) {
    const item = listItem.get_item();
    const { slot, dot, title, badge, arrow, content } = listItem.parts;
    content.item = item;
    const child = item.kind === 'subagent';
    const disclosure = item.kind === 'disclosure';

    content.set_margin_start(
      child ? CHILD_INDENT : (disclosure ? TITLE_INSET : 0));
    slot.set_visible(!child && !disclosure);
    arrow.set_visible(disclosure && item.disclosure === 'toggle');
    listItem.set_selectable(!disclosure);
    title.remove_css_class('caption');
    title.remove_css_class('dim-label');
    content.remove_css_class('dim-label');

    if (disclosure) {
      title.add_css_class('caption');
      title.add_css_class('dim-label');
      title.set_label(item.label);
      title.set_tooltip_text(null);
      badge.set_visible(false);
      if (item.disclosure === 'toggle') {
        if (this.expandedArchived.has(item.groupKey)) arrow.remove_css_class('collapsed');
        else arrow.add_css_class('collapsed');
      }
      return;
    }

    const session = item.session;
    title.set_label(item.title);
    title.set_tooltip_text(item.title);
    // Subagents step down in size, not in contrast — dim is what archived
    // looks like. Dimming the content rather than the row keeps the row's
    // selection highlight at full strength.
    if (child) title.add_css_class('caption');
    if (item.archived) content.add_css_class('dim-label');

    const state = this._dotState(session);
    for (const css of DOT_STATES) dot.remove_css_class(css);
    dot.set_visible(Boolean(state));
    if (state) {
      dot.add_css_class(state);
      dot.set_tooltip_text(state === 'permission' ? 'Waiting for a decision'
        : state === 'unread' ? 'New response'
          : state === 'running' ? 'Running' : 'Worker live');
    }

    const waiting = child ? 0 : this._ctx.interactionCount(session.id);
    badge.set_visible(waiting > 0);
    if (waiting > 0) {
      badge.set_label(`${waiting}`);
      badge.set_tooltip_text(
        `${waiting} decision${waiting === 1 ? '' : 's'} waiting`);
    }
  }

  // The directory heading above each section, which the section sorter marks
  // out for the view.
  _headerFactory() {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, header) => {
      const label = new Gtk.Label({
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.MIDDLE,
        max_width_chars: 32,
        margin_top: 12,
        margin_bottom: 4,
        // Lines the heading up with the row content below it.
        margin_start: ROW_INSET,
        margin_end: ROW_INSET,
      });
      label.add_css_class('caption-heading');
      label.add_css_class('dim-label');
      header.set_child(label);
    });
    factory.connect('bind', (_f, header) => {
      const label = header.get_item()?.sectionLabel || '';
      header.get_child().set_label(label);
      header.get_child().set_tooltip_text(label);
      // The gap belongs between groups, not above the first one — where it
      // would just be dead space at the top of the list.
      header.get_child().set_margin_top(header.get_start() === 0 ? 2 : 12);
    });
    return factory;
  }

  _openMenuFor(widget, x, y) {
    const item = widget?.item;
    if (!item || item.kind === 'disclosure') return;
    this._ctx.onContextMenu(item.session, widget, x, y);
  }

  _dotState(session) {
    if (this._ctx.interactionCount(session.id) > 0 ||
        session.status === 'awaiting_permission') return 'permission';
    if (this._ctx.isUnread(session.id)) return 'unread';
    if (session.status === 'running') return 'running';
    if (session.status === 'live') return 'live';
    return '';
  }

  selectSession(id) {
    for (let i = 0; i < this._filtered.get_n_items(); i++) {
      const item = this._filtered.get_item(i);
      if (item.kind !== 'disclosure' && item.session.id === id) {
        this._selection.set_selected(i);
        return true;
      }
    }
    return false;
  }

  unselectAll() {
    this._selection.set_selected(Gtk.INVALID_LIST_POSITION);
  }

  clear() {
    this._store.remove_all();
    this.sessionsById = new Map();
    this.sessionsDigest = null;
  }

  refilter() {
    this._filtered.get_filter().changed(Gtk.FilterChange.DIFFERENT);
    this._syncPlaceholder();
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

    // Skip the write when nothing a row draws has changed. Digesting the raw
    // sessions would rebuild on every poll: their timestamps tick constantly
    // and only matter here through the ordering, which the sorted array
    // already captures.
    const digest = sessions.map(session => [
      session.id, session.title, session.cwd, session.status,
      session.pinned ? 1 : 0, session.archived ? 1 : 0,
      this._ctx.interactionCount(session.id), this._ctx.isUnread(session.id) ? 1 : 0,
      ...(children.get(session.id) || [])
        .map(child => [child.id, child.agent_name || child.title, child.status].join('~')),
    ].join('|')).join('\n');
    if (digest === this.sessionsDigest) return;
    this.sessionsDigest = digest;

    const items = [];
    const sections = new Map();
    this._subagentCounts.clear();
    this._archivedCounts.clear();

    let group = null;
    let archivedInGroup = 0;
    const closeGroup = () => {
      if (group && archivedInGroup) {
        this._archivedCounts.set(group.key, archivedInGroup);
        // Two rows: one that folds the group's archived sessions away, and —
        // once open, while any are still held back — one that pages in the
        // next batch. Rows rather than buttons inside a row, which is how the
        // collapsible sections in GNOME's own sidebars are built.
        for (const disclosure of ['toggle', 'more']) {
          items.push(new SidebarItem({
            kind: 'disclosure',
            disclosure,
            groupKey: group.key,
            order: items.length,
            sectionOrder: group.sectionOrder,
            sectionLabel: group.label,
            label: '',
          }));
        }
      }
      archivedInGroup = 0;
    };

    for (const session of sessions) {
      const key = session.pinned ? 'pinned' : (session.cwd || '(unknown)');
      const label = session.pinned ? 'Pinned' : (session.cwd || '(unknown)');
      if (!sections.has(key)) sections.set(key, sections.size);
      if (group?.key !== key) {
        closeGroup();
        group = { key, label, sectionOrder: sections.get(key) };
      }

      this._subagentCounts.set(session.id, (children.get(session.id) || []).length);
      items.push(new SidebarItem({
        kind: 'session',
        session,
        title: session.title || '(untitled)',
        searchText: `${session.title || ''} ${session.cwd || ''}`.toLowerCase(),
        groupKey: key,
        archived: Boolean(session.archived),
        archivedIndex: session.archived ? archivedInGroup++ : -1,
        order: items.length,
        sectionOrder: group.sectionOrder,
        sectionLabel: label,
      }));

      for (const child of children.get(session.id) || []) {
        items.push(new SidebarItem({
          kind: 'subagent',
          session: child,
          title: child.agent_name || child.title || '(subagent)',
          searchText: `${child.agent_name || child.title || ''}`.toLowerCase(),
          groupKey: key,
          subagentOf: session.id,
          archived: Boolean(session.archived),
          archivedIndex: -1,
          order: items.length,
          sectionOrder: group.sectionOrder,
          sectionLabel: label,
        }));
      }
    }
    closeGroup();
    for (const item of items) {
      if (item.kind === 'disclosure') this._labelDisclosure(item);
    }

    // One splice: the view answers a single items-changed and rebinds only
    // the rows it is showing.
    this._store.splice(0, this._store.get_n_items(), items);
    this.refilter();
  }

  _labelDisclosure(item) {
    item.label = item.disclosure === 'toggle'
      ? `${this._archivedCounts.get(item.groupKey) || 0} archived`
      : `Show ${this._heldBack(item.groupKey)} more`;
  }

  _heldBack(groupKey) {
    if (!this.expandedArchived.has(groupKey)) return 0;
    return Math.max(0, (this._archivedCounts.get(groupKey) || 0) -
      this.archivedVisible(groupKey));
  }

  _activateDisclosure(item) {
    if (item.disclosure === 'toggle') {
      if (this.expandedArchived.has(item.groupKey)) {
        this.expandedArchived.delete(item.groupKey);
        this.archivedPages.delete(item.groupKey);
      } else {
        this.expandedArchived.add(item.groupKey);
        this.archivedPages.set(item.groupKey, ARCHIVED_PAGE_SIZE);
      }
    } else {
      this.archivedPages.set(
        item.groupKey, this.archivedVisible(item.groupKey) + ARCHIVED_PAGE_SIZE);
    }
    for (let i = 0; i < this._store.get_n_items(); i++) {
      const other = this._store.get_item(i);
      if (other.kind === 'disclosure' && other.groupKey === item.groupKey) {
        this._labelDisclosure(other);
      }
    }
    this.refilter();
  }

  subagentCount(sessionId) {
    return this._subagentCounts.get(sessionId) || 0;
  }

  toggleSubagents(sessionId) {
    if (this.expandedSubagents.has(sessionId)) this.expandedSubagents.delete(sessionId);
    else this.expandedSubagents.add(sessionId);
    this.refilter();
    return this.expandedSubagents.has(sessionId);
  }

  archivedVisible(groupKey) {
    return this.archivedPages.get(groupKey) || ARCHIVED_PAGE_SIZE;
  }

  // Archived sessions stay folded into their directory group until that
  // group's disclosure is opened. A search reaches them regardless — looking
  // for something is exactly when a hidden session should turn up — and the
  // disclosure rows step aside while the search is active.
  itemMatches(item) {
    const query = this._ctx.searchQuery();
    if (item.kind === 'disclosure') {
      if (query) return false;
      if (item.disclosure === 'more') return this._heldBack(item.groupKey) > 0;
      return true;
    }
    if (item.kind === 'subagent' && !this.expandedSubagents.has(item.subagentOf)) {
      return false;
    }
    if (query) return Boolean(item.searchText?.includes(query));
    if (!item.archived) return true;
    return this.expandedArchived.has(item.groupKey) &&
      item.archivedIndex < this.archivedVisible(item.groupKey);
  }
}
