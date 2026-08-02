// The connected server's agent profiles and scheduled tasks.
//
// One AdwPreferencesDialog with a page per section, each item drilling into a
// subpage to edit. Subpages carry Cancel/Save, not a back arrow, so there is
// no dirty-state guard.
//
// Server profiles live elsewhere: they are client-local, and switching one
// changes everything shown here.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

const CRON_PRESETS = [
  ['0 9 * * mon-fri', 'Weekdays 9am'],
  ['0 3 * * *', 'Nightly 3am'],
  ['0 * * * *', 'Hourly'],
  ['0 */6 * * *', 'Every 6 hours'],
];

// ---------- small shared pieces ----------

function addRow(title, onActivate) {
  const row = new Adw.ButtonRow({ title, start_icon_name: 'list-add-symbolic' });
  row.connect('activated', onActivate);
  return row;
}

function confirmDelete(parent, heading, body, onConfirm) {
  const dialog = new Adw.AlertDialog({ heading, body });
  dialog.add_response('cancel', 'Cancel');
  dialog.add_response('delete', 'Delete');
  dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.set_close_response('cancel');
  dialog.connect('response', (_dialog, response) => {
    if (response === 'delete') onConfirm();
  });
  dialog.present(parent);
}

function formSubpage(title, onSave) {
  const page = new Adw.NavigationPage({ title, can_pop: false });
  const toolbar = new Adw.ToolbarView();
  const header = new Adw.HeaderBar({ show_back_button: false });
  const cancel = new Gtk.Button({ label: 'Cancel' });
  const save = new Gtk.Button({ label: 'Save' });
  save.add_css_class('suggested-action');
  header.pack_start(cancel);
  header.pack_end(save);
  toolbar.add_top_bar(header);
  const prefs = new Adw.PreferencesPage();
  toolbar.set_content(prefs);
  page.set_child(toolbar);
  save.connect('clicked', () => onSave(save));
  return { page, prefs, cancel, save };
}

// "Default" (or another placeholder) first, then the ids the server reported.
function choiceRow(title, values, current, placeholder = 'Default') {
  const row = new Adw.ComboRow({
    title,
    model: Gtk.StringList.new([placeholder, ...values.map(v => v.label)]),
  });
  const index = values.findIndex(v => v.value === current);
  row.set_selected(index >= 0 ? index + 1 : 0);
  return {
    row,
    get value() {
      const selected = row.get_selected();
      return selected > 0 ? values[selected - 1].value : '';
    },
    set(value) {
      const at = values.findIndex(v => v.value === value);
      row.set_selected(at >= 0 ? at + 1 : 0);
    },
  };
}

// A text row with a menu of suggestions on its trailing edge — the row-native
// stand-in for the web's <datalist>, used for recent working directories and
// cron presets.
function suggestionRow(title, value, suggestions, tooltip) {
  const row = new Adw.EntryRow({ title });
  row.set_text(value || '');
  if (!suggestions.length) return { row, get value() { return row.get_text().trim(); } };
  const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
  list.add_css_class('boxed-list');
  const popover = new Gtk.Popover({ child: new Gtk.ScrolledWindow({
    child: list, max_content_height: 300, propagate_natural_height: true,
    hscrollbar_policy: Gtk.PolicyType.NEVER,
  }) });
  const button = new Gtk.MenuButton({
    icon_name: 'view-list-symbolic',
    valign: Gtk.Align.CENTER,
    tooltip_text: tooltip,
    popover,
  });
  button.add_css_class('flat');
  for (const [text, label] of suggestions) {
    const item = new Adw.ActionRow({ title: label, subtitle: label === text ? '' : text });
    item.set_activatable(true);
    item.connect('activated', () => {
      row.set_text(text);
      popover.popdown();
    });
    list.append(item);
  }
  list.set_size_request(260, -1);
  row.add_suffix(button);
  return { row, get value() { return row.get_text().trim(); } };
}

function multilineGroup(title, description, text) {
  const group = new Adw.PreferencesGroup({ title, description });
  const view = new Gtk.TextView({
    wrap_mode: Gtk.WrapMode.WORD_CHAR,
    top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8,
  });
  view.get_buffer().set_text(text || '', -1);
  const scroll = new Gtk.ScrolledWindow({
    child: view, min_content_height: 140, max_content_height: 280,
    propagate_natural_height: true,
  });
  scroll.add_css_class('card');
  group.add(scroll);
  return {
    group,
    get value() {
      const buffer = view.get_buffer();
      return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
    },
  };
}

function backendChoices(catalog) {
  return (catalog?.backends || []).map(name => ({ value: name, label: name }));
}

function modelChoices(catalog, backendName) {
  return (catalog?.models?.[backendName] || [])
    .map(model => ({ value: model.id, label: model.display_name || model.id }));
}

