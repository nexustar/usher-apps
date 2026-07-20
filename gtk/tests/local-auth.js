import GLib from 'gi://GLib';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Set up a fake data dir with known secret + auth.json
const dataDir = GLib.dir_make_tmp('usher-local-auth-XXXXXX');
const usherDir = GLib.build_filenamev([dataDir, 'usher']);
GLib.mkdir_with_parents(usherDir, 0o700);

// Known values: secret = 32 bytes of 0xAA, hash = 32 bytes of 0xBB (base64)
const secretHex = 'aa'.repeat(32);
GLib.file_set_contents(
  GLib.build_filenamev([usherDir, 'secret']),
  secretHex + '\n'
);

const hashBytes = new Uint8Array(32).fill(0xBB);
const hashBase64 = GLib.base64_encode(hashBytes);
const authJson = JSON.stringify({
  algo: 'argon2id',
  time: 2,
  memory: 65536,
  threads: 4,
  key_len: 32,
  salt: GLib.base64_encode(new Uint8Array(16).fill(0xCC)),
  hash: hashBase64,
});
GLib.file_set_contents(
  GLib.build_filenamev([usherDir, 'auth.json']),
  authJson
);

GLib.setenv('XDG_DATA_HOME', dataDir, true);

const { deriveAuthCookie } = await import('../src/local-auth.js');

// Compute expected: HMAC-SHA256(secret, hashBytes) → base64url no padding
const secret = new Uint8Array(32).fill(0xAA);
const expectedHmacHex = GLib.compute_hmac_for_data(
  GLib.ChecksumType.SHA256, secret, hashBytes
);

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

const expectedCookie = GLib.base64_encode(hexToBytes(expectedHmacHex))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

const cookie = deriveAuthCookie();
assert(cookie === expectedCookie, `cookie mismatch: got ${cookie}, expected ${expectedCookie}`);
assert(cookie.length > 0, 'cookie should be non-empty');
assert(!cookie.includes('+'), 'cookie should use base64url (no +)');
assert(!cookie.includes('/'), 'cookie should use base64url (no /)');
assert(!cookie.includes('='), 'cookie should have no padding');

// No auth.json → null
GLib.unlink(GLib.build_filenamev([usherDir, 'auth.json']));
assert(deriveAuthCookie() === null, 'missing auth.json should return null');
