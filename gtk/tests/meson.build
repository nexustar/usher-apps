test(
  'server-store',
  find_program('gjs'),
  args: ['-m', meson.current_source_dir() / 'server-store.js'],
)

test(
  'local-auth',
  find_program('gjs'),
  args: ['-m', meson.current_source_dir() / 'local-auth.js'],
)

test_url = get_option('test_url')
if test_url != ''
  integration_env = environment()
  integration_env.set('USHER_TEST_URL', test_url)
  integration_env.set('USHER_TEST_PASSWORD', get_option('test_password'))
  test(
    'api-smoke',
    find_program('gjs'),
    args: ['-m', meson.current_source_dir() / 'api-smoke.js'],
    env: integration_env,
    suite: 'integration',
  )
  test(
    'sse-smoke',
    find_program('gjs'),
    args: ['-m', meson.current_source_dir() / 'sse-smoke.js'],
    env: integration_env,
    suite: 'integration',
  )

  test_display = get_option('test_display')
  if test_display != ''
    switch_env = environment()
    switch_env.set('USHER_TEST_URL', test_url)
    switch_env.set('USHER_BASE_URL', test_url)
    switch_env.set('GDK_BACKEND', 'broadway')
    switch_env.set('BROADWAY_DISPLAY', test_display)
    test(
      'session-switch-smoke',
      find_program('gjs'),
      args: ['-m', meson.current_source_dir() / 'session-switch-smoke.js'],
      env: switch_env,
      suite: 'integration',
    )
  endif
endif
