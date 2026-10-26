// M03: общий запрос планирования, схема draft и структурная проверка плана —
// операции установленного harness. Хост: факты из своей конфигурации,
// продуктовые инструкции, учёт вызова, артефакт и importPlan (ID, ревизии,
// назначение, транзакция). Схема плана и каталог агентского API байтово
// прежние; порядок и статусы отказов импорта прежние.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { planDraft, planDraftJsonSchema, planningRequest } from 'devcontour-harness';
import { planResult, planSchema } from '../src/core/plan.ts';
import { hostInstructions, plan } from '../src/runner/planner.ts';
import { capabilities } from '../src/application/agent.ts';
import { digest } from '../src/core/service.ts';
import { config, fixture, input } from './helpers.ts';
import {
  declaredRoles,
  repositories,
  requiresContract,
  roleBinding,
} from '../src/core/repositories.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// Снято до переключения на HEAD d3e2d10 и совпадает с baseline ab35a6a:
//   node --import tsx -e "import('./src/core/plan.ts').then(m=>process.stdout.write(JSON.stringify(m.planSchema)))"
//   ... z.toJSONSchema(m.planResult, { io: 'input' }) ...; digest(capabilities())
const PLAN_SCHEMA_SHA = 'b6461127f7f0831181187c2d2d9c87671f5a196ecf97d9010120a86b7e46179e';
const PLAN_INPUT_SCHEMA_SHA = '36c5ec758791d049f5929522d60dd730363d925c07cedc144f682703db4f05f7';
// Каталог снят на 0.4.0-alpha.7 и называет версию продукта: digest — с версией снимка.
const CATALOG_DIGEST = '862305bac2a606004d67a709234f7bbcd08c666e8bcd1b243a0d75e303770f1e';

test('M03 схема: planResult — planDraft harness; JSON Schema runtime, inputSchema plan_import и catalogDigest байтово прежние', () => {
  assert.equal(sha(JSON.stringify(planSchema)), PLAN_SCHEMA_SHA);
  assert.equal(
    sha(JSON.stringify(z.toJSONSchema(planResult, { io: 'input' }))),
    PLAN_INPUT_SCHEMA_SHA,
  );
  assert.equal(digest({ ...capabilities(), version: '0.4.0-alpha.7' }), CATALOG_DIGEST);
  // Порядок полей держит keyOrder: без него у того же расширения байты другие.
  const bare = planDraft({
    featureId: z.string().optional(),
    assignee: z.string().optional(),
  });
  assert.notEqual(sha(JSON.stringify(planDraftJsonSchema(bare))), PLAN_SCHEMA_SHA);
  // Лишние ключи (самоутверждение) отбрасываются, а не принимаются.
  const parsed = planResult.parse({
    title: 'План',
    description: '',
    approved: true,
    tasks: [{ ...input(), key: 'a', dependsOn: [], contracts: [], status: 'done', approved: true }],
  });
  assert.equal('approved' in parsed, false);
  assert.equal('status' in parsed.tasks[0], false);
});

test('M03 запрос: prompt planner — ответ planningRequest harness на фактах хоста; продуктовые строки — один блок перед brief', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'devcontour-shared-plan-'));
  try {
    f.h.config.mode = 'local';
    f.h.config.resources = [
      { id: 'db', kind: 'service', value: 'postgres://secret@localhost/shop' },
    ];
    const contract = f.h.contract('API', 'GET /items → 200');
    const prompts: string[] = [];
    await plan(f.h, root, 'Бриф: каталог', 'claude', undefined, {
      claude: {
        name: 'claude' as const,
        execute: (r: { prompt: string }) => {
          prompts.push(r.prompt);
          return Promise.resolve({
            data: {
              title: 'План',
              description: '',
              tasks: [{ ...input(), key: 'a', dependsOn: [], contracts: [] }],
            },
            log: '',
            command: ['fixture'],
          });
        },
      },
    } as never);
    assert.equal(prompts.length, 1, 'один вызов модели');
    const [prompt] = prompts;
    // Тот же запрос строит общая операция установленного пакета.
    const s = f.store.read();
    const c = f.h.config;
    const expected = planningRequest({
      brief: 'Бриф: каталог',
      hostInstructions,
      facts: {
        repositories: repositories(c).map(({ id, name, kind, path }) => ({ id, name, kind, path })),
        roles: repositories(c).map((r) => ({
          repositoryId: r.id,
          roles: declaredRoles(c, r.id).map((role) => ({
            role,
            title: roleBinding(c, role, r.id)?.title,
            writePaths: roleBinding(c, role, r.id)?.writePaths,
            requiresContract: requiresContract(c, role, r.id),
          })),
        })),
        gates: [{ repositoryId: 'main', gates: [{ id: 'test', kind: 'test' }] }],
        contextPacks: c.contextPacks,
        resources: c.resources,
        contracts: s.contracts.map((x) => ({ ...x })),
      },
    }).prompt;
    assert.equal(prompt, expected);
    // Общие разделы — по одному разу и без продуктовых строк хоста.
    const [shared, rest] = prompt.split('\n\nHost instructions:\n');
    assert.ok(rest.endsWith('\n\nUser brief:\nБриф: каталог'));
    for (const line of hostInstructions) {
      assert.equal(prompt.split(line).length, 2, 'строка хоста ровно одна: ' + line.slice(0, 40));
      assert.equal(shared.includes(line), false);
    }
    for (const once of [
      'Inspect the repository read-only.',
      'Declared roles, by repository.',
      'User brief:',
    ])
      assert.equal(prompt.split(once).length, 2, once);
    assert.equal(shared.includes('requirements_snapshot'), false);
    // Контракт целиком (M-4), значения ресурсов не раскрываются.
    assert.ok(shared.includes(JSON.stringify(contract).slice(1, -1)));
    assert.equal(prompt.includes('postgres://secret'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.cleanup();
  }
});

