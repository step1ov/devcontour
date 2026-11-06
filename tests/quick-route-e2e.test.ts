// Быстрое изменение от поручения до результата на настоящем сервере (D01-A),
// неизменность репозитория при чтении маршрута и сохранность после
// перезапуска сервера (D01-E).
//
// Исполнитель и ревьюер — учебный runtime `demo` (fixture harness): модели
// не вызываются, учётные данные провайдеров не читаются. Настоящий сервер
// (`startWorkspace`) собирает планировщик с адаптерами по умолчанию, и
// подставить тестовый runtime в него нельзя; живые `codex`/`claude` под
// чужими именами выдали бы fixture за AI. Поэтому ведущий агент после setup
// переводит локальную конфигурацию в учебный режим (`mode: "demo"`, runtime
// `demo`), и панель, попытки и доказательства называют его учебным.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  utimesSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';
import { architecture } from './preparation-fixture.ts';
import { testCheckoutRoot, withTestHome } from './helpers.ts';
import { loadConfig } from '../src/runner/config.ts';
import { repositories } from '../src/core/repositories.ts';
import type { QuickStep } from '../src/runner/quick.ts';

const cli = resolve('src/cli.ts');
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

/**
 * pnpm без сети: есть ли он, ставит ли проект без зависимостей offline и не
 * переписывает ли lockfile (gate install отклонил бы изменённый tracked-файл).
 */
function pnpmOffline(): string | undefined {
  const version = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) return 'pnpm не установлен';
  const dir = temp();
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"probe","private":true}\n');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), pnpmLock);
    const run = spawnSync('pnpm', install.pnpm, { cwd: dir, encoding: 'utf8' });
    if (run.status !== 0)
      return (
        'pnpm не ставит проект без зависимостей offline: ' + (run.stderr || run.stdout).slice(-300)
      );
    if (readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8') !== pnpmLock)
      return `pnpm ${version.stdout.trim()} переписывает lockfile проекта без зависимостей`;
    return undefined;
  } finally {
    remove(dir);
  }
}

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

/**
 * Команда CLI ведущего агента. Асинхронно: сервер работает в процессе теста,
 * и синхронный запуск остановил бы его на время команды (`queue --start`
 * ждёт подтверждения от сервера).
 */
const cliRun = (root: string, ...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args, '--workspace', root], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });

async function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (v: T) => boolean,
  ms = 180000,
) {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`${what}: не дождались за ${ms} мс; последнее: ${JSON.stringify(last)}`);
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

type Binding = { runtime: string; model?: string; effort?: string; reviewer?: Binding };
const toTraining = (roles: Record<string, Binding> | undefined) => {
  for (const role of Object.values(roles ?? {})) {
    role.runtime = 'demo';
    delete role.model;
    delete role.effort;
    if (role.reviewer) role.reviewer = { runtime: 'demo' };
  }
};

/**
 * Ведущий агент переводит контур в учебный режим: `mode: "demo"` и runtime
 * `demo` у всех ролей и ревьюеров — и в локальной конфигурации, и в файле
 * компонента (`devcontour.component.json`): роли embedded-компонента живут
 * там, и без правки он исполнял бы задачи живыми CLI.
 */
