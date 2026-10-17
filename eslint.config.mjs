import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Пакет harness — только через публичный корень и `/contracts`: глубокий
// импорт внутреннего модуля обходил бы его договор и ломался бы при
// обновлении, а путь к соседнему checkout привязывал бы сборку к машине.
const harnessImports = [
  {
    regex: '^devcontour-harness/(?!contracts$).+',
    message: 'harness импортируется только из корня пакета или devcontour-harness/contracts.',
  },
  {
    regex: '^(?:\\.{1,2}/|/).*devcontour-harness',
    message: 'harness — установленный пакет, не соседний checkout.',
  },
];

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
  // Пакет harness: запрет общий для всех файлов (слоям ниже он добавлен к их
  // собственным правилам — в flat config одно правило не складывается).
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: harnessImports }] },
  },
  // Тесты дополнительно получают общий набор проверок адаптеров хранилища
  // (`devcontour-harness/testing`); рабочий код его не импортирует.
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^devcontour-harness/(?!contracts$|testing$).+',
              message:
                'harness импортируется только из корня пакета, devcontour-harness/contracts или /testing в тестах.',
            },
            harnessImports[1],
          ],
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
            ...harnessImports,
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
            ...harnessImports,
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
            ...harnessImports,
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
