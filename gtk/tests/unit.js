// Behaviour that needs neither a server nor a display.

import GLib from 'gi://GLib';

import { describe, it, expect, run } from './harness.js';
import { fileRef } from '../src/window.js';
import { ellipsize } from '../src/text.js';

GLib.setenv('XDG_CONFIG_HOME', GLib.dir_make_tmp('usher-unit-XXXXXX'), true);
const { DEFAULT_EMBEDDED_PORT, ServerStore } = await import('../src/server-store.js');
const { isSandboxed } = await import('../src/backend-process.js');

describe('ellipsize', () => {
  it('leaves a short string alone', () => {
    expect(ellipsize('hello', 10)).toBe('hello');
  });

  it('marks the cut', () => {
    expect(ellipsize('abcdefghij', 5)).toBe('abcd…');
  });

  it('survives a missing value', () => {
    expect(ellipsize(null, 5)).toBe('');
  });
});

describe('embedded server profile', () => {
  it('defaults to a port usher itself never uses', () => {
    // usher's own default is 7777; colliding would adopt the user's instance.
    expect(DEFAULT_EMBEDDED_PORT).toBe(17777);
  });

  it('keeps the port across reloads', () => {
    const store = new ServerStore();
    store.setEmbeddedPath('/opt/usher');
    store.setEmbeddedPort(19001);
    store.selectEmbedded();
    expect(new ServerStore().embeddedPort).toBe(19001);
    expect(store.active.port).toBe(19001);
  });

  it('refuses a port outside the valid range', () => {
    const store = new ServerStore();
    store.setEmbeddedPort(70000);
    expect(store.embeddedPort).toBe(DEFAULT_EMBEDDED_PORT);
  });

  it('normalises remote URLs and activates the newest', () => {
    const store = new ServerStore();
    const first = store.upsert({ name: 'A', url: 'https://a.test/' });
    const second = store.upsert({ name: 'B', url: 'http://b.test:7777' });
    expect(first.url).toBe('https://a.test');
    expect(store.activeId).toBe(second.id);
  });
});

describe('bundled backend discovery', () => {
  // server-store resolves its config path once, at import, so a test cannot
  // move XDG_CONFIG_HOME out from under it — it clears the file instead.
  const configFile = GLib.build_filenamev(
    [GLib.get_user_config_dir(), 'usher-app', 'servers.json']);
  const withEnv = (value, body) => {
    GLib.unlink(configFile);
    const before = GLib.getenv('USHER_BUNDLED_BACKEND');
    GLib.setenv('USHER_BUNDLED_BACKEND', value, true);
    try { return body(); } finally {
      GLib.unlink(configFile);
      if (before) GLib.setenv('USHER_BUNDLED_BACKEND', before, true);
      else GLib.unsetenv('USHER_BUNDLED_BACKEND');
    }
  };

  it('adopts a bundled binary as the default path', () => {
    withEnv('/bin/sh', () => expect(new ServerStore().embeddedPath).toBe('/bin/sh'));
  });

  it('ignores a path that is not executable', () => {
    withEnv('/definitely/not/here', () => expect(new ServerStore().embeddedPath).toBe(''));
  });

  it('ignores the bundle inside a sandbox, where nothing can be spawned', () => {
    GLib.setenv('FLATPAK_ID', 'test', true);
    try {
      withEnv('/bin/sh', () => expect(new ServerStore().embeddedPath).toBe(''));
    } finally {
      GLib.unsetenv('FLATPAK_ID');
    }
  });

  it('lets a path the user typed win', () => {
    withEnv('/bin/sh', () => {
      const store = new ServerStore();
      store.setEmbeddedPath('/opt/mine/usher');
      expect(new ServerStore().embeddedPath).toBe('/opt/mine/usher');
    });
  });
});

describe('sandbox detection', () => {
  it('is false on an ordinary system', () => {
    expect(isSandboxed()).toBeFalsy();
  });

  it('follows FLATPAK_ID', () => {
    GLib.setenv('FLATPAK_ID', 'test', true);
    try {
      expect(isSandboxed()).toBeTruthy();
    } finally {
      GLib.unsetenv('FLATPAK_ID');
    }
  });
});

describe('what an upload drops into the message box', () => {
  it('references an image as markdown so the transcript renders it', () => {
    expect(fileRef('/tmp/u/shot.png')).toBe('![shot.png](/tmp/u/shot.png)');
    expect(fileRef('/tmp/u/a.JPEG')).toBe('![a.JPEG](/tmp/u/a.JPEG)');
  });

  it('wraps a path with a space in the angle-bracket form', () => {
    expect(fileRef('/tmp/u/my shot.png')).toBe('![my shot.png](</tmp/u/my shot.png>)');
  });

  it('leaves anything else as a plain file reference', () => {
    expect(fileRef('/tmp/u/notes.txt')).toBe('[file: /tmp/u/notes.txt]');
    expect(fileRef('/tmp/u/a.svg')).toBe('[file: /tmp/u/a.svg]');
  });
});

await run();
