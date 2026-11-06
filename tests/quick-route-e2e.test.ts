// Быстрое изменение на настоящем сервере: чтение маршрута не меняет
// репозиторий и .git (m13), а после перезапуска сервера поручение и шаги
// прежние (D01-E). Модели не вызываются: живые CLI на PATH теста заменены
// заглушками, которые проваливают тест при любом вызове, кроме `--version`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';
import { withTestHome } from './helpers.ts';
import type { QuickStep } from '../src/runner/quick.ts';

const prefix = 'devcontour-quick-e2e-';
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
/** Удаляет только каталог, созданный этим тестом во временной папке системы. */
function remove(dir: string) {
  if (dirname(dir) === realpathSync(tmpdir()) && basename(dir).startsWith(prefix))
    rmSync(dir, { recursive: true, force: true });
}
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

type Manager = 'npm' | 'pnpm';
const install: Record<Manager, string[]> = {
  // Без registry: у проекта нет зависимостей, lockfile пуст.
  npm: ['npm', 'ci', '--offline', '--no-audit', '--no-fund'],
  pnpm: ['pnpm', 'install', '--frozen-lockfile', '--offline'],
};
const gates = (manager: Manager) => [
  { id: 'install', kind: 'check', command: install[manager], timeoutMs: 120000 },
  {
    id: 'unit-tests',
    kind: 'test',
    command: [
      'node',
      '--test',
      '--test-reporter=junit',
      '--test-reporter-destination=.reports/junit.xml',
    ],
    timeoutMs: 120000,
    dependsOn: ['install'],
    report: { type: 'junit', path: '.reports/junit.xml' },
  },
];

/** Lockfile проекта без зависимостей: pnpm 9–10 оставляет его без изменений. */
const pnpmLock =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";

/** Существующий npm- или pnpm-репозиторий: свои правила, проверки, тест и коммит. */
function repository(root: string, manager: Manager) {
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'existing-app',
        private: true,
        type: 'module',
        scripts: { test: 'node --test', lint: 'node --check src/index.js' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(root, manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'),
    manager === 'npm'
      ? '{"name":"existing-app","lockfileVersion":3,"requires":true,"packages":{"":{"name":"existing-app"}}}\n'
      : pnpmLock,
  );
  writeFileSync(join(root, 'src/index.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(
    join(root, 'test/add.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/index.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n",
  );
  writeFileSync(join(root, 'AGENTS.md'), '# Own rules\nKeep them.\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'existing project');
}

const intake = (repository: string, requestKey = 'quick-e2e-request') => ({
  requestKey,
  title: 'Сумма с отрицательными числами',
  repository,
  brief: 'add() должен корректно складывать отрицательные числа',
  criterion: 'add(-2, -3) возвращает -5',
});

/** Компактная постановка быстрого изменения: одна функция с критерием поручения. */
const product = {
  problem: 'add() неверно складывает отрицательные числа.',
  outcome: 'add() корректно складывает отрицательные числа.',
  personas: [
    {
      id: 'developer',
      name: 'Разработчик',
      role: 'Пользователь библиотеки',
      goals: ['Складывать любые целые числа'],
      pains: ['Неверная сумма отрицательных чисел'],
    },
  ],
  channels: [{ id: 'library', title: 'Библиотека', purpose: 'Публичная функция add().' }],
  releases: [
    { id: 'r1', title: 'Сумма', goal: 'add() верна для отрицательных.', version: '0.1.0' },
  ],
  features: [
    {
      id: 'negative-sum',
      title: 'Сумма отрицательных чисел',
      outcome: 'add() корректно складывает отрицательные числа.',
      channels: ['library'],
      scenarios: [{ personaId: 'developer', text: 'Вызвать add(-2, -3).' }],
      acceptance: [{ releaseId: 'r1', text: 'add(-2, -3) возвращает -5' }],
    },
  ],
  exclusions: [],
  references: [],
  questions: [],
};

const headers = { 'content-type': 'application/json', 'x-devcontour-request': '1' };
async function call<T = Record<string, unknown>>(
  url: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers, body: JSON.stringify(body) }),
  }).catch((error: unknown) => {
    throw new Error(`${path}: ${String(error)}`, { cause: error });
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${path}: ${text}`);
  return JSON.parse(text) as T;
}
const agent = <T = Record<string, unknown>>(url: string, operation: string, input: unknown) =>
  call<T>(url, '/api/agent', { operation, input });

type QuickView = {
  changeId: string;
  intake: Record<string, unknown>;
  setup?: { digest: string };
  steps: QuickStep[];
  plan?: { refusal?: string };
  result: {
    taskId: string;
    status: string;
    resultSha: string | null;
    run: {
      status: string;
      baseSha: string | null;
      candidateSha: string | null;
      integrationSha: string | null;
      candidate: { kind: string; passed: boolean; sha: string; gate?: string; summary: string }[];
      integration: { kind: string; passed: boolean; sha: string; gate?: string; summary: string }[];
    } | null;
    diff: { count: number; files: { path: string }[] } | null;
    next: string | null;
  }[];
};
const quick = (url: string, changeId: string) =>
  call<QuickView>(url, '/api/preparation/quick?change=' + changeId);

/** Панель: утверждение этапа — решение пользователя (`/api/preparation/decision`). */
async function approve(url: string, changeId: string, stage: string) {
  const status = await call<{ current: Record<string, { digest: string }> }>(
    url,
    '/api/preparation?change=' + changeId,
  );
  const expectedDigest = status.current[stage].digest;
  await agent(url, 'preparation_submit', { changeId, stage, expectedDigest });
  await call(url, '/api/preparation/decision', {
    changeId,
    stage,
    expectedDigest,
    decision: 'approve',
    comment: 'Проверено пользователем',
  });
}

type App = Awaited<ReturnType<typeof startWorkspace>>;

/**
 * Живые CLI под запретом: `claude` и `codex` первыми на PATH отвечают только
 * на `--version`, а любой другой вызов отмечают в файле и завершаются отказом.
 * Случайная живая привязка роли проваливает тест, а не вызывает модель.
 */
function guardLiveRuntimes() {
  const dir = temp();
  const marker = join(dir, 'live-runtime-called');
  for (const name of ['claude', 'codex'])
    writeFileSync(
      join(dir, name),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${name} guard: live runtime forbidden in tests"; exit 0; fi\necho "${name} $*" >> '${marker}'\nexit 97\n`,
      { mode: 0o755 },
    );
  const saved = process.env.PATH;
  process.env.PATH = dir + delimiter + (saved ?? '');
  return {
    called: () => (existsSync(marker) ? readFileSync(marker, 'utf8') : ''),
    restore() {
      process.env.PATH = saved;
      remove(dir);
    },
  };
}

/** Хэш и mtime каждого файла и каталога, включая .git; `skip` — относительные пути. */
function snapshot(root: string, skip: string[] = []) {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (skip.includes(r)) continue;
      const path = join(dir, e.name);
      const stat = lstatSync(path);
      if (e.isSymbolicLink()) out[r] = 'link:' + readlinkSync(path) + ':' + stat.mtimeMs;
      else if (e.isDirectory()) {
        out[r + '/'] = 'dir:' + stat.mtimeMs;
        walk(path, r);
      } else
        out[r] = createHash('sha256').update(readFileSync(path)).digest('hex') + ':' + stat.mtimeMs;
    }
  };
  walk(root, '');
  return out;
}

