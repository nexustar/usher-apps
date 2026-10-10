import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { BackendProcess } from '../src/backend-process.js';
import { UsherWindow } from '../src/window.js';
import * as markdown from '../src/markdown.js';
import { installStyles } from '../src/style.js';

const url = GLib.getenv('USHER_TEST_URL');
if (!url) throw new Error('USHER_TEST_URL is required');

const app = new Adw.Application({
  application_id: 'io.github.nexustar.Usher.SwitchTest',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.register(null);
installStyles();
const backend = new BackendProcess();
backend.configure({ binaryPath: '/tmp/fake-usher', port: 18765, url: '' });
if (backend.baseUrl !== 'http://127.0.0.1:18765') {
  throw new Error(`embedded port did not determine base URL: ${backend.baseUrl}`);
}
backend.configure({ url, binaryPath: '' });
const window = new UsherWindow({ application: app, backend });
window.present();
const markdownWidget = markdown.render(
  '# Heading\n\nA **bold** [safe](https://example.com) [unsafe](javascript:alert(1)) link.\n\n' +
  '- one\n- two\n\n| Name | Value |\n| --- | ---: |\n| answer | 42 |\n\n' +
  '```js\nconst answer = 42;\n```'
);
if (!markdownWidget.get_first_child()) throw new Error('markdown renderer produced no widgets');
const sessions = await window._api.listSessions();
if (sessions.length < 2) throw new Error('switch smoke test needs two sessions');
window._renderSessions(sessions);
const actions = window._sessionMenuModel(sessions[0]);
if (actions.get_n_items() < 2) {
  throw new Error('session action menu was not constructed');
}
const toolWidget = window._transcript.toolWidget({
  type: 'tool', tool_name: 'Read', tool_target: '/tmp/example.js',
  content: 'const answer = 42;',
});
if (!toolWidget.has_css_class('tool-card')) throw new Error('tool card style was not applied');
const archived = sessions.find(session => session.archived);
if (archived) {
  let found = false;
  for (let i = 0; i < window._sidebar._store.get_n_items(); i++) {
    const item = window._sidebar._store.get_item(i);
    if (item.kind !== 'disclosure' && item.session.id === archived.id) found = true;
  }
  if (!found) throw new Error('archived session is missing from the list model');
}

await window._selectSession('missing-session-for-retry-test');
if (window._selectedId !== null) {
  throw new Error('failed session load did not clear selection for retry');
}

const first = window._selectSession(sessions[0].id);
const second = window._selectSession(sessions[1].id);
await Promise.all([first, second]);
if (window._selectedId !== sessions[1].id) {
  throw new Error('an older selection replaced the latest session');
}
if (!window._eventStream?._url.includes(encodeURIComponent(sessions[1].id))) {
  throw new Error('the event stream does not belong to the latest session');
}

window._showConnectionDialog();
window._eventStream.stop();
window.close();
backend.stop();
print('rapid session switch kept the latest session and SSE stream');
