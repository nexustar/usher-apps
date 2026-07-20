import GLib from 'gi://GLib';

import { ApiClient, ApiError } from '../src/api-client.js';

const url = GLib.getenv('USHER_TEST_HANG_URL');
if (!url) throw new Error('USHER_TEST_HANG_URL is required');
const client = new ApiClient(url, 200);
try {
  await client.listSessions();
  throw new Error('hanging request unexpectedly completed');
} catch (error) {
  if (!(error instanceof ApiError) || !error.message.includes('timed out')) throw error;
}
print('hanging API request timed out and became retryable');