/**
 * m13: GET /api/preparation/quick только читает. Перед чтением у
 * отслеживаемого файла новый mtime при прежнем содержимом: `git status`
 * с обновлением индекса переписал бы `.git/index`. Embedded — репозиторий
 * целиком, кроме каталога состояния workspace `.devcontour-local`
 * (игнорируемый Git); separate — репозиторий без исключений.
 */
for (const mode of ['embedded', 'separate'] as const)
  test(`m13: чтение быстрого маршрута (${mode}) не меняет файлов репозитория и .git`, () =>
    withTestHome(async () => {
      const repo = temp();
      const workspace = mode === 'embedded' ? repo : temp();
      const guard = guardLiveRuntimes();
      let app: App | undefined;
      try {
        repository(repo, 'npm');
        app = await startWorkspace(workspace, { port: 0, workspaceMode: mode });
        const { activeChangeId } = await call<{ activeChangeId: string }>(
          app.url,
          '/api/preparation/quick',
          intake(repo),
        );
        // Предложение setup: GET строит и план файлов (без записи).
        await agent(app.url, 'preparation_setup', {
          changeId: activeChangeId,
          expectedDigest: null,
          profile: 'npm-project',
          gates: gates('npm'),
          reason: 'Проверки проекта: install без сети и unit-тесты',
        });
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(repo, 'src/index.js'), later, later);
        const skip = mode === 'embedded' ? ['.devcontour-local'] : [];
        const before = snapshot(repo, skip);
        assert.ok(Object.keys(before).some((p) => p.startsWith('.git/')));
        for (let i = 0; i < 2; i++) {
          const view = await quick(app.url, activeChangeId);
          assert.equal(view.steps[0].state, 'done', JSON.stringify(view.steps[0]));
          assert.ok(view.plan, 'план setup построен');
        }
        assert.deepEqual(snapshot(repo, skip), before);
        assert.equal(guard.called(), '');
      } finally {
        await app?.close();
        guard.restore();
        remove(repo);
        if (workspace !== repo) remove(workspace);
      }
    }));

test('D01-E: после перезапуска сервера поручение и шаги быстрого изменения прежние', () =>
  withTestHome(async () => {
    const root = temp();
    const guard = guardLiveRuntimes();
    let app: App | undefined;
    try {
      repository(root, 'pnpm');
      app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
      const { activeChangeId } = await call<{ activeChangeId: string }>(
        app.url,
        '/api/preparation/quick',
        intake(root),
      );
      await agent(app.url, 'preparation_product', {
        changeId: activeChangeId,
        expectedDigest: null,
        reason: 'Компактная постановка',
        content: product,
      });
      await approve(app.url, activeChangeId, 'product');
      const shown = await quick(app.url, activeChangeId);
      await app.close();
      app = undefined;
      app = await startWorkspace(root, { port: 0 });
      const again = await quick(app.url, activeChangeId);
      assert.deepEqual(again.intake, shown.intake);
      assert.deepEqual(again.steps, shown.steps);
      assert.deepEqual(
        again.steps.map((s) => [s.id, s.state]),
        [
          ['connection', 'done'],
          ['decisions', 'current'],
          ['preparation', 'waiting'],
          ['execution', 'waiting'],
          ['result', 'waiting'],
        ],
      );
      // Повтор поручения после перезапуска — то же изменение.
      const replay = await call<{ changeId: string }>(
        app.url,
        '/api/preparation/quick',
        intake(root),
      );
      assert.equal(replay.changeId, activeChangeId);
      assert.equal(guard.called(), '');
    } finally {
      await app?.close();
      guard.restore();
      remove(root);
    }
  }));
