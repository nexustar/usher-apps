// Server passwords in the login keyring.
//
// Without this a password lives only as long as the process, so every launch
// asks again. libsecret is part of the GNOME platform, so this costs nothing
// in a Flatpak; a session with no secret service simply gets no persistence.

import Secret from 'gi://Secret';

import './promises.js';

// One attribute set per server profile. The schema name is the app id so the
// entries are recognisable in a keyring manager.
const SCHEMA = new Secret.Schema(
  'io.github.nexustar.Usher',
  Secret.SchemaFlags.NONE,
  { server: Secret.SchemaAttributeType.STRING }
);

function attributes(serverId) {
  return { server: String(serverId || '') };
}

export async function storePassword(serverId, password, label) {
  if (!serverId || !password) return false;
  try {
    return await Secret.password_store(
      SCHEMA, attributes(serverId), Secret.COLLECTION_DEFAULT,
      label || `usher (${serverId})`, password, null);
  } catch (_) {
    return false; // no secret service, or the user refused to unlock
  }
}

export async function lookupPassword(serverId) {
  if (!serverId) return '';
  try {
    return (await Secret.password_lookup(SCHEMA, attributes(serverId), null)) || '';
  } catch (_) {
    return '';
  }
}

export async function clearPassword(serverId) {
  if (!serverId) return false;
  try {
    return await Secret.password_clear(SCHEMA, attributes(serverId), null);
  } catch (_) {
    return false;
  }
}
