js_sources = files(
  'main.js',
  'promises.js',
  'application.js',
  'api-client.js',
  'approvals.js',
  'backend-process.js',
  'details.js',
  'event-stream.js',
  'interaction.js',
  'keyring.js',
  'local-auth.js',
  'markdown.js',
  'server-store.js',
  'settings.js',
  'sidebar.js',
  'text.js',
  'style.js',
  'transcript.js',
  'window.js',
)

install_data(
  js_sources,
  install_dir: get_option('datadir') / app_id / 'js',
)

install_data(
  'vendor/marked.umd.js',
  'vendor/marked.LICENSE',
  install_dir: get_option('datadir') / app_id / 'js' / 'vendor',
)

gjs = find_program('gjs').full_path()

dev_launcher_conf = configuration_data()
dev_launcher_conf.set('GJS', gjs)
dev_launcher_conf.set('JS_DIR', meson.current_source_dir())
dev_launcher_conf.set('BUNDLED_BACKEND', '')

configure_file(
  input: 'usher-gtk.in',
  output: 'usher-gtk',
  configuration: dev_launcher_conf,
)

installed_launcher_conf = configuration_data()
installed_launcher_conf.set('GJS', gjs)
installed_launcher_conf.set(
  'JS_DIR',
  get_option('prefix') / get_option('datadir') / app_id / 'js',
)
installed_launcher_conf.set('BUNDLED_BACKEND', bundled_backend)

installed_launcher = configure_file(
  input: 'usher-gtk.in',
  output: 'usher-gtk-installed',
  configuration: installed_launcher_conf,
)

install_data(
  installed_launcher,
  install_dir: get_option('bindir'),
  install_mode: 'rwxr-xr-x',
  rename: 'usher-gtk',
)