test('M03 запрос: отказы общей операции — без вызова модели и без импорта', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'devcontour-shared-plan-'));
  try {
    f.h.config.mode = 'local';
    let calls = 0;
    const runtime = {
      claude: { name: 'claude' as const, execute: () => (calls++, Promise.reject(new Error('x'))) },
    } as never;
    const before = JSON.stringify(f.store.read());
    await assert.rejects(plan(f.h, root, '  \n', 'claude', undefined, runtime), {
      name: 'HarnessError',
      code: 'INVALID_INPUT',
      message: 'Пустая постановка: планировать нечего',
    });
    f.h.config.roles = {};
    await assert.rejects(plan(f.h, root, 'Бриф', 'claude', undefined, runtime), {
      code: 'INVALID_INPUT',
      message:
        'В конфигурации не объявлено ни одной роли: планировать некому. Объявите роли в профиле или в workspace.',
    });
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(f.store.read()), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.cleanup();
  }
});

const planned = (count: number, extra: (i: number) => Record<string, unknown> = () => ({})) => ({
  title: 'Срез',
  description: '',
  tasks: Array.from({ length: count }, (_, i) => ({
    ...input('Задача номер ' + i),
    key: 'k' + i,
    dependsOn: i ? ['k' + (i - 1)] : [],
    contracts: [],
    ...extra(i),
  })),
});

test('M03 импорт: при нескольких ошибках первым — прежний отказ хоста; статусы 400/404; атомарно', () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.store.read());
    const refused = (bad: unknown, status: number | undefined, message: RegExp) => {
      assert.throws(
        () => f.h.importPlan(bad),
        (e: Error & { status?: number }) => {
          assert.match(e.message, message);
          if (status !== undefined) assert.equal(e.status, status);
          return true;
        },
      );
      assert.equal(JSON.stringify(f.store.read()), before, String(message));
    };
    // Повтор ключа — раньше всего, даже при неизвестной роли и зависимости.
    refused(
      planned(2, (i) => ({ key: 'same', role: 'nobody', dependsOn: i ? ['absent'] : [] })),
      400,
      /^Ключи задач должны быть уникальны$/,
    );
    // Неизвестная роль первой задачи раньше неизвестной зависимости второй.
    refused(
      planned(2, (i) => (i ? { dependsOn: ['absent'] } : { role: 'nobody' })),
      undefined,
      /Роль nobody не объявлена/,
    );
    // Неизвестная зависимость первой задачи раньше её же роли и роли второй.
    refused(
      planned(2, (i) => (i ? { role: 'nobody' } : { dependsOn: ['absent'], role: 'nobody' })),
      404,
      /^Неизвестная зависимость плана absent$/,
    );
    // Цикл — после проверок задач: роль называется раньше цикла.
    refused(
      planned(2, (i) => ({ dependsOn: [i ? 'k0' : 'k1'], ...(i ? { role: 'nobody' } : {}) })),
      undefined,
      /Роль nobody не объявлена/,
    );
    // Цикл и зависимость от себя — прежний отказ графа задачами состояния.
    refused(
      planned(2, (i) => ({ dependsOn: [i ? 'k0' : 'k1'] })),
      undefined,
      /^Цикл зависимостей: T/,
    );
    refused(
      planned(1, () => ({ dependsOn: ['k0'] })),
      undefined,
      /^Цикл зависимостей: T/,
    );
    // Ключ сильнее существующего ID; существующий ID — допустимая зависимость.
    const first = f.h.importPlan(planned(1));
    const existing = f.store.read().tasks.at(-1)!.id;
    f.h.importPlan(planned(1, () => ({ dependsOn: [existing] })));
    assert.deepEqual(f.store.read().tasks.at(-1)!.dependsOn, [existing]);
    assert.ok(first.boardId);
  } finally {
    f.cleanup();
  }
});

