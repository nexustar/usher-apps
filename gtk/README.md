# usher for GTK

A native GTK 4/libadwaita client written in GJS. The current MVP provides:

- multiple switchable local or remote usher server profiles;
- optional startup of a specifically configured local usher binary;
- session discovery, filtering, and metadata, kept fresh by a background poll;
- native transcript rendering, including collapsible tool calls;
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
- Meson and Ninja (build only)

No npm packages or JavaScript build step are used.

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

Use the server button in the window header to add, edit, remove, and switch
server profiles. A profile can contain a remote `http://` or `https://` URL, or
a local usher binary path. The app starts usher only when that path is explicitly
configured. New and edited profiles are saved only after a successful connection
and authentication. Passwords are kept only for the current process.

A configured local backend defaults to `127.0.0.1:17777`. Closing the application
stops a backend that it started; remote and externally managed backends are never
stopped. With no profiles and no environment overrides, the app opens the server
configuration dialog instead of searching for an usher executable.

## Packaging

Release packages may install a matching usher executable under `libexec`, but
the GTK client does not require one. Users explicitly select its path in a local
server profile; otherwise the client only connects to configured remote URLs.
A Flatpak build can omit the backend and connect to a host usher instance over
HTTP(S), avoiding the broad host permissions required by an integrated backend.

## Tests

The default Meson test suite is self-contained. API and SSE integration tests
can be enabled against a running usher:

```sh
meson configure build \
  -Dtest_url=http://127.0.0.1:7777 \
  -Dtest_password='optional-password'
meson test -C build --print-errorlogs
```

Set `-Dtest_display=:5` as well when a matching `gtk4-broadwayd :5` is running
to include the rapid session-switch GTK test.
