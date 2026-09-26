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
      // Приватные исследования, клоны ревью и их логи — не исходники проекта.
      '.private/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    // TODO: tighten typed JSON boundaries in small changes.
    // Async correctness stays blocking.
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
  // Границы слоёв. Домен не знает ни процессов, ни сервера, ни интерфейса;
  // интерфейс исполняется в браузере и не тянет код runner/server и модули
  // Node. Нарушение — ошибка, а не предупреждение: граница, которую можно
  // нарушить молча, со временем перестаёт существовать.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../application/*', '../runner/*', '../server/*', '../web/*', '../cli*'],
              message: 'core — домен: он не зависит от application, runner, server и web.',
            },
            {
              group: ['node:child_process', 'node:net', 'node:http', 'node:https'],
              message: 'Процессы и сеть — дело runner и server, не домена.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../server/*', '../web/*', '../cli*'],
              message: 'application не зависит от транспорта и интерфейса.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../runner/*', '../server/*', '../cli*', 'node:*'],
              message: 'Интерфейс исполняется в браузере: только core, application и типы.',
            },
          ],
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
