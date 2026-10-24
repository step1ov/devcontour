// Наблюдение границы общих проекций chainRoots и queueStop (запускается из
// tests/harness-shared-diagnostics.test.ts с --experimental-test-module-mocks).
// Шпион записывает вход, может подменить ответ или отказать: хост обязан
// перевести вход, выдать слова над ответом harness и не иметь своей замены.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as real from 'devcontour-harness/projections';
import type {
  ChainRoot,
  ChainWork,
  QueueStopInput,
  QueueStopView,
} from 'devcontour-harness/projections';

type Mode<T> = { answer?: T; error?: Error };
let chainMode: Mode<ChainRoot[]> = {};
let queueMode: Mode<QueueStopView> = {};
const calls = {
  chain: [] as { works: ChainWork[]; maxAttempts?: number }[],
  queue: [] as QueueStopInput[],
};
const reset = () => {
  chainMode = {};
  queueMode = {};
  calls.chain.length = 0;
  calls.queue.length = 0;
};

mock.module('devcontour-harness/projections', {
  namedExports: {
    ...real,
    chainRoots: (works: ChainWork[], maxAttempts?: number) => {
      calls.chain.push({ works: structuredClone(works), maxAttempts });
      if (chainMode.error) throw chainMode.error;
      return chainMode.answer ?? real.chainRoots(works, maxAttempts);
    },
    queueStop: (input: QueueStopInput) => {
      calls.queue.push(structuredClone(input));
      if (queueMode.error) throw queueMode.error;
      return queueMode.answer ?? real.queueStop(input);
    },
  },
});

const { chainBlockers, queueStopReason } = await import('../../../src/core/work-status.ts');

const at = '2026-01-01T00:00:00.000Z';
const tasks = [
  { id: 'r', title: 'Корень', status: 'failed' as const, dependsOn: [], attempt: 3 },
  {
    id: 'h',
    title: 'Удержанная',
    status: 'ready' as const,
    dependsOn: [],
    attempt: 1,
    hold: { operation: 'op-1', reason: 'Меняется контракт' },
  },
  {
    id: 'b',
    title: 'Бюджет',
    status: 'ready' as const,
    dependsOn: [],
    attempt: 0,
    budgetBlock: { reason: 'Предел стоимости', at },
  },
  {
    id: 'a',
    title: 'Ждущая',
    status: 'ready' as const,
    dependsOn: ['r', 'h', 'b'],
    attempt: 0,
    activeRunId: undefined,
  },
  {
    id: 'x',
    title: 'Идущая',
    status: 'running' as const,
    dependsOn: [],
    attempt: 1,
    activeRunId: 'run-9',
  },
];

void test('chainBlockers передаёт задачи как работы общей проекции', () => {
  reset();
  const out = chainBlockers(tasks, 5);
  assert.equal(calls.chain.length, 1);
  assert.equal(calls.chain[0].maxAttempts, 5);
  // Только поля работы: без названия, бюджет — только причина.
  assert.deepEqual(calls.chain[0].works, [
    { id: 'r', status: 'failed', dependsOn: [], attempt: 3 },
    {
      id: 'h',
      status: 'ready',
      dependsOn: [],
      attempt: 1,
      hold: { operation: 'op-1', reason: 'Меняется контракт' },
    },
    {
      id: 'b',
      status: 'ready',
      dependsOn: [],
      attempt: 0,
      budgetBlock: { reason: 'Предел стоимости' },
    },
    { id: 'a', status: 'ready', dependsOn: ['r', 'h', 'b'], attempt: 0 },
    { id: 'x', status: 'running', dependsOn: [], attempt: 1, activeRunId: 'run-9' },
  ]);
  // Настоящий ответ проходит без изменений порядка и счётчиков.
  assert.deepEqual(
    out.map((x) => [x.taskId, x.title, x.waiting]),
    real
      .chainRoots(calls.chain[0].works, 5)
      .map((r) => [r.workId, tasks.find((t) => t.id === r.workId)!.title, r.waiting]),
  );
  chainBlockers(tasks);
  assert.equal(calls.chain[1].maxAttempts, 3, 'умолчание хоста — 3');
});

void test('chainBlockers называет словами подменённый ответ, а не пересчитывает корни', () => {
  reset();
  chainMode = {
    answer: [
      { workId: 'a', code: 'held', detail: 'SPY', waiting: 7, actor: 'controller', action: 'wait' },
      {
        workId: 'x',
        code: 'budget-blocked',
        detail: 'SPY-BUDGET',
        waiting: 1,
        actor: 'user',
        action: 'raise-budget',
      },
    ],
  };
  assert.deepEqual(chainBlockers(tasks, 3), [
    {
      taskId: 'a',
      title: 'Ждущая',
      reason: 'удержана: SPY',
      next: 'дождаться завершения операции',
      waiting: 7,
    },
    {
      taskId: 'x',
      title: 'Идущая',
      reason: 'SPY-BUDGET',
      next: 'осознанно поднять предел в budgets или задать политику onUnknown',
      waiting: 1,
    },
  ]);
  chainMode = { answer: [] };
  assert.deepEqual(chainBlockers(tasks, 3), [], 'пустой ответ harness — нет корней и у хоста');
});

void test('chainBlockers не подменяет отказ общей проекции своим результатом', () => {
  reset();
  const error = new Error('shared failure');
  chainMode = { error };
  assert.throws(
    () => chainBlockers(tasks, 3),
    (e) => e === error,
  );
});

const events = [
  { id: 3, type: 'scheduler.error', data: { error: 'TaskFailure: первая' } },
  { id: 7, type: 'task.updated', data: { error: 'не ошибка планировщика' } },
  { id: 5, type: 'scheduler.error', data: {} },
  { id: 1, type: 'scheduler.error', data: { error: 'Error: старая' } },
];

void test('queueStopReason передаёт журнал как ошибки с номером события', () => {
  reset();
  queueStopReason({ paused: true, pauseReason: 'runtime' }, events);
  queueStopReason({ paused: false }, events);
  queueStopReason({}, []);
  assert.deepEqual(calls.queue, [
    {
      paused: true,
      pauseReason: 'runtime',
      errors: [
        { seq: 3, message: 'TaskFailure: первая' },
        { seq: 5, message: undefined },
        { seq: 1, message: 'Error: старая' },
      ],
    },
    {
      paused: false,
      errors: [
        { seq: 3, message: 'TaskFailure: первая' },
        { seq: 5, message: undefined },
        { seq: 1, message: 'Error: старая' },
      ],
    },
    { paused: false, errors: [] },
  ]);
});

void test('queueStopReason отдаёт detail подменённого ответа', () => {
  reset();
  queueMode = { answer: { paused: true, reason: 'runtime', detail: 'SPY' } };
  // Даже без паузы у хоста: решает ответ harness.
  assert.equal(queueStopReason({ paused: false }, []), 'SPY');
  queueMode = { answer: { paused: true, reason: 'runtime' } };
  assert.equal(queueStopReason({ paused: true }, events), undefined);
});

void test('queueStopReason не подменяет отказ общей проекции', () => {
  reset();
  const error = new Error('shared failure');
  queueMode = { error };
  assert.throws(
    () => queueStopReason({ paused: true }, events),
    (e) => e === error,
  );
});