test('AC15: host metadata без потерь — runtime output schema → planResult → importPlan', () => {
  const f = fixture();
  try {
    f.h.config.resources = [{ id: 'db', kind: 'service', value: 'fixture' }];
    f.h.config.contextPacks = [
      { id: 'lib', version: '1.0.0', repositoryId: 'main', roles: [], files: ['docs/lib.md'] },
    ] as never;
    const contract = f.h.contract('API', 'GET /items → 200');
    const text = 'Покупатель находит товар по названию.';
    const task = {
      key: 'search',
      title: 'Поиск товаров',
      description: 'Поиск по названию в каталоге.',
      role: 'backend',
      dependsOn: [] as string[],
      acceptance: ['Поиск находит товар.'],
      contracts: [contract.id],
      featureId: 'catalog-search',
      requirements: [
        {
          id: 'REQ-search',
          source: 'docs/spec.md',
          digest: sha(text),
          text,
          gate: 'test',
          scenario: 'Поиск по названию',
          testId: 'search.finds',
        },
      ],
      assignee: 'alice',
      scope: 'component',
      contextPacks: ['lib'],
      writePaths: ['src/search'],
      gates: ['test'],
      properties: ['search.finds'],
      resources: ['db'],
      repositoryId: 'main',
    };
    const output = {
      title: 'План',
      description: 'Срез',
      tasks: [task, { ...task, key: 'ui', dependsOn: ['search'], requirements: undefined }],
    };
    // Каждое поле ответа объявлено в JSON Schema, которую получает CLI модели
    // (additionalProperties:false): runtime не вынужден его отбросить.
    type Schema = {
      properties: {
        tasks: { items: { properties: Record<string, unknown>; additionalProperties: boolean } };
      };
    };
    const items = (planSchema as unknown as Schema).properties.tasks.items;
    assert.equal(items.additionalProperties, false);
    for (const key of Object.keys(task)) assert.ok(key in items.properties, key);
    const parsed = planResult.parse(output);
    f.h.importPlan(parsed);
    const [a, b] = f.store.read().tasks.slice(-2);
    for (const field of [
      'featureId',
      'requirements',
      'assignee',
      'scope',
      'contextPacks',
      'writePaths',
      'gates',
      'properties',
      'resources',
      'repositoryId',
      'contracts',
      'title',
      'description',
      'role',
      'acceptance',
    ] as const)
      assert.deepEqual(a[field], (task as Record<string, unknown>)[field], field);
    assert.deepEqual(b.dependsOn, [a.id]);
    assert.equal(a.status, 'draft', 'импорт не утверждает');
  } finally {
    f.cleanup();
  }
});

test('AC15: relatedRepositories задачи workspace сохраняются', () => {
  const f = fixture();
  try {
    Object.assign(
      f.h.config,
      config({
        workspaceRoot: '/tmp',
        repositories: [
          { id: 'main', name: 'Main', kind: 'product', path: '/tmp/main', gates: config().gates },
          { id: 'lib', name: 'Lib', kind: 'library', path: '/tmp/lib', gates: config().gates },
        ],
      } as never),
    );
    f.h.importPlan(
      planned(1, () => ({ scope: 'workspace', relatedRepositories: ['main', 'lib'] })),
    );
    const t = f.store.read().tasks.at(-1)!;
    assert.equal(t.scope, 'workspace');
    assert.deepEqual(t.relatedRepositories, ['main', 'lib']);
  } finally {
    f.cleanup();
  }
});

function spyRun(fixtureFile: string) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--disable-warning=ExperimentalWarning',
      '--import',
      'tsx',
      '--test',
      '--test-reporter=spec',
      fixtureFile,
    ],
    { cwd: resolve('.'), env, encoding: 'utf8', timeout: 240_000 },
  );
}

test('M03 граница: planner, схема и импорт используют ответ harness; отказ общей операции — без fallback', () => {
  const file = 'tests/fixtures/shared-boundary/planning-boundary.spy.ts';
  assert.ok(existsSync(file));
  const result = spyRun(file);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ℹ fail 0$/m);
  const pass = Number(/^ℹ pass (\d+)$/m.exec(result.stdout)?.[1] ?? -1);
  assert.ok(pass >= 5, result.stdout);
});

test('M03 AC02: в DevContour нет общих разделов prompt и своей проверки структуры плана', () => {
  const planner = readFileSync('src/runner/planner.ts', 'utf8');
  for (const shared of [
    'Inspect the repository read-only',
    'Declared roles, by repository',
    'Configured checks, by repository',
    'Use a DAG with stable local keys',
    'Keep component tasks scoped',
    'Available repositories',
    'Assign narrow writePaths',
    'Available context packs',
    'Available resource IDs',
    'Approved contracts available',
    'User brief',
    'at most 15',
  ])
    assert.equal(planner.includes(shared), false, shared);
  assert.match(planner, /planningRequest\(/);
  const plan = readFileSync('src/core/plan.ts', 'utf8');
  assert.match(plan, /planDraft\(/);
  assert.doesNotMatch(plan, /z\.object|z\.array|regex\(/);
  const service = readFileSync('src/core/service.ts', 'utf8');
  const importPlan = service.slice(
    service.indexOf('  importPlan('),
    service.indexOf('  editBoard('),
  );
  assert.match(importPlan, /draftIssues\(/);
  assert.doesNotMatch(importPlan, /ids\.has\(|requireValue\(/);
});
