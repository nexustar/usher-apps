import GLib from 'gi://GLib';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const configHome = GLib.dir_make_tmp('usher-server-store-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', configHome, true);
const { ServerStore } = await import('../src/server-store.js');

const store = new ServerStore();
assert(store.servers.length === 0, 'store should start empty');
assert(store.embeddedPath === '', 'embedded path should start empty');

// Remote servers
const remote1 = store.upsert({
  name: 'Production',
  url: 'https://usher.example.test/',
});
const remote2 = store.upsert({
  name: 'Dev',
  url: 'http://192.168.1.5:7777',
});
assert(store.servers.length === 2, 'two remote servers should coexist');
assert(store.activeId === remote2.id, 'new server should become active');
assert(remote1.url === 'https://usher.example.test', 'URL should be normalized');

// Embedded path
store.setEmbeddedPath('/opt/usher');
assert(store.embeddedPath === '/opt/usher', 'embedded path should be saved');

store.selectEmbedded();
assert(store.activeId === '__embedded__', 'embedded should be selectable');
assert(store.isEmbeddedActive, 'isEmbeddedActive should be true');
assert(store.active?.id === '__embedded__', 'active should return embedded config');
assert(store.active?.binaryPath === '/opt/usher', 'embedded active should have binaryPath');

// Remote selection
store.select(remote1.id);
assert(store.activeId === remote1.id, 'remote should be selectable');
assert(!store.isEmbeddedActive, 'isEmbeddedActive should be false');
assert(store.active?.name === 'Production', 'active should return remote config');

// Persistence
const reloaded = new ServerStore();
assert(reloaded.servers.length === 2, 'remote servers should persist');
assert(reloaded.embeddedPath === '/opt/usher', 'embedded path should persist');
assert(reloaded.active?.name === 'Production', 'selection should persist');

// Removal
reloaded.remove(remote1.id);
assert(reloaded.servers.length === 1, 'server should be removable');
assert(reloaded.active?.name === 'Dev', 'removal should select a remaining server');

// Select embedded via select()
reloaded.select('__embedded__');
assert(reloaded.isEmbeddedActive, 'select("__embedded__") should work');
