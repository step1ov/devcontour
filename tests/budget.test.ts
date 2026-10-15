import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { TaskFailure } from '../src/core/failure.ts';
import { priceUsage, usageTotals, type Price, type UsageRecord } from '../src/core/usage.ts';
import { budgetOverview, budgetStatus } from '../src/core/budget.ts';
import { abandonCalls, measuredExecute } from '../src/runner/usage.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { chainBlockers } from '../src/core/work-status.ts';
import type { AgentRequest } from '../src/runner/adapters.ts';
import { config, input } from './helpers.ts';

const price: Price = {
  runtime: 'claude',
  model: 'cheap',
  effectiveAt: '2026-01-01T00:00:00.000Z',
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
};
const usage = (complete = true, reportedUsd: number | null = null) => ({
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reportedUsd,
  complete,
  source: 'claude-result' as const,
});
const request = {
  prompt: 'p',
  model: 'cheap',
  signal: new AbortController().signal,
} as AgentRequest;

/** Контур с бюджетами; `reopen` — тот же store после перезапуска процесса. */
function contour(overrides: Partial<Config>) {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-budget-'));
  const store = new Store(join(root, 'state.sqlite'));
  const cfg = config({ prices: [price], ...overrides });
  const h = new DevContour(store, cfg);
  return {
    h,
    store,
    reopen: (next: Partial<Config> = overrides) =>
      new DevContour(store, config({ prices: [price], ...next })),
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Вызов модели, сообщающий usage: оценка по тарифу $3 за вызов. */
const spend = (h: DevContour, runId: string, outcome: 'ok' | 'error' = 'ok', u = usage()) =>
  measuredExecute(
    h,
    {
      name: 'claude',
      version: 'fixture',
      execute: async (r) => {
        await Promise.resolve();
        r.onUsage!(u);
        if (outcome === 'error') throw new Error('provider failed');
        return { data: {}, log: '', command: [] };
      },
    },
    request,
    { repositoryId: 'main', runId, stage: 'implementation' },
  );

test('B01: budgets are optional, each limit needs usd or timeMs, and unknown cost stops by default', () => {
  assert.equal(config().budgets, undefined);
  assert.throws(() => config({ budgets: { task: {} } as Config['budgets'] }), /usd или timeMs/);
  assert.equal(
    config({ budgets: { task: { usd: 1 } } as Config['budgets'] }).budgets?.onUnknown,
    'stop',
  );
  assert.throws(() => configSchema.parse({ ...config(), budgets: { task: { usd: -1 } } }));
});

test('B02/B04: reported and estimated spend stay separate; partial counters of a broken call are not estimated; the tariff follows the reported model', async () => {
  // Неполные счётчики оборванного вызова — не стоимость: оценка была бы нижней границей.
  assert.deepEqual(priceUsage(usage(false), price), { costUsd: null, costSource: 'unknown' });
  assert.deepEqual(priceUsage(usage(true), price), { costUsd: 3, costSource: 'tariff-estimate' });
  const f = contour({});
  try {
    const b = f.h.createBoard('Budget board', '', 'main');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    await spend(f.h, run.id);
    await spend(f.h, run.id, 'ok', usage(true, 0.5));
    // Runtime сообщил другую модель: тариф запрошенной к ней не относится.
    await measuredExecute(
      f.h,
      {
        name: 'claude',
        execute: async (r) => {
          await Promise.resolve();
          r.onUsage!(usage(), 'v', 'expensive');
          return { data: {}, log: '', command: [] };
        },
      },
      request,
      { repositoryId: 'main', runId: run.id, stage: 'implementation' },
    );
    const records = Object.values(f.store.localRecords<UsageRecord>('usage', 'main'));
    const other = records.find((r) => r.model === 'expensive')!;
    assert.equal(other.costSource, 'unknown');
    assert.equal(other.price, undefined);
    const totals = usageTotals(records);
    assert.equal(totals.reportedUsd, 0.5);
    assert.equal(totals.estimatedUsd, 3);
    assert.equal(totals.knownCostUsd, 3.5);
    assert.equal(totals.unknownCalls, 1);
    assert.equal(workflowMetrics(f.h, 'main').usage.reportedUsd, 0.5);
  } finally {
    f.cleanup();
  }
});

test('B03: a call whose process died is closed as abandoned and counted; a live call stays unfinished', () => {
  const f = contour({ budgets: { workspace: { usd: 100 }, onUnknown: 'stop' } });
  try {
    const b = f.h.createBoard('Budget board', '', 'main');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const base = {
      repositoryId: 'main',
      runId: run.id,
      stage: 'implementation',
      runtime: 'claude',
      model: 'cheap',
      runtimeVersion: null,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      outcome: 'active' as const,
      promptBytes: 1,
      promptDigest: 'd',
      usage: usage(false),
      costUsd: null,
      costSource: 'unknown' as const,
    };
    f.store.atomic(() => {
      f.store.saveLocal('usage', 'main', 'crashed', {
        ...base,
        id: 'crashed',
        process: { id: 'old-process', pid: dead },
      });
      f.store.saveLocal('usage', 'main', 'live', {
        ...base,
        id: 'live',
        process: { id: 'other-live-process', pid: process.pid },
      });
    });
    assert.deepEqual(abandonCalls(f.h), ['crashed']);
    const records = Object.values(f.store.localRecords<UsageRecord>('usage', 'main'));
    assert.equal(records.find((r) => r.id === 'crashed')!.outcome, 'abandoned');
    assert.equal(records.find((r) => r.id === 'live')!.outcome, 'active');
    const totals = usageTotals(records);
    assert.equal(totals.abandonedCalls, 1);
    assert.equal(totals.unfinishedCalls, 1);
    assert.equal(totals.unknownCalls, 2);
    assert.equal(totals.complete, false);
    // Время прерванного вызова ограничено моментом обнаружения, а не растёт вечно.
    assert.ok(totals.durationMs >= 120_000);
    const status = budgetStatus(f.h, f.store.read(), { kind: 'workspace' });
    assert.equal(status?.state, 'undetermined');
    assert.match(status.reason!, /у 2 вызовов неизвестна стоимость/);
  } finally {
    f.cleanup();
  }
});

test('B05: an exhausted task budget stops dispatch and calls; retry --reset and a restart do not reset it; raising the limit in config does', async () => {
  const budgets = { task: { usd: 5 }, onUnknown: 'stop' as const };
  const f = contour({ budgets });
  try {
    const b = f.h.createBoard('Budget board', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const first = f.h.claim('w')!;
    // Ошибочный вызов входит в расход со своей оценкой.
    await assert.rejects(spend(f.h, first.id, 'error'), /provider failed/);
    await spend(f.h, first.id);
    assert.equal(budgetStatus(f.h, f.store.read(), { kind: 'task', id: t.id })?.state, 'exceeded');
    // Вызов сверх бюджета не начинается: адаптер не вызван, записи нет.
    let invoked = false;
    const before = Object.keys(f.store.localRecords('usage', 'main')).length;
    const refused = await measuredExecute(
      f.h,
      {
        name: 'claude',
        execute: async () => {
          await Promise.resolve();
          invoked = true;
          return { data: {}, log: '', command: [] };
        },
      },
      request,
      { repositoryId: 'main', runId: first.id, stage: 'candidate-review' },
    ).catch((e: unknown) => e);
    assert.ok(refused instanceof TaskFailure);
    assert.equal(refused.kind, 'budget');
    assert.match(
      refused.message,
      /Бюджет task .* исчерпан: предел \$5; израсходовано: сообщено \$0\.0000, оценено \$6\.0000/,
    );
    assert.equal(invoked, false);
    assert.equal(Object.keys(f.store.localRecords('usage', 'main')).length, before);
    f.h.fail(first.id, first.token, 'failed');
    // Сброс попыток не сбрасывает деньги.
    f.h.retry(t.id, { reason: 'try again' });
    assert.equal(f.h.claim('w'), undefined);
    const blocked = f.store.read().tasks.find((x) => x.id === t.id)!;
    assert.match(blocked.budgetBlock!.reason, /исчерпан/);
    assert.match(
      chainBlockers([blocked], f.h.config.maxAttempts)[0]?.reason ?? blocked.budgetBlock!.reason,
      /исчерпан/,
    );
    // Перезапуск процесса — тот же расход из сохранённых записей.
    const restarted = f.reopen();
    assert.equal(restarted.claim('w'), undefined);
    // Поднять предел можно только конфигурацией.
    const raised = f.reopen({ budgets: { ...budgets, task: { usd: 50 } } });
    const again = raised.claim('w');
    assert.equal(again?.taskId, t.id);
    assert.equal(raised.store.read().tasks.find((x) => x.id === t.id)!.budgetBlock, undefined);
  } finally {
    f.cleanup();
  }
});

test('B05: unknown cost makes a money budget undetermined: stop by default, continue on the lower bound when configured; time budgets count call intervals', async () => {
  const unknown = usage(false);
  const f = contour({ budgets: { task: { usd: 100 }, onUnknown: 'stop' } });
  try {
    const b = f.h.createBoard('Budget board', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    await assert.rejects(spend(f.h, run.id, 'error', unknown), /provider failed/);
    await assert.rejects(
      spend(f.h, run.id),
      (e: unknown) => e instanceof TaskFailure && /не определён/.test(e.message),
    );
    const lenient = f.reopen({ budgets: { task: { usd: 100 }, onUnknown: 'continue' } });
    await spend(lenient, run.id);
    const overview = budgetOverview(lenient, lenient.store.read())!;
    const own = overview.budgets.find((x) => x.scope.kind === 'task' && x.scope.id === t.id)!;
    assert.equal(own.state, 'undetermined');
    assert.equal(own.remainingUsd, null);
    assert.equal(own.estimatedUsd, 3);
    assert.equal(own.errorCalls, 1);
    // Бюджет времени: сумма интервалов вызовов, включая ошибочные.
    await measuredExecute(
      lenient,
      {
        name: 'claude',
        execute: async (r) => {
          await new Promise((done) => setTimeout(done, 30));
          r.onUsage!(usage(true, 0));
          throw new Error('slow failure');
        },
      },
      request,
      { repositoryId: 'main', runId: run.id, stage: 'implementation' },
    ).catch(() => undefined);
    const timed = f.reopen({ budgets: { task: { timeMs: 25 }, onUnknown: 'stop' } });
    await assert.rejects(spend(timed, run.id), /Бюджет времени task .* исчерпан/);
  } finally {
    f.cleanup();
  }
});
