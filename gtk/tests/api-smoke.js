import GLib from 'gi://GLib';

import { ApiClient, ApiError } from '../src/api-client.js';

const url = GLib.getenv('USHER_TEST_URL');
const password = GLib.getenv('USHER_TEST_PASSWORD') || '';
if (!url) throw new Error('USHER_TEST_URL is required');

const client = new ApiClient(url);
if (password) {
  try {
    await client.listSessions();
    throw new Error('password-protected server unexpectedly allowed anonymous API access');
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  await client.login(password);
}

const sessions = await client.listSessions();
if (!Array.isArray(sessions)) throw new Error('session list is not an array');
print(`connected to ${url}: ${sessions.length} sessions`);
