import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'lib/**',
      'dist/**',
      '.devcontour-local/**',
      'evidence/**',
      'playwright-report/**',
      'test-results/**',
      '.idea/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    // TODO: tighten typed JSON boundaries in small changes; the initial audit is
    // documented in docs/verification-review.md. Async correctness stays blocking.
    rules: Object.fromEntries(
      [
        'no-unsafe-assignment',
        'no-unsafe-call',
        'no-unsafe-member-access',
        'no-explicit-any',
        'no-unused-vars',
        'no-unsafe-return',
        'no-unsafe-argument',
        'require-await',
        'restrict-template-expressions',
        'no-base-to-string',
      ].map((rule) => [`@typescript-eslint/${rule}`, 'warn']),
    ),
  },
  {
    files: ['tests/**/*.test.ts'],
    rules: {
      // node:test owns failures and completion of top-level registered tests.
      // Only this known registration function is exempt; other promises are errors.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: 'test' }],
        },
      ],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
