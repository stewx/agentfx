import js from '@eslint/js';
import n from 'eslint-plugin-n';
import stylistic from '@stylistic/eslint-plugin';

/**
 * Flat config. The goal is to mechanically enforce the conventions the codebase
 * already follows by hand, so they stop depending on reviewer attention:
 * `node:` prefixes, named exports, single quotes, semicolons.
 *
 * Formatting rules live in @stylistic rather than Prettier — ESLint dropped its
 * own formatting rules in v9, and one tool with one command beats two.
 */

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly'
};

const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  Audio: 'readonly',
  URL: 'readonly',
  confirm: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly'
};

/** Applied everywhere: the rules that encode this repo's stated conventions. */
const shared = {
  ...js.configs.recommended.rules,

  // --- correctness ---------------------------------------------------------
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-throw-literal': 'error',
  // Deliberately-ignored failures are spelled `catch {}` in this codebase; an
  // empty block is only a smell when it still binds a variable it never reads.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // A UTF-8 BOM is data here, not stray whitespace: json.js strips one from
  // settings files (Windows editors emit them) and the tests write one to
  // prove it. Flagging those would invite "fixing" real Windows compatibility.
  'no-irregular-whitespace': ['error', { skipRegExps: true, skipTemplates: true }],
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],

  // --- module shape --------------------------------------------------------
  // Named exports only. There is no core rule for this and eslint-plugin-import
  // would be another dependency, so it is expressed as a syntax restriction.
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ExportDefaultDeclaration',
      message: 'Use named exports — this codebase has no default exports.'
    }
  ],

  // --- formatting ----------------------------------------------------------
  '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
  '@stylistic/semi': ['error', 'always'],
  '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
  '@stylistic/comma-dangle': ['error', 'never'],
  '@stylistic/eol-last': ['error', 'always'],
  '@stylistic/no-trailing-spaces': 'error',
  // Warn, not error: ~60 lines predate this rule and max-len is not
  // auto-fixable, so it is a burn-down list rather than a broken build.
  '@stylistic/max-len': [
    'warn',
    { code: 100, ignoreUrls: true, ignoreRegExpLiterals: true, tabWidth: 2 }
  ]
};

export default [
  { ignores: ['node_modules/**', 'assets/**', '.agentfx-dev/**'] },

  {
    files: ['src/**/*.js', 'bin/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    plugins: { n, '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      ...shared,
      'n/prefer-node-protocol': 'error',
      // engines is >=18.17 and the CLI installs globally, so an API newer than
      // the floor is a runtime crash on a user's machine, not a local problem.
      'n/no-unsupported-features/node-builtins': ['error', { version: '>=18.17.0' }],
      'n/no-unsupported-features/es-syntax': ['error', { version: '>=18.17.0' }]
    }
  },

  {
    files: ['test/**/*.js'],
    plugins: { n, '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: { ...shared, 'n/prefer-node-protocol': 'error' }
  },

  {
    // Flat config is loaded by ESLint itself and must default-export.
    files: ['eslint.config.js'],
    rules: { 'no-restricted-syntax': 'off' }
  },

  {
    files: ['web/**/*.js'],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      ecmaVersion: 2023,
      // index.html loads app.js with `type="module"`, and app.js imports the
      // pure half of the UI from lib.js. Parsing these as scripts made every
      // import a syntax error.
      sourceType: 'module',
      globals: browserGlobals
    },
    rules: shared
  }
];
