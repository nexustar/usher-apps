import GLib from 'gi://GLib';

export function deriveAuthCookie() {
  const dataDir = resolveDataDir();
  if (!dataDir) return null;

  try {
    const [, secretRaw] = GLib.file_get_contents(
      GLib.build_filenamev([dataDir, 'secret'])
    );
    const secretHex = new TextDecoder().decode(secretRaw).trim();
    const secret = hexToBytes(secretHex);
    if (secret.length < 32) return null;

    const [, authRaw] = GLib.file_get_contents(
      GLib.build_filenamev([dataDir, 'auth.json'])
    );
    const auth = JSON.parse(new TextDecoder().decode(authRaw));
    if (!auth.hash) return null;
    const hashBytes = GLib.base64_decode(auth.hash);

    const hmacHex = GLib.compute_hmac_for_data(
      GLib.ChecksumType.SHA256, secret, hashBytes
    );
    const hmacBytes = hexToBytes(hmacHex);

    return GLib.base64_encode(hmacBytes)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (_) {
    return null;
  }
}

function resolveDataDir() {
  const xdg = GLib.getenv('XDG_DATA_HOME');
  if (xdg) return GLib.build_filenamev([xdg, 'usher']);
  const home = GLib.get_home_dir();
  return home ? GLib.build_filenamev([home, '.local', 'share', 'usher']) : null;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}
