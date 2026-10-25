desktop = configure_file(
  input: 'io.github.nexustar.Usher.desktop.in',
  output: 'io.github.nexustar.Usher.desktop',
  copy: true,
)
install_data(desktop, install_dir: get_option('datadir') / 'applications')

install_data(
  'io.github.nexustar.Usher.metainfo.xml',
  install_dir: get_option('datadir') / 'metainfo',
)

install_data(
  'icons/io.github.nexustar.Usher.svg',
  install_dir: get_option('datadir') / 'icons/hicolor/scalable/apps',
)

# A paper-plane "send" is the chat convention but is not an Adwaita icon, so
# the app carries its own. Namespaced by app id, as app-provided icons are.
install_data(
  'icons/hicolor/symbolic/apps/io.github.nexustar.Usher-send-symbolic.svg',
  'icons/hicolor/symbolic/apps/io.github.nexustar.Usher-dot-symbolic.svg',
  'icons/hicolor/symbolic/apps/io.github.nexustar.Usher-router-symbolic.svg',
  install_dir: get_option('datadir') / 'icons/hicolor/symbolic/apps',
)

