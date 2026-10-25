// Session details. Only the extra CLI flags are editable: Claude and Codex
// keep the system prompt a session started with across resumes.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import { formatArgs, parseArgs } from './text.js';

const busy = status => status === 'running' || status === 'awaiting_permission';

// An idle session spawns with the new flags on its next send, a live one has
// to be restarted for them.
const saveLabel = status => (status === 'idle' ? 'Save' : 'Save & Restart');

// A zero time.Time arrives as year 1.
function when(iso) {
  if (!iso || iso.startsWith('0001-')) return '';
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? '' : time.toLocaleString();
}

function confirmRestart(parent) {
  return new Promise(resolve => {
    const dialog = new Adw.AlertDialog({
      heading: 'Restart the session?',
      body: 'Restarting stops this session’s loops and background agents.',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('restart', 'Restart');
    dialog.set_response_appearance('restart', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => resolve(response === 'restart'));
    dialog.present(parent);
  });
}

// context: { api, toast(message), onSaved(id) }
export async function showSessionDetails(parent, id, context) {
  const { api, toast } = context;
  const sess = await api.getSession(id);
  const runtime = sess.runtime || {};
  const editable = !sess.router && !sess.subagent;

  const dialog = new Adw.Dialog({ title: 'Details', content_width: 520 });
  const toolbar = new Adw.ToolbarView();
  const header = new Adw.HeaderBar({ show_end_title_buttons: !editable });
  toolbar.add_top_bar(header);
  const prefs = new Adw.PreferencesPage();
  toolbar.set_content(prefs);
  dialog.set_child(toolbar);

  const facts = new Adw.PreferencesGroup();
  const fact = (title, value) => {
    const row = new Adw.ActionRow({
      title,
      subtitle: value || 'Unavailable',
      subtitle_selectable: Boolean(value),
    });
    row.add_css_class('property');
    facts.add(row);
  };
  fact('Session', sess.id);
  if (sess.subagent) {
    fact('Parent', sess.parent_id);
    fact('Agent', sess.agent_name);
  }
  fact('Status', (sess.status || '').replace(/_/g, ' '));
  fact('Backend', sess.backend);
  fact('Model', runtime.model);
  fact('Effort', runtime.effort);
  fact('Directory', sess.cwd);
  fact('Created', when(sess.started_at));
  fact('Updated', when(sess.last_event_at));
  prefs.add(facts);

  const launch = new Adw.PreferencesGroup({ title: 'Launch Options' });
  const prompt = new Adw.ActionRow({
    title: 'Appended system prompt',
    subtitle: sess.append_system_prompt || 'None',
    subtitle_selectable: Boolean(sess.append_system_prompt),
  });
  prompt.add_css_class('property');
  launch.add(prompt);
  const flags = new Adw.EntryRow({
    title: 'Extra CLI flags',
    text: formatArgs(sess.extra_args),
    editable,
  });
  flags.add_css_class('monospace');
  launch.add(flags);
  if (editable) {
    launch.set_description('Flags added when spawning the backend, quoted as in a shell.');
  } else {
    launch.set_description(sess.router
      ? 'The router session’s flags are set by usher.'
      : 'Subagent transcripts are read-only.');
  }
  prefs.add(launch);

  if (editable) {
    const cancel = new Gtk.Button({ label: 'Cancel' });
    cancel.connect('clicked', () => dialog.close());
    header.pack_start(cancel);
    const save = new Gtk.Button({ label: saveLabel(sess.status), sensitive: !busy(sess.status) });
    save.add_css_class('suggested-action');
    header.pack_end(save);
    save.connect('clicked', async () => {
      let extraArgs;
      try {
        extraArgs = parseArgs(flags.get_text());
      } catch (error) {
        toast(error.message);
        return;
      }
      save.set_sensitive(false);
      try {
        // It may have started a turn since the dialog opened.
        const now = await api.getSession(sess.id);
        if (busy(now.status)) {
          save.set_label(saveLabel(now.status));
          toast('The session is mid-turn; save once it is done');
          return;
        }
        const restart = now.status !== 'idle';
        if (restart && ((now.activity?.loops || []).length || now.activity?.agents) &&
            !await confirmRestart(dialog)) {
          save.set_sensitive(true);
          return;
        }
        await api.patchSession(sess.id, { extra_args: extraArgs });
        if (restart) {
          await api.pauseSession(sess.id);
          await api.resumeSession(sess.id);
        }
        dialog.close();
        context.onSaved?.(sess.id);
      } catch (error) {
        save.set_sensitive(true);
        toast(error.message || String(error));
      }
    });
  }
  dialog.present(parent);
}