// Adds a backend row and a model row to `group`, in that order. The model list
// depends on the chosen backend, so its row is rebuilt on every backend
// change — it must therefore be the last row added to that group.
function backendModelRows(catalog, group, backend, model) {
  const backendInput = choiceRow('Backend', backendChoices(catalog), backend);
  group.add(backendInput.row);
  let modelInput = null;
  const rebuild = (keep) => {
    if (modelInput) group.remove(modelInput.row);
    const chosen = backendInput.value || (catalog?.backends || [])[0] || '';
    modelInput = choiceRow('Model', modelChoices(catalog, chosen), keep);
    group.add(modelInput.row);
  };
  rebuild(model);
  backendInput.row.connect('notify::selected', () => rebuild(''));
  return {
    get backend() { return backendInput.value; },
    get model() { return modelInput ? modelInput.value : ''; },
    setBackend(value) { backendInput.set(value); },
    setModel(value) { modelInput?.set(value); },
  };
}

function agentSummary(agent) {
  return [agent.backend, agent.model, agent.cwd].filter(Boolean).join(' · ') ||
    'No defaults set';
}

// When the runner will start a task next. "Overdue" is the one place a stopped
// runner becomes visible, so it is worth saying out loud.
function nextRunText(task, timezone) {
  if (!task?.enabled) return 'Paused';
  if (!task.next_run) return 'Never';
  const when = new Date(task.next_run);
  if (Number.isNaN(when.getTime())) return 'Never';
  const stamp = when.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const suffix = when < new Date() ? ' (overdue, runs shortly)' : '';
  return `${stamp}${timezone ? ` ${timezone}` : ''}${suffix}`;
}

// ---------- the dialog ----------

