project('usher-gtk', version: '0.1.0', meson_version: '>= 0.61.0')

app_id = 'io.github.nexustar.Usher'
app_name = 'usher'

usher_backend = get_option('usher_backend')
bundled_backend = ''
if usher_backend != ''
  bundled_backend = get_option('prefix') / get_option('libexecdir') / 'usher' / 'usher'
endif

subdir('src')
subdir('data')
subdir('tests')

if usher_backend != ''
  install_data(
    usher_backend,
    install_dir: get_option('libexecdir') / 'usher',
    install_mode: 'rwxr-xr-x',
    rename: 'usher',
  )
endif
