import GLib from 'gi://GLib';

import { ApiClient } from '../src/api-client.js';
import { EventStream } from '../src/event-stream.js';

const url = GLib.getenv('USHER_TEST_URL');
const password = GLib.getenv('USHER_TEST_PASSWORD') || '';
if (!url) throw new Error('USHER_TEST_URL is required');

const client = new ApiClient(url);
if (password) await client.login(password);
const sessions = await client.listSessions();
if (!sessions.length) throw new Error('SSE smoke test needs at least one session');

let stream;
const event = await Promise.race([
  new Promise(resolve => {
    stream = new EventStream(
      client.session,
      client.eventsUrl(sessions[0].id),
      name => {
        if (name === 'turn.idle' || name === 'turn.active') resolve(name);
      }
    );
    stream.start();
  }),
  new Promise((_resolve, reject) => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
      reject(new Error('timed out waiting for SSE snapshot'));
      return GLib.SOURCE_REMOVE;
    });
  }),
]);
stream.stop();
print(`received SSE event: ${event}`);
