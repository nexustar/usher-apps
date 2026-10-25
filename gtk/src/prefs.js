// Client-side choices kept across restarts, as the web keeps them in
// localStorage.

import GLib from 'gi://GLib';

const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'usher-app']);
const PREFS_FILE = GLib.build_filenamev([CONFIG_DIR, 'prefs.json']);

let cache = null;

function load() {
  if (cache) return cache;
  cache = {};
  try {
    const [ok, contents] = GLib.file_get_contents(PREFS_FILE);
    if (ok) {
      const data = JSON.parse(new TextDecoder().decode(contents));
      if (data && typeof data === 'object' && !Array.isArray(data)) cache = data;
    }
  } catch (_) {
    // Missing or unreadable: defaults apply.
  }
  return cache;
}

export function getPref(key, fallback) {
  const value = load()[key];
  return value === undefined ? fallback : value;
}

export function setPref(key, value) {
  load()[key] = value;
  try {
    GLib.mkdir_with_parents(CONFIG_DIR, 0o700);
    GLib.file_set_contents(PREFS_FILE, JSON.stringify(cache, null, 2));
  } catch (_) {
    // Not kept past this run.
  }
}