function trainingRuntime(root: string) {
  const configPath = join(root, '.devcontour-local/config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mode: string;
    checkoutRoot?: string;
    roles: Record<string, Binding>;
    reviewer: Binding;
    repositories?: { roles?: Record<string, Binding>; reviewer?: Binding }[];
  };
  config.mode = 'demo';
  // Рабочие деревья — во временном каталоге теста, не в кэше пользователя.
  config.checkoutRoot = testCheckoutRoot();
  toTraining(config.roles);
  config.reviewer = { runtime: 'demo' };
  for (const repo of config.repositories ?? []) {
    toTraining(repo.roles);
    if (repo.reviewer) repo.reviewer = { runtime: 'demo' };
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const componentPath = join(root, 'devcontour.component.json');
  const component = JSON.parse(readFileSync(componentPath, 'utf8')) as {
    roles?: Record<string, Binding>;
    reviewer?: Binding;
  };
  toTraining(component.roles);
  if (component.reviewer) component.reviewer = { runtime: 'demo' };
  writeFileSync(componentPath, JSON.stringify(component, null, 2) + '\n');
  // Действующая конфигурация: ни одной живой привязки.
  const loaded = loadConfig(configPath);
  assert.equal(loaded.mode, 'demo');
  const bindings: Binding[] = [
    loaded.reviewer,
    ...Object.values(loaded.roles),
    ...repositories(loaded).flatMap((r) => [
      ...(r.reviewer ? [r.reviewer] : []),
      ...Object.values(r.roles ?? {}),
    ]),
    ...(['code', 'plan', 'contract'] as const).flatMap((k) =>
      loaded.review?.[k]?.reviewer ? [loaded.review[k].reviewer] : [],
    ),
  ];
  for (const b of bindings) {
    assert.equal(b.runtime, 'demo', JSON.stringify(b));
    if (b.reviewer) assert.equal(b.reviewer.runtime, 'demo', JSON.stringify(b));
  }
}

const connected = (app: App) =>
  until(
    'подключение движка',
    () => call<{ engineConnected: boolean; startupError?: string }>(app.url, '/api/preparation'),
    (v) => v.engineConnected || Boolean(v.startupError),
  ).then((v) => assert.equal(v.startupError, undefined));

/**
 * Весь быстрый маршрут: поручение и три согласования в панели,
 * preparation_setup, `setup --change`, обычные шаги ведущего агента и
 * исполнение учебным runtime через gates и review обеих фаз.
 */
async function route(manager: Manager, root: string, guard: { called: () => string }) {
  repository(root, manager);
  const servers: App[] = [];
  const start = async () => {
    const app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
    servers.push(app);
    return app;
  };
  const stop = async (app: App) => {
    servers.splice(servers.indexOf(app), 1);
    await app.close();
  };
  try {
    let app = await start();
    // 1. Поручение из панели.
    const created = await call<{ activeChangeId: string }>(
      app.url,
      '/api/preparation/quick',
      intake(root),
    );
    const changeId = created.activeChangeId;
    // 2. Компактные решения: ведущий агент предлагает, пользователь утверждает в панели.
    await agent(app.url, 'preparation_product', {
      changeId,
      expectedDigest: null,
      reason: 'Компактная постановка',
      content: product,
    });
    await approve(app.url, changeId, 'product');
    await agent(app.url, 'preparation_architecture', {
      changeId,
      expectedDigest: null,
      reason: 'Существующий стек',
      content: architecture,
    });
    await approve(app.url, changeId, 'architecture');
    await agent(app.url, 'preparation_references', {
      changeId,
      expectedDigest: null,
      reason: 'Изменение без интерфейса',
      content: {
        applicable: false,
        reason: 'Изменение функции без интерфейса',
        summary: '',
        questions: [],
      },
    });
    await approve(app.url, changeId, 'references');
    // 3. preparation_setup: gates по реальным командам проекта, без сети.
    await agent(app.url, 'preparation_setup', {
      changeId,
      expectedDigest: null,
      profile: `${manager}-project`,
      gates: gates(manager),
      reason: 'Проверки проекта: install без сети и unit-тесты',
    });
    const proposed = await until(
      'план setup',
      () => quick(app.url, changeId),
      (v) => Boolean(v.setup && v.plan),
    );
    assert.equal(proposed.plan!.refusal, undefined);
    assert.deepEqual(
      proposed.steps.map((s) => [s.id, s.state]),
      [
        ['connection', 'done'],
        ['decisions', 'done'],
        ['preparation', 'current'],
        ['execution', 'waiting'],
        ['result', 'waiting'],
      ],
    );
    // Сервер подключил бы движок по конфигурации setup с живыми CLI; изменение
    // политики — при остановленном сервере (START.md).
    await stop(app);

    // 4. setup --change с digest предложения, который показала панель.
    const plan = await cliRun(root, 'setup', '--change', changeId, '--plan');
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(
      (JSON.parse(plan.stdout) as { proposal: string }).proposal,
      proposed.setup!.digest,
    );
    const applied = await cliRun(
      root,
      'setup',
      '--change',
      changeId,
      '--proposal',
      proposed.setup!.digest,
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(
      (JSON.parse(applied.stdout) as { status: string }).status,
      'needs-agent-bootstrap',
    );
    trainingRuntime(root);

    // 5. Bootstrap-коммит файлов setup.
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'DevContour bootstrap');
    assert.equal(git(root, 'status', '--porcelain'), '');
    const bootstrap = git(root, 'rev-parse', 'HEAD');
    // 6. context-lock и doctor (без сети и без вызовов моделей). До
    // закрепления doctor называет блокировкой только незакреплённый контекст.
    const early = await cliRun(root, 'doctor');
    assert.notEqual(early.status, 0);
    assert.deepEqual(
      (JSON.parse(early.stdout) as { checks: { id: string; status: string }[] }).checks
        .filter((c) => c.status === 'blocked')
        .map((c) => c.id),
      ['context'],
    );
    const locked = await cliRun(root, 'context-lock');
    assert.equal(locked.status, 0, locked.stderr);
    const doctor = await cliRun(root, 'doctor');
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.equal((JSON.parse(doctor.stdout) as { ready: boolean }).ready, true);

    app = await start();
    await connected(app);
    // Учебный режим виден панели: подпись «Учебный режим · без вызовов моделей».
    const state = await call<{
      config: {
        mode: string;
        repositories: { roles?: Record<string, Binding>; reviewer?: Binding }[];
      };
    }>(app.url, '/api/state');
    assert.equal(state.config.mode, 'demo');

    // 7. Одна задача с критерием поручения; она связана с быстрым изменением.
    const { boardId } = await agent<{ boardId: string }>(app.url, 'board_create', {
      title: 'Быстрое изменение: сумма отрицательных',
    });
    const task = await agent<{ taskId: string; status: string }>(app.url, 'task_create', {
      boardId,
      task: {
        title: 'Сложение отрицательных чисел',
        description: 'add() корректно складывает отрицательные числа.',
        role: 'architect',
        acceptance: [intake(root).criterion],
        featureId: 'negative-sum',
      },
    });
    assert.equal(task.status, 'draft');
    assert.deepEqual(
      (await quick(app.url, changeId)).result.map((r) => r.taskId),
      [task.taskId],
    );
    // 8. review-plan — AI-согласование только в local mode; в учебном режиме
    // план утверждает оператор кнопкой панели.
    const review = await cliRun(
      root,
      'review-plan',
      '--board',
      boardId,
      '--author-runtime',
      'claude',
    );
    assert.notEqual(review.status, 0, review.stdout);
    assert.match(review.stderr, /только для local mode/);
    await call(app.url, `/api/boards/${boardId}/approve`, {});
    // 9. Запуск очереди.
    const queue = await cliRun(root, 'queue', '--start');
    assert.equal(queue.status, 0, queue.stderr);

    const done = await until(
      'результат',
      () => quick(app.url, changeId),
      (v) =>
        v.steps.find((s) => s.id === 'execution')?.state === 'done' ||
        v.steps.some((s) => s.state === 'blocked'),
    );
    assert.equal(guard.called(), '', 'живой runtime не вызывался');
    return { app, changeId, bootstrap, done, doctor, taskId: task.taskId, start, stop };
  } catch (error) {
    for (const app of servers.splice(0)) await app.close();
    throw error;
  }
}

for (const manager of ['npm', 'pnpm'] as const)
  test(
    `D01-A: быстрый маршрут ${manager} на настоящем сервере — от поручения до результата двух фаз учебным runtime`,
    { skip: manager === 'pnpm' ? pnpmOffline() : undefined },
    () =>
      withTestHome(async () => {
        const root = temp();
        const guard = guardLiveRuntimes();
        let app: App | undefined;
        try {
          const r = await route(manager, root, guard);
          app = r.app;
          // Шаги: подключение..выполнение пройдены, результат ждёт проверки оператора.
          assert.deepEqual(
            r.done.steps.map((s) => [s.id, s.state]),
            [
              ['connection', 'done'],
              ['decisions', 'done'],
              ['preparation', 'done'],
              ['execution', 'done'],
              ['result', 'current'],
            ],
            JSON.stringify({ steps: r.done.steps, result: r.done.result }),
          );
          assert.equal(r.done.result.length, 1);
          const [result] = r.done.result;
          assert.equal(result.taskId, r.taskId);
          assert.equal(result.status, 'done');
          const run = result.run!;
          assert.equal(run.status, 'succeeded');
          assert.equal(run.baseSha, r.bootstrap);
          assert.match(run.candidateSha ?? '', /^[0-9a-f]{40}$/);
          assert.match(run.integrationSha ?? '', /^[0-9a-f]{40}$/);
          assert.notEqual(run.candidateSha, run.integrationSha);
          assert.equal(result.resultSha, run.integrationSha);
          // Обе фазы — настоящие Git gates и review на своём SHA.
          for (const [phase, sha] of [
            [run.candidate, run.candidateSha],
            [run.integration, run.integrationSha],
          ] as const) {
            assert.deepEqual(
              phase.map((e) => [e.gate, e.kind, e.passed]),
              [
                ['install', 'test', true],
                ['unit-tests', 'test', true],
                ['independent-review', 'review', true],
              ],
            );
            assert.ok(phase.every((e) => e.sha === sha));
            // Учебный ревьюер называет себя: это не AI-review.
            assert.match(phase.find((e) => e.kind === 'review')!.summary, /не AI-review/);
          }
          const target = (
            await call<{ config: { repositories: { targetBranch: string }[] } }>(
              app.url,
              '/api/state',
            )
          ).config.repositories[0].targetBranch;
          git(root, 'merge-base', '--is-ancestor', run.integrationSha!, 'refs/heads/' + target);
          assert.deepEqual(
            result.diff!.files.map((f) => f.path),
            [`deliverables/${r.taskId}.json`],
          );
          assert.equal(result.diff!.count, 1);
          assert.match(result.next ?? '', /принимает доску/);
          // Попытка и вызовы — учебного runtime; живые CLI не запускались.
          const state = await call<{
            runs: { taskId: string; runtime: string; reviewer: string }[];
          }>(app.url, '/api/state');
          assert.deepEqual(
            state.runs.map((x) => [x.taskId, x.runtime, x.reviewer]),
            [[r.taskId, 'demo', 'demo']],
          );
          assert.equal(guard.called(), '');

          // m13: чтение маршрута не меняет ни файлов репозитория, ни .git.
          // Сначала фоновая уборка рабочих деревьев попытки заканчивается:
          // два одинаковых снимка подряд.
          let before = snapshot(root, ['.devcontour-local']);
          await until(
            'покой репозитория',
            async () => {
              await new Promise((r) => setTimeout(r, 1500));
              const next = snapshot(root, ['.devcontour-local']);
              const same = JSON.stringify(next) === JSON.stringify(before);
              before = next;
              return same;
            },
            (same) => same,
            60000,
          );
          await quick(app.url, r.changeId);
          await quick(app.url, r.changeId);
          assert.deepEqual(snapshot(root, ['.devcontour-local']), before);

          // D01-E: после перезапуска сервера — те же поручение, шаги и результат.
          const shown = await quick(app.url, r.changeId);
          await r.stop(app);
          app = undefined;
          app = await r.start();
          await connected(app);
          const again = await quick(app.url, r.changeId);
          assert.deepEqual(again.intake, shown.intake);
          assert.deepEqual(again.steps, shown.steps);
          assert.deepEqual(again.result, shown.result);
        } finally {
          await app?.close();
          guard.restore();
          remove(root);
        }
      }),
  );

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
