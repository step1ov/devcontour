// Характеристика host-планирования: запрос planner к рантайму, допустимость
// плана и импорт доски. Общая сборка planning request может переехать в
// harness; DevContour.importPlan, его ревизии, ID и host-поля остаются здесь.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../src/runner/planner.ts';
import { planResult, planSchema } from '../src/core/plan.ts';
import { complete, fixture, input, MERGED } from './helpers.ts';

const planned = (count: number, extra: (i: number) => Record<string, unknown> = () => ({})) => ({
  title: 'Первый срез',
  description: 'Небольшой вертикальный срез',
  tasks: Array.from({ length: count }, (_, i) => ({
    ...input('Задача номер ' + i),
    key: 'k' + i,
    dependsOn: i ? ['k' + (i - 1)] : [],
    contracts: [],
    ...extra(i),
  })),
});

test('Baseline planner: request is read-only planning with declared roles, gates, resources and the brief', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'devcontour-baseline-plan-'));
  try {
    f.h.config.mode = 'local';
    f.h.config.roles = {
      engine: {
        runtime: 'claude',
        title: 'Разработчик ядра',
        writePaths: ['packages/engine/src'],
        requiresContract: true,
        reviewer: { runtime: 'codex' },
      },
      'qa-api': { runtime: 'codex', writePaths: ['e2e/api'], reviewer: { runtime: 'claude' } },
    } as never;
    type Request = {
      purpose: string;
      review: boolean;
      cwd: string;
      model?: string;
      timeoutMs: number;
      prompt: string;
    };
    const requests: Request[] = [];
    const result = await plan(f.h, root, 'Бриф: поиск товаров', 'claude', 'model-x', {
      claude: {
        name: 'claude' as const,
        execute: (request: Request) => {
          requests.push(request);
          return Promise.resolve({
            data: {
              title: 'План ядра',
              description: 'Первый срез',
              tasks: [
                {
                  key: 'engine-core',
                  title: 'Ядро расчёта',
                  description: 'Реализовать перебор сборки по утверждённому контракту.',
                  role: 'engine',
                  dependsOn: [],
                  acceptance: ['Гейт задачи проходит целиком.'],
                  contracts: [],
                  writePaths: ['packages/engine/src'],
                },
                {
                  key: 'api-check',
                  title: 'Проверка API',
                  description: 'Сценарий API подтверждает расчёт ядра.',
                  role: 'qa-api',
                  dependsOn: ['engine-core'],
                  acceptance: ['Сценарий API проходит.'],
                  contracts: [],
                  writePaths: ['e2e/api'],
                },
              ],
            },
            log: '',
            command: ['fixture'],
          });
        },
      },
    } as never);
    // Модель вызвана один раз, в режиме plan с независимым ревью.
    assert.equal(requests.length, 1);
    const r = requests[0];
    assert.equal(r.purpose, 'plan');
    assert.equal(r.review, true);
    assert.equal(r.cwd, f.h.config.repository);
    assert.equal(r.model, 'model-x');
    assert.equal(r.timeoutMs, f.h.config.runTimeoutMs);
    const prompt = r.prompt;
    assert.match(prompt, /^You are a product planner\. Inspect the repository read-only\./);
    assert.match(prompt, /at most 15 tasks/);
    assert.match(
      prompt,
      /Do not edit files, run implementation agents, commit, or mark tasks done/,
    );
    assert.ok(
      prompt.includes(
        JSON.stringify([
          {
            repositoryId: 'main',
            roles: [
              {
                role: 'engine',
                title: 'Разработчик ядра',
                writePaths: ['packages/engine/src'],
                requiresContract: true,
              },
              { role: 'qa-api', writePaths: ['e2e/api'], requiresContract: false },
            ],
          },
        ]),
      ),
      'объявленные роли переданы как есть',
    );
    assert.ok(
      prompt.includes(
        JSON.stringify([{ repositoryId: 'main', gates: [{ id: 'test', kind: 'test' }] }]),
      ),
    );
    assert.doesNotMatch(prompt, /"role":"architect"|"role":"backend"/);
    assert.ok(prompt.includes('Available resource IDs: []'));
    assert.ok(prompt.includes('Approved contracts available'));
    assert.ok(prompt.endsWith('User brief:\nБриф: поиск товаров'));
    // Артефакт плана сохранён, импорт создал черновики без утверждения.
    assert.ok(existsSync(result.output));
    assert.equal(planResult.parse(JSON.parse(readFileSync(result.output, 'utf8'))).tasks.length, 2);
    assert.equal(result.tasks, 2);
    const s = f.store.read();
    const board = s.boards.find((b) => b.id === result.boardId)!;
    assert.equal(board.revisions.length, 1);
    assert.equal(board.revisions[0].status, 'active');
    const tasks = s.tasks.filter((t) => board.revisions[0].taskIds.includes(t.id));
    assert.deepEqual(
      tasks.map((t) => [t.role, t.status, t.attempt]),
      [
        ['engine', 'draft', 0],
        ['qa-api', 'draft', 0],
      ],
    );
    assert.ok(tasks.every((t) => /^T/.test(t.id)));
    assert.deepEqual(tasks[1].dependsOn, [tasks[0].id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.cleanup();
  }
});

