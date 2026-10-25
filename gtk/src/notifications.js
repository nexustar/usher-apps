// Desktop notifications for what the web client gets as Web Push: a turn that
// ended and a permission request, each skipped for the session on screen.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ellipsize } from './text.js';

// The server's push label: title, else the cwd's last segment, else a short id.
export function sessionLabel(session, id) {
  if (session?.title) return ellipsize(session.title.replace(/\s+/g, ' ').trim(), 60);
  if (session?.cwd) return session.cwd.replace(/\/+$/, '').split('/').pop();
  return id.slice(0, 8);
}

export function notifyTurnDone(app, id, session) {
  const notification = new Gio.Notification();
  notification.set_title(sessionLabel(session, id));
  notification.set_body('Responded');
  notification.set_priority(Gio.NotificationPriority.LOW);
  notification.set_default_action_and_target(
    'app.open-session', GLib.Variant.new_string(id));
  app.send_notification(`turn-${id}`, notification);
}

// Allow and Deny answer once, without opening the window.
export function notifyPermission(app, pending, session) {
  const notification = new Gio.Notification();
  notification.set_title(sessionLabel(session, pending.session_id));
  notification.set_body(pending.tool_name
    ? `Wants to use ${pending.tool_name}` : 'Needs your approval');
  notification.set_priority(Gio.NotificationPriority.HIGH);
  notification.set_default_action_and_target(
    'app.open-session', GLib.Variant.new_string(pending.session_id));
  for (const [label, behavior] of [['Allow', 'allow'], ['Deny', 'deny']]) {
    notification.add_button_with_target(label, 'app.respond-interaction',
      GLib.Variant.new_strv([pending.id, behavior]));
  }
  app.send_notification(`perm-${pending.id}`, notification);
}

export function withdrawPermission(app, id) {
  app.withdraw_notification(`perm-${id}`);
}
