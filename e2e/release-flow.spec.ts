import { test, expect, type APIRequestContext } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';
import { loadConfig } from '../src/runner/config.ts';
import { architecture } from '../tests/preparation-fixture.ts';

// Быстрое изменение, обсуждение задачи и центр внимания вместе на настоящем
// сервере (`startWorkspace`, embedded) без подмены API: поручение из формы,
// согласование с карточки центра, setup ведущего агента, вопрос исполнителя,
// заметка в обсуждении, ответ с карточки и новая попытка. Исполнитель и
// ревьюер — учебный runtime `demo` (fixture, не модель); живые CLI под
// запретом: `claude` и `codex` на PATH отказывают и отмечают вызов.

const prefix = 'devcontour-ui-flow-';
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
/** Удаляет только каталог, созданный этим тестом во временной папке системы. */
function remove(dir: string) {
  if (dirname(dir) === realpathSync(tmpdir()) && basename(dir).startsWith(prefix))
    rmSync(dir, { recursive: true, force: true });
}
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const headers = { 'X-DevContour-Request': '1' };

/** Существующий npm-репозиторий без зависимостей: свои правила, тест и коммит. */
function repository(root: string) {
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
    join(root, 'package-lock.json'),
    '{"name":"existing-app","lockfileVersion":3,"requires":true,"packages":{"":{"name":"existing-app"}}}\n',
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

async function agent<T = Record<string, unknown>>(
  request: APIRequestContext,
  base: string,
  operation: string,
  input: unknown,
) {
  const response = await request.post(base + '/api/agent', {
    headers,
    data: { operation, input },
  });
  const body = (await response.json()) as T;
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

type Step = { id: string; state: string; actor?: string };
type Quick = { steps: Step[]; setup?: { digest: string }; plan?: { refusal?: string } };
const quick = async (request: APIRequestContext, base: string, changeId: string) =>
  (await (await request.get(`${base}/api/preparation/quick?change=${changeId}`)).json()) as Quick;
const steps = (q: Quick) => q.steps.map((s) => `${s.id}:${s.state}`);

/** Утверждение этапа пользователем через API панели (как кнопка этапа). */
async function approve(request: APIRequestContext, base: string, changeId: string, stage: string) {
  const status = (await (
    await request.get(`${base}/api/preparation?change=${changeId}`)
  ).json()) as {
    current: Record<string, { digest: string }>;
  };
  const expectedDigest = status.current[stage].digest;
  await agent(request, base, 'preparation_submit', { changeId, stage, expectedDigest });
  const decided = await request.post(base + '/api/preparation/decision', {
    headers,
    data: { changeId, stage, expectedDigest, decision: 'approve', comment: 'Проверено' },
  });
  expect(decided.ok(), await decided.text()).toBe(true);
}

/** Команда ведущего агента при остановленном сервере. */
function cli(root: string, ...args: string[]) {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve('src/cli.ts'), ...args, '--workspace', root],
    { encoding: 'utf8', env: process.env },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
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

/** Ведущий агент переводит контур в учебный режим: `mode: "demo"`, runtime `demo` у всех ролей. */
function trainingRuntime(root: string, checkouts: string) {
  const configPath = join(root, '.devcontour-local/config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mode: string;
    checkoutRoot?: string;
    roles: Record<string, Binding>;
    reviewer: Binding;
    repositories?: { roles?: Record<string, Binding>; reviewer?: Binding }[];
  };
  config.mode = 'demo';
  config.checkoutRoot = checkouts;
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
  expect(loadConfig(configPath).mode).toBe('demo');
}

/** Подменённый домашний каталог, автор Git и запрет живых CLI на время теста. */
function isolate(home: string) {
  const bin = join(home, 'bin');
  const marker = join(home, 'live-runtime-called');
  mkdirSync(bin);
  mkdirSync(join(home, 'Library', 'Caches'), { recursive: true });
  mkdirSync(join(home, '.cache'), { recursive: true });
  for (const name of ['claude', 'codex'])
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${name} guard"; exit 0; fi\necho "${name} $*" >> '${marker}'\nexit 97\n`,
      { mode: 0o755 },
    );
  const keys = [
    'HOME',
    'XDG_CACHE_HOME',
    'PATH',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    PATH: bin + delimiter + (saved.PATH ?? ''),
    GIT_AUTHOR_NAME: 'Flow UI',
    GIT_AUTHOR_EMAIL: 'flow-ui@example.invalid',
    GIT_COMMITTER_NAME: 'Flow UI',
    GIT_COMMITTER_EMAIL: 'flow-ui@example.invalid',
  });
  return {
    called: () => (existsSync(marker) ? readFileSync(marker, 'utf8') : ''),
    restore() {
      for (const k of keys)
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    },
  };
}

