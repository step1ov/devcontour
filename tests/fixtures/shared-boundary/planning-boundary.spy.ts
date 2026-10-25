// Наблюдение границы планирования (запускается из
// tests/harness-shared-planning.test.ts с --experimental-test-module-mocks).
// Шпионы оборачивают настоящие planningRequest, draftIssues и planDraft
// установленного пакета: подменённый ответ определяет результат хоста, отказ
// доходит как есть, без локального продолжения.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realRoot from 'devcontour-harness';
import * as realContracts from 'devcontour-harness/contracts';

type Mode = {
  prompt?: string;
  requestError?: Error;
  issues?: realRoot.CodedIssue[];
  issuesError?: Error;
};
let mode: Mode = {};
const calls = {
  request: [] as Parameters<typeof realRoot.planningRequest>[0][],
  issues: [] as Parameters<typeof realRoot.draftIssues>[],
  draft: [] as Parameters<typeof realContracts.planDraft>[],
};

mock.module('devcontour-harness', {
  namedExports: {
    ...realRoot,
    planningRequest: (input: Parameters<typeof realRoot.planningRequest>[0]) => {
      calls.request.push(input);
      if (mode.requestError) throw mode.requestError;
      const real = realRoot.planningRequest(input);
      return mode.prompt ? { ...real, prompt: mode.prompt } : real;
    },
    draftIssues: (...args: Parameters<typeof realRoot.draftIssues>) => {
      calls.issues.push(args);
      if (mode.issuesError) throw mode.issuesError;
      return mode.issues ?? realRoot.draftIssues(...args);
    },
  },
});
mock.module('devcontour-harness/contracts', {
  namedExports: {
    ...realContracts,
    planDraft: (...args: Parameters<typeof realContracts.planDraft>) => {
      calls.draft.push(args);
      return realContracts.planDraft(...args);
    },
  },
});
const { plan, hostInstructions } = await import('../../../src/runner/planner.ts');
const { fixture, input } = await import('../../helpers.ts');

const reset = (next: Mode = {}) => {
  mode = next;
  calls.request.length = 0;
  calls.issues.length = 0;
};
const draft = (count = 2) => ({
  title: 'План',
  description: '',
  tasks: Array.from({ length: count }, (_, i) => ({
    ...input('Задача ' + i),
    key: 'k' + i,
    dependsOn: i ? ['k' + (i - 1)] : [],
    contracts: [],
  })),
});
function runtime(seen: string[]) {
  return {
    claude: {
      name: 'claude' as const,
      execute: (r: { prompt: string }) => {
        seen.push(r.prompt);
        return Promise.resolve({ data: draft(), log: '', command: ['fixture'] });
      },
    },
  } as never;
}

void test('planResult строится общей planDraft с полями хоста и прежним порядком', () => {
  assert.equal(calls.draft.length, 1, 'схема плана — один вызов при загрузке модуля');
  const [extension, options] = calls.draft[0];
  assert.deepEqual(Object.keys(extension ?? {}), ['featureId', 'assignee']);
  assert.deepEqual(options?.keyOrder?.slice(0, 4), [
    'featureId',
    'requirements',
    'assignee',
    'scope',
  ]);
  assert.equal(options?.keyOrder?.length, 18);
});

void test('planner передаёт факты и host-инструкции и отдаёт runtime prompt общей операции', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'devcontour-plan-spy-'));
  try {
    f.h.config.mode = 'local';
    const seen: string[] = [];
    reset({ prompt: 'SPY PROMPT' });
    await plan(f.h, root, 'Бриф', 'claude', undefined, runtime(seen));
    assert.equal(calls.request.length, 1);
    const [req] = calls.request;
    assert.equal(req.brief, 'Бриф');
    assert.deepEqual(req.hostInstructions, hostInstructions);
    assert.deepEqual(
      req.facts.roles[0].roles.map((r) => r.role),
      Object.keys(f.h.config.roles),
    );
    assert.deepEqual(req.facts.gates, [
      { repositoryId: 'main', gates: [{ id: 'test', kind: 'test' }] },
    ]);
    assert.deepEqual(seen, ['SPY PROMPT'], 'модель получает prompt из ответа harness');
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.cleanup();
  }
});

void test('отказ planningRequest — тот же объект, без вызова модели и импорта', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'devcontour-plan-spy-'));
  try {
    f.h.config.mode = 'local';
    const seen: string[] = [];
    const requestError = new realRoot.HarnessError('INVALID_INPUT', 'spy: запрос');
    reset({ requestError });
    const before = JSON.stringify(f.store.read());
    await assert.rejects(
      plan(f.h, root, 'Бриф', 'claude', undefined, runtime(seen)),
      (e) => e === requestError,
    );
    assert.deepEqual(seen, []);
    assert.equal(JSON.stringify(f.store.read()), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    f.cleanup();
  }
});

void test('importPlan отказывает по ответу draftIssues: зависимость 404, повтор 400, цикл — атомарно', () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.store.read());
    // Настоящий план чистый: отказ мог дать только подменённый ответ harness.
    reset({
      issues: [
        {
          code: 'GRAPH_UNKNOWN_DEPENDENCY',
          path: ['tasks', 1, 'dependsOn', 0],
          message: 'Неизвестная зависимость плана spy',
        },
      ],
    });
    assert.throws(
      () => f.h.importPlan(draft()),
      (e: Error & { status?: number }) =>
        e.message === 'Неизвестная зависимость плана spy' && e.status === 404,
    );
    assert.equal(calls.issues.length, 1);
    assert.deepEqual(calls.issues[0][1], { known: [] });
    reset({ issues: [{ code: 'GRAPH_DUPLICATE_ID', path: ['tasks', 1, 'key'], message: 'x' }] });
    assert.throws(
      () => f.h.importPlan(draft()),
      (e: Error & { status?: number }) =>
        e.message === 'Ключи задач должны быть уникальны' && e.status === 400,
    );
    reset({
      issues: [{ code: 'GRAPH_CYCLE', path: ['tasks', 0, 'dependsOn'], message: 'spy: цикл' }],
    });
    assert.throws(() => f.h.importPlan(draft()), /^Error: spy: цикл$/);
    assert.equal(JSON.stringify(f.store.read()), before, 'ничего не записано');
    // Пустой ответ на настоящем плане — импорт проходит, known — ID состояния.
    reset();
    f.h.importPlan(draft());
    const ids = f.store.read().tasks.map((t) => t.id);
    reset({ issues: [] });
    f.h.importPlan(draft(1));
    assert.deepEqual(calls.issues[0][1], { known: ids });
  } finally {
    f.cleanup();
  }
});

void test('отказ draftIssues — тот же объект, без записи', () => {
  const f = fixture();
  try {
    const issuesError = new Error('spy: проверка');
    reset({ issuesError });
    const before = JSON.stringify(f.store.read());
    assert.throws(
      () => f.h.importPlan(draft()),
      (e) => e === issuesError,
    );
    assert.equal(JSON.stringify(f.store.read()), before);
  } finally {
    f.cleanup();
  }
});