// `context` carries what the pages need from the window: the api client, a
// toast function, recent working directories to suggest, and a callback for
// when running a task starts a session.
export async function showSettingsDialog(parent, context) {
  const { api, toast } = context;
  const dialog = new Adw.PreferencesDialog({ title: 'Settings' });

  const state = { catalog: null, agents: [], schedules: [], timezone: '' };
  const cwdSuggestions = (context.recentCwds || []).map(cwd => [cwd, cwd]);

  // Page names match the web dialog's pane ids, so a section can be addressed
  // the same way in both clients.
  const agentsPage = new Adw.PreferencesPage({
    title: 'Agents', icon_name: 'system-users-symbolic', name: 'agents',
  });
  const agentsGroup = new Adw.PreferencesGroup({
    title: 'Agent profiles',
    description: 'Reusable defaults for new sessions and scheduled tasks.',
  });
  agentsPage.add(agentsGroup);

  const schedulesPage = new Adw.PreferencesPage({
    title: 'Scheduled', icon_name: 'alarm-symbolic', name: 'scheduled',
  });
  const schedulesGroup = new Adw.PreferencesGroup({ title: 'Scheduled tasks' });
  schedulesPage.add(schedulesGroup);

  dialog.add(agentsPage);
  dialog.add(schedulesPage);

  // ----- data -----

  const loadAll = async () => {
    const [catalog, agentList, scheduleList] = await Promise.all([
      api.listModels().catch(() => null),
      api.listAgents().catch(() => ({ agents: [] })),
      api.listSchedules().catch(() => ({ schedules: [] })),
    ]);
    state.catalog = catalog;
    state.agents = agentList?.agents || [];
    state.schedules = scheduleList?.schedules || [];
    state.timezone = scheduleList?.timezone || '';
  };

  // ----- agents -----

  const agentRows = [];
  const renderAgents = () => {
    for (const row of agentRows.splice(0)) agentsGroup.remove(row);
    for (const agent of state.agents) {
      const row = new Adw.ActionRow({
        title: agent.name,
        subtitle: agentSummary(agent),
        activatable: true,
      });
      row.add_suffix(new Gtk.Image({
        icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER,
      }));
      row.connect('activated', () => dialog.push_subpage(agentForm(agent)));
      agentRows.push(row);
      agentsGroup.add(row);
    }
    const add = addRow('Add Agent', () => dialog.push_subpage(agentForm(null)));
    agentRows.push(add);
    agentsGroup.add(add);
  };

  const saveAgent = async (button, original, profile, { duplicate = false } = {}) => {
    if (!profile.name) {
      toast('An agent needs a name');
      return;
    }
    button.set_sensitive(false);
    try {
      if (original && !duplicate) await api.updateAgent(original.name, profile);
      else await api.createAgent(profile);
      dialog.pop_subpage();
      await loadAll();
      renderAgents();
      renderSchedules();
      toast(duplicate ? 'Agent duplicated' : (original ? 'Agent updated' : 'Agent created'));
    } catch (error) {
      button.set_sensitive(true);
      toast(error.message || String(error));
    }
  };

  const agentForm = (agent) => {
    const { page, prefs, cancel } = formSubpage(
      agent ? 'Edit Agent' : 'New Agent',
      button => saveAgent(button, agent, collect())
    );
    cancel.connect('clicked', () => dialog.pop_subpage());

    const identity = new Adw.PreferencesGroup();
    const nameRow = new Adw.EntryRow({ title: 'Name' });
    nameRow.set_text(agent?.name || '');
    identity.add(nameRow);
    const cwdInput = suggestionRow(
      'Working directory', agent?.cwd, cwdSuggestions, 'Recent working directories'
    );
    identity.add(cwdInput.row);
    prefs.add(identity);

    const runtime = new Adw.PreferencesGroup({ title: 'Runtime' });
    const pickers = backendModelRows(
      state.catalog, runtime, agent?.backend || '', agent?.model || ''
    );
    const approveRow = new Adw.SwitchRow({
      title: 'Auto-approve tool calls',
      subtitle: 'Sessions from this agent start with permission prompts off.',
      active: Boolean(agent?.auto_approve),
    });
    runtime.add(approveRow);
    prefs.add(runtime);

    const prompt = multilineGroup(
      'Append system prompt',
      'Additional instructions for sessions created with this agent.',
      agent?.append_system_prompt
    );
    prefs.add(prompt.group);

    const collect = () => ({
      name: nameRow.get_text().trim(),
      cwd: cwdInput.value,
      backend: pickers.backend,
      model: pickers.model,
      append_system_prompt: prompt.value,
      auto_approve: approveRow.get_active(),
    });

    if (agent) {
      const actions = new Adw.PreferencesGroup();
      const duplicate = new Adw.ButtonRow({ title: 'Duplicate' });
      duplicate.connect('activated', () => {
        const copy = collect();
        copy.name = `${copy.name}-copy`;
        saveAgent(duplicate, agent, copy, { duplicate: true });
      });
      actions.add(duplicate);
      const remove = new Adw.ButtonRow({ title: 'Delete Agent' });
      remove.add_css_class('destructive-action');
      remove.connect('activated', () => confirmDelete(
        parent,
        `Delete “${agent.name}”?`,
        'Sessions already created from this agent are unaffected.',
        async () => {
          try {
            await api.deleteAgent(agent.name);
            dialog.pop_subpage();
            await loadAll();
            renderAgents();
            renderSchedules();
            toast('Agent deleted');
          } catch (error) {
            toast(error.message || String(error));
          }
        }
      ));
      actions.add(remove);
      prefs.add(actions);
    }
    return page;
  };

  // ----- scheduled tasks -----

  // The switch saves on the spot — being one click is the whole reason it sits
  // in the list — and writes the answer back into the cached task, so a form
  // opened later does not submit a stale `enabled`.
  const toggleSchedule = async (task, enabled, widget) => {
    widget.set_sensitive(false);
    try {
      const updated = await api.updateSchedule(task.id, { ...task, enabled });
      Object.assign(task, updated);
      renderSchedules();
    } catch (error) {
      toast(error.message || String(error));
      renderSchedules();
    } finally {
      widget.set_sensitive(true);
    }
  };

  const scheduleRows = [];
  const renderSchedules = () => {
    schedulesGroup.set_description(state.timezone
      ? `Times are interpreted in the server's zone (${state.timezone}).`
      : 'Each task starts a session on its schedule.');
    for (const row of scheduleRows.splice(0)) schedulesGroup.remove(row);
    for (const task of state.schedules) {
      const row = new Adw.ActionRow({
        title: task.name || task.cron,
        subtitle: `${task.cron} · ${nextRunText(task, state.timezone)}`,
        activatable: true,
      });
      const toggle = new Gtk.Switch({
        active: Boolean(task.enabled),
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Enabled',
      });
      toggle.connect('state-set', (_widget, value) => {
        if (value !== Boolean(task.enabled)) toggleSchedule(task, value, toggle);
        return false;
      });
      row.add_suffix(toggle);
      row.add_suffix(new Gtk.Image({
        icon_name: 'go-next-symbolic', valign: Gtk.Align.CENTER,
      }));
      row.connect('activated', () => dialog.push_subpage(scheduleForm(task)));
      scheduleRows.push(row);
      schedulesGroup.add(row);
    }
    const add = addRow('Add Task', () => dialog.push_subpage(scheduleForm(null)));
    scheduleRows.push(add);
    schedulesGroup.add(add);
  };

  const scheduleForm = (task) => {
    const { page, prefs, cancel } = formSubpage(
      task ? 'Edit Task' : 'New Task',
      async (button) => {
        const payload = collect();
        if (!payload.name) { toast('A task needs a name'); return; }
        if (!payload.cron) { toast('A task needs a schedule'); return; }
        if (!payload.prompt) { toast('A task needs a prompt to send'); return; }
        button.set_sensitive(false);
        try {
          if (task) await api.updateSchedule(task.id, payload);
          else await api.createSchedule(payload);
          dialog.pop_subpage();
          await loadAll();
          renderSchedules();
          toast(task ? 'Task updated' : 'Task created');
        } catch (error) {
          button.set_sensitive(true);
          toast(error.message || String(error));
        }
      }
    );
    cancel.connect('clicked', () => dialog.pop_subpage());

    const basics = new Adw.PreferencesGroup();
    const nameRow = new Adw.EntryRow({ title: 'Name' });
    nameRow.set_text(task?.name || '');
    basics.add(nameRow);
    prefs.add(basics);

    const when = new Adw.PreferencesGroup({
      title: 'Schedule',
      description: state.timezone
        ? `minute hour day month weekday — in the server's zone (${state.timezone})`
        : 'minute hour day month weekday',
    });
    const cronInput = suggestionRow(
      'Cron', task?.cron || CRON_PRESETS[0][0],
      CRON_PRESETS.map(([expr, label]) => [expr, label]), 'Common schedules'
    );
    when.add(cronInput.row);
    const enabledRow = new Adw.SwitchRow({
      title: 'Enabled',
      active: task ? Boolean(task.enabled) : true,
    });
    when.add(enabledRow);
    if (task) {
      const status = new Adw.ActionRow({ title: 'Next run' });
      const value = new Gtk.Label({ label: nextRunText(task, state.timezone) });
      value.add_css_class('dim-label');
      status.add_suffix(value);
      when.add(status);
    }
    prefs.add(when);

    const target = new Adw.PreferencesGroup({
      title: 'Target',
      description: 'An agent supplies whatever is left empty here.',
    });
    const agentInput = choiceRow(
      'Agent',
      state.agents.map(a => ({ value: a.name, label: a.name })),
      task?.agent || '',
      'None'
    );
    target.add(agentInput.row);
    const cwdInput = suggestionRow(
      'Working directory', task?.cwd, cwdSuggestions, 'Recent working directories'
    );
    target.add(cwdInput.row);
    const pickers = backendModelRows(
      state.catalog, target, task?.backend || '', task?.model || ''
    );
    prefs.add(target);

    // Picking an agent fills in the fields that agent has an opinion about,
    // and leaves the rest alone.
    agentInput.row.connect('notify::selected', () => {
      const chosen = state.agents.find(a => a.name === agentInput.value);
      if (!chosen) return;
      if (chosen.cwd) cwdInput.row.set_text(chosen.cwd);
      if (chosen.backend) pickers.setBackend(chosen.backend);
      if (chosen.model) pickers.setModel(chosen.model);
    });

    const prompt = multilineGroup(
      'Prompt', 'The message each run starts its session with.', task?.prompt
    );
    prefs.add(prompt.group);

    const collect = () => ({
      name: nameRow.get_text().trim(),
      cron: cronInput.value,
      enabled: enabledRow.get_active(),
      agent: agentInput.value,
      cwd: cwdInput.value,
      backend: pickers.backend,
      model: pickers.model,
      prompt: prompt.value,
    });

    if (task) {
      const actions = new Adw.PreferencesGroup();
      const run = new Adw.ButtonRow({ title: 'Run Now' });
      run.connect('activated', async () => {
        run.set_sensitive(false);
        try {
          const result = await api.runSchedule(task.id);
          toast('Task started');
          if (result?.session_id) {
            dialog.close();
            context.onSessionStarted?.(result.session_id);
          }
        } catch (error) {
          toast(error.message || String(error));
        } finally {
          run.set_sensitive(true);
        }
      });
      actions.add(run);
      const remove = new Adw.ButtonRow({ title: 'Delete Task' });
      remove.add_css_class('destructive-action');
      remove.connect('activated', () => confirmDelete(
        parent,
        `Delete “${task.name || task.cron}”?`,
        'The task stops running. Sessions it already created are unaffected.',
        async () => {
          try {
            await api.deleteSchedule(task.id);
            dialog.pop_subpage();
            await loadAll();
            renderSchedules();
            toast('Task deleted');
          } catch (error) {
            toast(error.message || String(error));
          }
        }
      ));
      actions.add(remove);
      prefs.add(actions);
    }
    return page;
  };

  // An AdwPreferencesDialog measures itself when shown, so it is only
  // presented once its rows exist.
  await loadAll();
  renderAgents();
  renderSchedules();
  if (context.page) dialog.set_visible_page_name(context.page);
  dialog.present(parent);
}