test('Baseline planner: a refused runtime result imports nothing', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'devcontour-baseline-plan-'));
  try {
    f.h.config.mode = 'local';
    const before = f.store.read();
    await assert.rejects(
      plan(f.h, root, 'Бриф', 'claude', undefined, {
        claude: {
          name: 'claude' as const,
          execute: () =>
            Promise.resolve({ data: { title: 'x', tasks: [] }, log: '', command: ['fixture'] }),
        },
      } as never),
    );
    assert.deepEqual(f.store.read().tasks, before.tasks);
    assert.deepEqual(f.store.read().boards, before.boards);
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.cleanup();
  }
});

test('Baseline plan schema: 1..30 tasks in both the runtime JSON schema and the import schema', () => {
  type JsonSchema = {
    additionalProperties?: boolean;
    properties: {
      tasks: {
        minItems: number;
        maxItems: number;
        items: { required: string[]; properties: Record<string, unknown> };
      };
    };
  };
  const schema = planSchema as unknown as JsonSchema;
  const tasks = schema.properties.tasks;
  assert.equal(tasks.minItems, 1);
  assert.equal(tasks.maxItems, 30);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...tasks.items.required].sort(), [
    'acceptance',
    'contracts',
    'dependsOn',
    'description',
    'key',
    'repositoryId',
    'role',
    'scope',
    'title',
  ]);
  for (const field of [
    'featureId',
    'requirements',
    'assignee',
    'scope',
    'relatedRepositories',
    'contextPacks',
    'writePaths',
    'gates',
    'properties',
    'resources',
    'repositoryId',
  ])
    assert.ok(field in tasks.items.properties, field);
  assert.equal(planResult.safeParse(planned(30)).success, true);
  assert.equal(planResult.safeParse(planned(31)).success, false);
  assert.equal(planResult.safeParse(planned(0)).success, false);
});

test('Baseline import: a legacy 16..30 task plan is valid; bad plans are refused atomically', () => {
  const f = fixture();
  try {
    for (const count of [16, 30]) {
      const result = f.h.importPlan(planned(count));
      assert.equal(result.tasks, count);
    }
    const before = f.store.read();
    const refusals: [unknown, RegExp][] = [
      [
        planned(2, (i) => (i ? { dependsOn: ['absent'] } : {})),
        /Неизвестная зависимость плана absent/,
      ],
      [planned(2, () => ({ key: 'same' })), /Ключи задач должны быть уникальны/],
      [planned(2, (i) => ({ dependsOn: [i ? 'k0' : 'k1'] })), /Цикл/],
      [planned(1, () => ({ role: 'nobody' })), /роль|role/i],
    ];
    for (const [bad, error] of refusals) {
      assert.throws(() => f.h.importPlan(bad), error);
      assert.deepEqual(f.store.read(), before, String(error));
    }
  } finally {
    f.cleanup();
  }
});

test('Baseline import: host fields survive schema and import; next stage keeps the accepted revision', () => {
  const f = fixture();
  try {
    f.h.config.resources = [{ id: 'db', kind: 'service', value: 'postgres://localhost/shop' }];
    const full = planned(1, () => ({
      repositoryId: 'main',
      scope: 'component',
      writePaths: ['src/api'],
      gates: ['test'],
      contextPacks: [],
      resources: ['db'],
      assignee: 'alice',
    }));
    const first = f.h.importPlan(full);
    const task = f.store.read().tasks.at(-1)!;
    assert.equal(task.repositoryId, 'main');
    assert.equal(task.scope, 'component');
    assert.deepEqual(task.writePaths, ['src/api']);
    assert.deepEqual(task.gates, ['test']);
    assert.deepEqual(task.resources, ['db']);
    assert.equal(task.assignee, 'alice');
    assert.equal(task.status, 'draft');
    // Следующий этап — только после приёмки текущей ревизии и той же доской.
    assert.throws(() => f.h.importPlan(planned(1), first.boardId), /после приёмки текущей ревизии/);
    f.h.approve(first.boardId);
    complete(f.h, task.id);
    f.h.accept(first.boardId, MERGED);
    const next = f.h.importPlan(planned(1), first.boardId) as { revision?: number };
    assert.equal(next.revision, 2);
    const board = f.store.read().boards.find((b) => b.id === first.boardId)!;
    assert.equal(board.revisions[0].status, 'accepted');
    assert.equal(board.revisions[1].status, 'active');
    assert.ok(board.revisions[1].taskIds.includes(task.id), 'принятая задача перенесена');
    assert.equal(f.store.read().tasks.find((t) => t.id === task.id)!.status, 'done');
  } finally {
    f.cleanup();
  }
});
