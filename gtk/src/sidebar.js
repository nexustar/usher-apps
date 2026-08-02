// The session list: grouping by directory, archived disclosure, and the
// subagents hanging off their parent.
//
// The sidebar owns the list widget and the state that only it reads — which
// groups are expanded, how many archived rows have been paged in. Everything
// about the selection stays with the window.

import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

// Archived sessions come in at this many per click, as in the web sidebar.
const ARCHIVED_PAGE_SIZE = 20;

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
    this.sessionList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
    this.sessionList.add_css_class('navigation-sidebar');
    this.sessionList.set_filter_func(row => this.rowMatches(row));
    this.sessionList.set_header_func((row, before) => this._setHeader(row, before));
    this.sessionList.connect('row-selected', (_list, row) => {
      if (row?.sessionId && row.sessionId !== this._ctx.selectedId()) {
        this._ctx.onSelect(row.sessionId);
      }
    });
    // A disclosure row is not selectable, so it answers to activation.
    this.sessionList.connect('row-activated', (_list, row) => row.toggleArchived?.());
    this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER });
    this.widget.set_child(this.sessionList);
    this.widget.set_vexpand(true);
  }

  _setHeader(row, before) {
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
    // the write when the poll delivered identical data.
    const digest = JSON.stringify(all);
    if (digest === this.sessionsDigest) return;
    this.sessionsDigest = digest;

    let child;
    while ((child = this.sessionList.get_first_child())) this.sessionList.remove(child);
    this.rows.clear();

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
      this.sessionList.append(this.archivedToggleRow(openGroup, archivedInGroup));
      openGroup = null;
      archivedInGroup = 0;
    };

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
      if (row.groupKey !== openGroup) closeGroup();
      openGroup = row.groupKey;
      if (session.archived) row.archivedIndex = archivedInGroup++;
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
        rowContent.append(new Gtk.Image({
          icon_name: 'folder-symbolic',
          tooltip_text: 'Archived',
          valign: Gtk.Align.CENTER,
        }));
      }
      const spawned = children.get(session.id) || [];
      if (spawned.length) {
        const expanded = this.expandedSubagents.has(session.id);
        const disclose = new Gtk.ToggleButton({
          icon_name: expanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
          active: expanded,
          valign: Gtk.Align.CENTER,
          tooltip_text: `${spawned.length} subagent${spawned.length > 1 ? 's' : ''}`,
        });
        disclose.add_css_class('flat');
        disclose.connect('toggled', () => {
          if (disclose.get_active()) this.expandedSubagents.add(session.id);
          else this.expandedSubagents.delete(session.id);
          disclose.set_icon_name(
            disclose.get_active() ? 'pan-down-symbolic' : 'pan-end-symbolic');
          this.sessionList.invalidate_filter();
        });
        rowContent.prepend(disclose);
      }
      this.sessionList.append(row);
      this.rows.set(session.id, row);

      for (const child of spawned) {
        const childRow = new Gtk.ListBoxRow({
          activatable: true,
          selectable: true,
          tooltip_text: child.title || child.agent_name || '(subagent)',
        });
        const childContent = new Gtk.Box({
          orientation: Gtk.Orientation.HORIZONTAL,
          spacing: 6,
          margin_top: 4,
          margin_bottom: 4,
          margin_start: 30,
          margin_end: 8,
        });
        childContent.append(new Gtk.Image({
          icon_name: 'system-users-symbolic', valign: Gtk.Align.CENTER,
        }));
        const childTitle = new Gtk.Label({
          label: child.agent_name || child.title || '(subagent)',
          xalign: 0,
          hexpand: true,
          single_line_mode: true,
          ellipsize: Pango.EllipsizeMode.END,
        });
        childContent.append(childTitle);
        childRow.set_child(childContent);
        childRow.add_css_class('dim-label');
        childRow.sessionId = child.id;
        childRow.subagentOf = session.id;
        childRow.groupKey = row.groupKey;
        childRow.groupLabel = row.groupLabel;
        childRow.searchText = `${child.agent_name || ''} ${child.title || ''}`.toLowerCase();
        this.sessionList.append(childRow);
        this.rows.set(child.id, childRow);
      }
    }
    closeGroup();
    this.refilter();
  }

  archivedToggleRow(groupKey, count) {
    const row = new Gtk.ListBoxRow({ activatable: false, selectable: false });
    row.archivedToggle = true;
    row.groupKey = groupKey;
    row.groupLabel = groupKey;
    const content = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 4,
      margin_top: 2,
      margin_bottom: 6,
      margin_start: 4,
      margin_end: 8,
    });
    row.set_child(content);

    const rebuild = () => {
      let child;
      while ((child = content.get_first_child())) content.remove(child);
      const expanded = this.expandedArchived.has(groupKey);
      const remaining = expanded
        ? Math.max(0, count - this.archivedVisible(groupKey)) : 0;
      const add = (icon, label, onClick) => {
        const button = new Gtk.Button();
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
        if (icon) box.append(new Gtk.Image({ icon_name: icon, valign: Gtk.Align.CENTER }));
        const text = new Gtk.Label({ label });
        text.add_css_class('caption');
        box.append(text);
        button.set_child(box);
        button.add_css_class('flat');
        button.add_css_class('dim-label');
        button.connect('clicked', () => {
          onClick();
          rebuild();
          this.sessionList.invalidate_filter();
        });
        content.append(button);
      };
      if (!expanded) {
        add('pan-end-symbolic', `${count} archived`, () => {
          this.expandedArchived.add(groupKey);
          this.archivedPages.set(groupKey, ARCHIVED_PAGE_SIZE);
        });
        return;
      }
      add('pan-down-symbolic', 'Collapse', () => {
        this.expandedArchived.delete(groupKey);
        this.archivedPages.delete(groupKey);
      });
      if (remaining) {
        add('', `Show ${remaining} more`, () => {
          this.archivedPages.set(
            groupKey, this.archivedVisible(groupKey) + ARCHIVED_PAGE_SIZE);
        });
      }
    };
    rebuild();
    return row;
  }

  archivedVisible(groupKey) {
    return this.archivedPages.get(groupKey) || ARCHIVED_PAGE_SIZE;
  }

  _filterSessions() {
    this.sessionList.invalidate_filter();
    this.sessionList.invalidate_headers();
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
