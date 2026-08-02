// GJS is neither Node nor a browser: the globals below are what the runtime
// actually provides, and `imports` is its module system.
export default [
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    ignores: ['src/vendor/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        imports: 'readonly',
        print: 'readonly',
        printerr: 'readonly',
        log: 'readonly',
        logError: 'readonly',
        console: 'readonly',
        globalThis: 'readonly',
        ARGV: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
    rules: {
      // `catch (_)` is the idiom here for an error that carries no information.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
    },
  },
];
