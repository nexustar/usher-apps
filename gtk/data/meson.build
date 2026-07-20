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