test('Quick start, a discussion note and the attention center together on a real server', async ({
  page,
  request,
}) => {
  test.setTimeout(300000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const root = temp();
  const home = temp();
  const checkouts = temp();
  const guard = isolate(home);
  let app: Awaited<ReturnType<typeof startWorkspace>> | undefined;
  try {
    repository(root);
    app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });

    // 1. Поручение из формы быстрого изменения.
    await page.goto(app.url);
    const form = page.getByRole('form', { name: 'Быстрое изменение' });
    await expect(form.getByLabel('Репозиторий (абсолютный путь)')).toHaveValue(root);
    await form.getByLabel('Что изменить').fill('add() должен складывать отрицательные числа');
    await form.getByLabel('Как проверить результат').fill('add(-2, -3) возвращает -5');
    await form.getByRole('button', { name: 'Начать быстрое изменение' }).click();
    const route = page.getByRole('region', { name: 'Быстрое изменение' });
    await expect(route).toBeVisible();
    const { changes } = (await (await request.get(app.url + '/api/preparation')).json()) as {
      changes: { id: string }[];
    };
    expect(changes).toHaveLength(1);
    const changeId = changes[0].id;

    // 2. Ведущий предлагает постановку; пользователь утверждает её с карточки центра.
    await agent(request, app.url, 'preparation_product', {
      changeId,
      expectedDigest: null,
      reason: 'Компактная постановка',
      content: product,
    });
    const status = (await (
      await request.get(`${app.url}/api/preparation?change=${changeId}`)
    ).json()) as { current: Record<string, { digest: string }> };
    await agent(request, app.url, 'preparation_submit', {
      changeId,
      stage: 'product',
      expectedDigest: status.current.product.digest,
    });
    await page.getByRole('link', { name: /Нужно действие/ }).click();
    await expect(page).toHaveURL(/view=attention/);
    const stageCard = page.locator(`article[data-attention-key="prep:stage:${changeId}:product"]`);
    await expect(stageCard).toContainText('Кто действует: Вы');
    await stageCard.getByRole('button', { name: 'Утвердить', exact: true }).click();
    await expect(stageCard).toHaveCount(0);

    // 3. Остальные решения и setup ведущего агента.
    await agent(request, app.url, 'preparation_architecture', {
      changeId,
      expectedDigest: null,
      reason: 'Существующий стек',
      content: architecture,
    });
    await approve(request, app.url, changeId, 'architecture');
    await agent(request, app.url, 'preparation_references', {
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
    await approve(request, app.url, changeId, 'references');
    await agent(request, app.url, 'preparation_setup', {
      changeId,
      expectedDigest: null,
      profile: 'npm-project',
      gates: [
        {
          id: 'install',
          kind: 'check',
          command: ['npm', 'ci', '--offline', '--no-audit', '--no-fund'],
          timeoutMs: 120000,
        },
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
      ],
      reason: 'Проверки проекта: install без сети и unit-тесты',
    });
    await expect
      .poll(async () => steps(await quick(request, app!.url, changeId)))
      .toEqual([
        'connection:done',
        'decisions:done',
        'preparation:current',
        'execution:waiting',
        'result:waiting',
      ]);
    const proposal = (await quick(request, app.url, changeId)).setup!.digest;
    // Изменение политики — при остановленном сервере (START.md).
    await page.goto('about:blank');
    await app.close();
    app = undefined;
    const applied = cli(root, 'setup', '--change', changeId, '--proposal', proposal);
    expect(applied.status, applied.stderr).toBe(0);
    trainingRuntime(root, checkouts);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'DevContour bootstrap');
    const locked = cli(root, 'context-lock');
    expect(locked.status, locked.stderr).toBe(0);
    const doctor = cli(root, 'doctor');
    expect(doctor.status, doctor.stdout + doctor.stderr).toBe(0);

    app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
    const base = app.url;
    await expect
      .poll(
        async () =>
          (
            (await (await request.get(base + '/api/preparation')).json()) as {
              engineConnected: boolean;
            }
          ).engineConnected,
      )
      .toBe(true);

    // 4. Одна задача быстрого изменения; demo-исполнитель спрашивает оператора.
    const { boardId } = await agent<{ boardId: string }>(request, base, 'board_create', {
      title: 'Быстрое изменение: сумма отрицательных',
    });
    const { taskId } = await agent<{ taskId: string }>(request, base, 'task_create', {
      boardId,
      task: {
        title: 'Сложение отрицательных чисел',
        description:
          'add() корректно складывает отрицательные числа; нужно решение [demo:ask-product].',
        role: 'developer',
        acceptance: ['add(-2, -3) возвращает -5'],
        featureId: 'negative-sum',
      },
    });
    const approved = await request.post(`${base}/api/boards/${boardId}/approve`, {
      headers,
      data: {},
    });
    expect(approved.ok(), await approved.text()).toBe(true);
    expect(
      (await request.post(base + '/api/scheduler', { headers, data: { start: true } })).ok(),
    ).toBe(true);
    type State = {
      tasks: { id: string; status: string; failureKind?: string }[];
      runs: { taskId: string }[];
    };
    const state = async () => (await (await request.get(base + '/api/state')).json()) as State;
    await expect
      .poll(async () => (await state()).tasks.find((t) => t.id === taskId)?.failureKind, {
        timeout: 120000,
      })
      .toBe('needs-input');
    const { requests } = await agent<{ requests: { requestId: string }[] }>(
      request,
      base,
      'input_list',
      { taskId },
    );
    const key = `input:${requests[0].requestId}`;
    // Быстрое изменение называет ожидание ответа оператора, а не сбой попытки.
    const execution = async () =>
      (await quick(request, base, changeId)).steps.find((s) => s.id === 'execution');
    expect(await execution()).toMatchObject({ state: 'current', actor: 'operator' });

    // 5. Центр внимания ведёт к вопросу; заметка в обсуждении задачи не меняет исполнения.
    await page.goto(base + '/?view=attention');
    const card = page.locator(`article[data-attention-key="${key}"]`);
    await expect(card).toContainText('Вопрос к вам');
    await card.getByRole('link', { name: 'Открыть вопрос' }).click();
    await expect(page).toHaveURL(new RegExp(`task=${taskId}`));
    const before = await state();
    const discussion = page.getByRole('region', { name: 'Обсуждение' });
    await discussion.getByLabel('Сообщение', { exact: true }).fill('Пусть ответ сохранит формат');
    await discussion.getByRole('button', { name: 'Заметка', exact: true }).click();
    const messages = discussion
      .getByRole('list', { name: 'Сообщения обсуждения' })
      .getByRole('listitem');
    await expect(messages).toHaveCount(1);
    const after = await state();
    expect(after.tasks.find((t) => t.id === taskId)).toEqual(
      before.tasks.find((t) => t.id === taskId),
    );
    expect(after.runs.filter((r) => r.taskId === taskId)).toHaveLength(
      before.runs.filter((r) => r.taskId === taskId).length,
    );

    // 6. Ответ с карточки центра; ведущий применяет; новая попытка завершает задачу.
    await page.goto(base + '/?view=attention');
    await card.getByRole('button', { name: 'Ответить' }).click();
    const answer = card.locator('form');
    await answer.getByLabel('JSON').check();
    await answer.getByLabel(/Ваш ответ/).fill('Оставьте JSON, как сейчас.');
    await answer.getByRole('button', { name: 'Ответить' }).click();
    await expect(card).toHaveAttribute('data-attention-actor', 'lead');
    expect(await execution()).toMatchObject({ state: 'current', actor: 'lead' });
    const context = await agent<{ contextDigest: string; answerDigest: string }>(
      request,
      base,
      'input_context',
      { requestId: requests[0].requestId },
    );
    const review = await agent<{ approved: boolean }>(request, base, 'input_review', {
      requestId: requests[0].requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    expect(review.approved).toBe(true);
    const target = await agent<{ version: number; targetDigest: string; problems: string[] }>(
      request,
      base,
      'input_target',
      { requestId: requests[0].requestId, contextDigest: context.contextDigest },
    );
    expect(target.problems).toEqual([]);
    await agent(request, base, 'input_apply', {
      requestId: requests[0].requestId,
      answerDigest: context.answerDigest,
      expectedVersion: target.version,
      contextDigest: context.contextDigest,
      targetDigest: target.targetDigest,
    });
    expect(
      (await request.post(base + '/api/scheduler', { headers, data: { start: true } })).ok(),
    ).toBe(true);
    await expect
      .poll(async () => (await state()).tasks.find((t) => t.id === taskId)?.status, {
        timeout: 120000,
      })
      .toBe('done');
    expect((await state()).runs.filter((r) => r.taskId === taskId)).toHaveLength(2);

    // 7. Быстрое изменение дошло до результата; карточка вопроса закрыта; в
    // обсуждении — заметка и ответ оператора.
    await expect
      .poll(async () => steps(await quick(request, base, changeId)))
      .toEqual([
        'connection:done',
        'decisions:done',
        'preparation:done',
        'execution:done',
        'result:current',
      ]);
    await page.goto(base + '/?view=attention');
    const center = page.locator('[aria-label="Центр внимания"]');
    await expect(center).toBeVisible();
    await expect(card).toHaveCount(0);
    // Решённое появление — в истории центра.
    await center.getByRole('tab', { name: 'История' }).click();
    await expect(
      center
        .getByRole('list', { name: 'История центра внимания' })
        .locator(`[data-attention-history="${key}"]`)
        .first(),
    ).toContainText(/Закрыто \d/);
    const thread = (await (
      await request.get(`${base}/api/tasks/${taskId}/discussion?limit=50`)
    ).json()) as { messages: { kind: string; text: string; author: string }[] };
    expect(thread.messages.map((m) => [m.author, m.kind])).toEqual([
      ['operator', 'note'],
      ['operator', 'answer'],
    ]);
    expect(guard.called()).toBe('');
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await app?.close();
    guard.restore();
    remove(root);
    remove(home);
    remove(checkouts);
  }
});
