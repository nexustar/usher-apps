# usher for GTK

A native GTK 4/libadwaita client written in GJS. The current MVP provides:

- multiple switchable local or remote usher server profiles;
- optional startup of a specifically configured local usher binary;
- session discovery, filtering, and metadata, kept fresh by a background poll;
- a settings dialog (`Ctrl+,`) for the connected server's agent profiles and
  scheduled tasks;
- backend, model, and agent selection when creating a session, including
  attaching a file before the session exists;
- backend slash-command completion in the composer, and context usage in the
  conversation header;
- native transcript rendering, including collapsible tool calls and inline
  images (click one to open it full size);
- responsive libadwaita navigation that collapses the session sidebar on narrow windows;
- message sending and SSE-driven live refresh, including streamed text previews;
- tool permission requests and AskUserQuestion prompts answered inline above
  the composer;
- connection to an externally managed usher instance for development.
- local or remote server selection, including password authentication.

## Requirements

- GJS
- GTK 4
- libadwaita 1
- libsoup 3
- GtkSourceView 5
- libsecret (optional: remembers server passwords)
- Meson and Ninja (build only)

Building and running the app needs no npm and no JavaScript build step. npm is
used only for the linter (`npm install && npm run lint`).

`Ctrl+Enter` sends a message. While a turn is running, the send action is
replaced by a stop action that interrupts the current turn.

## Build and run

```sh
meson setup build
meson compile -C build
meson install -C build
usher-gtk
```

Optionally bundle a particular backend executable in a release build with:

```sh
meson setup build -Dusher_backend=/absolute/path/to/usher
```

It is installed under `libexec` and becomes the local backend's default path,
so such a build works without the user pointing at anything. No other usher
installation is searched for: a package that ships a backend runs that one, so
client and server cannot fall out of step.

During development, an environment override can point at a local checkout:

```sh
USHER_BACKEND=../usher/usher \
sh ./build/src/usher-gtk
```

Or connect without managing the backend lifecycle:

```sh
USHER_BASE_URL=http://127.0.0.1:7777 \
sh ./build/src/usher-gtk
```

Use *Servers…* in the main menu to add, edit, remove, and switch
server profiles. A profile can contain a remote `http://` or `https://` URL, or
a local usher binary path. The app starts usher only when that path is explicitly
configured. New and edited profiles are saved only after a successful connection
and authentication. Passwords go to the login keyring when one is available,
so a saved server reconnects without asking again; without a secret service
they last only for the current process.

A configured local backend defaults to `127.0.0.1:17777` — usher's own default
is 7777, so the two never collide — and the port is editable in the same place
as the binary path. If something that is not usher already holds that port, the
app says so instead of starting a backend that could only fail to bind. Closing the application
stops a backend that it started; remote and externally managed backends are never
stopped.

Only a backend this application spawned is treated as its own: its session
cookie is derived from the usher data directory the two share, so no password
is needed. An usher that was already listening — yours, or one this app started
before it was restarted — is adopted rather than owned. It is never stopped
here, and it authenticates like any other server: nothing if it has no
password, otherwise the password you type.

A backend it owns is also supervised: if it exits unexpectedly the app restarts
it and reports the exit status along with the tail of its stderr. Repeated
crashes within a minute stop the cycle rather than loop.

In a sandboxed build (Flatpak) the app cannot start anything on the host, so
it offers no local-backend controls at all: run `usher serve` yourself and add
its address as a server. The sandbox is detected at runtime, so one build
behaves correctly in both cases. With no profiles and no environment overrides, the app opens the server
configuration dialog instead of searching for an usher executable.

## Packaging

`build-aux/flatpak/io.github.nexustar.Usher.yml` builds the sandboxed thin
client. Everything it needs is in `org.gnome.Platform`, so nothing is bundled
and the sandbox asks only for a display and the network — no filesystem access,
no D-Bus holes. Build and run it locally with:

```sh
flatpak install flathub org.gnome.Platform//50 org.gnome.Sdk//50
flatpak-builder --user --install --force-clean build-dir \
    build-aux/flatpak/io.github.nexustar.Usher.yml
flatpak run io.github.nexustar.Usher
```

The manifest tracks the newest stable GNOME runtime, since older ones stop
receiving security updates; check what that is with `flatpak remote-ls flathub
--system | grep org.gnome.Platform` and bump both the manifest and the command
above together. Anything from 47 on works — that is where libadwaita 1.6, and
so `AdwButtonRow`, arrived.

For a build of the working tree rather than a tag, swap the manifest's `git`
source for `- type: dir` / `path: ../../..`. Screenshots still have to be added
to the metainfo before this can go to Flathub.

Release packages may install a matching usher executable under `libexec`, but
the GTK client does not require one; without it the client only connects to
servers you configure.
A Flatpak build can omit the backend and connect to a host usher instance over
HTTP(S), avoiding the broad host permissions required by an integrated backend.

## Tests

`tests/harness.js` is a small describe/it runner; suites call `run()` at the
end and meson reports the exit status. The default suite is self-contained.
API, SSE and behaviour tests can be enabled against a running usher:

```sh
meson configure build \
  -Dtest_url=http://127.0.0.1:7777 \
  -Dtest_password='optional-password'
meson test -C build --print-errorlogs
```

Set `-Dtest_display=:5` as well when a matching `gtk4-broadwayd :5` is running
to include the tests that need a display: the behaviour suite (transcript
paging, drafts, interaction cards, the new-session view) and the rapid
session-switch smoke test.
