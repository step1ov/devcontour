import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { TaskFailure } from '../src/core/failure.ts';
import {
  callDurationMs,
  priceUsage,
  usageTotals,
  type Price,
  type UsageRecord,
} from '../src/core/usage.ts';
import { budgetOverview, budgetStatus, taskBudgets, usageRecords } from '../src/core/budget.ts';
import { abandonCalls, measuredExecute, pinBoardCalls } from '../src/runner/usage.ts';
import { liveCall } from '../src/core/live-calls.ts';
import { ownerGone, processStartedAt } from '../src/runner/live-calls.ts';
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

/** Вызов модели, сообщающий usage и модель: оценка по тарифу $3 за вызов. */
const spend = (
  h: DevContour,
  runId: string,
  outcome: 'ok' | 'error' = 'ok',
  u = usage(),
  model: string | null = 'cheap',
) =>
  measuredExecute(
    h,
    {
      name: 'claude',
      version: 'fixture',
      execute: async (r) => {
        await Promise.resolve();
        r.onUsage!(u, 'v', model ?? undefined);
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

test('B03: a call whose process died is closed as abandoned and counted; a live call stays unfinished', async () => {
  const f = contour({ budgets: { workspace: { usd: 100 }, onUnknown: 'stop' } });
  // Живой владелец — настоящий другой процесс с известным моментом старта.
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise((done) => setTimeout(done, 200));
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
        process: {
          id: 'other-live-process',
          pid: owner.pid!,
          startedAt: processStartedAt(owner.pid!),
        },
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
    assert.match(status.reason!, /у 1 вызовов неизвестна стоимость/);
  } finally {
    owner.kill();
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

test('review: switching budgets off releases the block; no reported model means no tariff; a reported cost stays known; clock skew is not zero time', async () => {
  const budgets = { task: { usd: 5 }, onUnknown: 'stop' as const };
  const f = contour({ budgets });
  try {
    const b = f.h.createBoard('Budget board', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    await spend(f.h, run.id);
    await spend(f.h, run.id);
    f.h.fail(run.id, run.token, 'failed');
    f.h.retry(t.id, { reason: 'again' });
    assert.equal(f.h.claim('w'), undefined);
    // Бюджеты выключены: бюджетное удержание снято, выдача — как без бюджетов.
    const off = f.reopen({ budgets: undefined });
    const next = off.claim('w')!;
    assert.equal(next.taskId, t.id);
    assert.equal(off.store.read().tasks.find((x) => x.id === t.id)!.budgetBlock, undefined);
    // Runtime не сообщил модель: запрошенная модель тариф не подтверждает.
    await spend(off, next.id, 'ok', usage(), null);
    // Сообщённая стоимость известна и при ошибке и неполных счётчиках.
    await spend(off, next.id, 'error', usage(false, 0)).catch(() => undefined);
    const records = Object.values(f.store.localRecords<UsageRecord>('usage', 'main'));
    // Порядок записей не хронологический: они ищутся по признакам.
    const unpriced = records.find((r) => r.usage.complete && r.costSource !== 'tariff-estimate')!;
    assert.equal(unpriced.costSource, 'unknown');
    assert.equal(unpriced.price, undefined);
    const reported = records.find((r) => r.usage.reportedUsd === 0)!;
    assert.equal(reported.costSource, 'provider-reported');
    assert.equal(usageTotals([reported]).unknownCalls, 0);
    assert.equal(usageTotals([{ ...reported, outcome: 'abandoned' }]).unknownCalls, 0);
    // Время — по монотонным часам; без них противоречивые метки не дают ноль.
    assert.ok(records.every((r) => typeof r.durationMs === 'number'));
    const skewed = {
      ...reported,
      durationMs: undefined,
      startedAt: '2026-01-01T00:01:00.000Z',
      finishedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal(callDurationMs(skewed), null);
    assert.equal(usageTotals([skewed]).unknownDurationCalls, 1);
  } finally {
    f.cleanup();
  }
});

test('review: unrecorded attempts, plan review calls, moves between boards and parallel calls are accounted for', async () => {
  const f = contour({ budgets: { task: { usd: 5 }, board: { usd: 5 }, onUnknown: 'stop' } });
  try {
    const a = f.h.createBoard('Board A', '', 'main');
    const t = f.h.addTask(a.id, input());
    f.h.approve(a.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    // Попытка до учёта (без отметки) с кандидатом и без записей вызовов:
    // стоимость неизвестна.
    f.store.change('fixture.legacy', (s) => {
      const r = s.runs.find((x) => x.id === run.id)!;
      r.candidateSha = 'c'.repeat(40);
      delete r.callsRecorded;
    });
    const legacy = budgetStatus(f.h, f.store.read(), { kind: 'task', id: t.id })!;
    assert.equal(legacy.state, 'undetermined');
    assert.match(legacy.reason!, /у 1 попыток вызовы не записаны/);
    const lenient = f.reopen({
      budgets: { task: { usd: 5 }, board: { usd: 5 }, onUnknown: 'continue' },
    });
    // Идущий вызов не останавливает параллельный вызов той же области.
    let inner: unknown;
    await measuredExecute(
      lenient,
      {
        name: 'claude',
        execute: async (r) => {
          inner = await spend(lenient, run.id).catch((e: unknown) => e);
          r.onUsage!(usage(), 'v', 'cheap');
          return { data: {}, log: '', command: [] };
        },
      },
      request,
      { repositoryId: 'main', runId: run.id, stage: 'implementation' },
    );
    assert.ok(!(inner instanceof Error), String(inner));
    // Вызов о доске (ревью плана) учитывается в бюджете каждой её задачи и
    // не начинается, когда бюджет задачи исчерпан.
    const records = usageRecords(lenient);
    assert.ok(records.every((r) => r.taskId === t.id && r.boardId === a.id));
    await assert.rejects(
      measuredExecute(
        lenient,
        {
          name: 'claude',
          execute: async () => {
            await Promise.resolve();
            return { data: {}, log: '', command: [] };
          },
        },
        request,
        { repositoryId: 'main', subjectId: a.id, stage: 'plan-review' },
      ),
      (e: unknown) => e instanceof TaskFailure && e.kind === 'budget',
    );
    // Перенос задачи на другую доску не уводит её из-под исчерпанной доски A.
    lenient.store.change('fixture.move', (s) => {
      const from = s.boards.find((x) => x.id === a.id)!;
      for (const r of from.revisions) r.taskIds = r.taskIds.filter((id) => id !== t.id);
      s.boards.push({
        ...structuredClone(from),
        id: 'B-moved',
        revisions: from.revisions.map((r) => ({ ...r, taskIds: [t.id] })),
      });
    });
    const s = lenient.store.read();
    const moved = taskBudgets(lenient, s, s.tasks.find((x) => x.id === t.id)!);
    assert.ok(moved.some((x) => x.scope.kind === 'board' && x.scope.id === a.id));
    assert.equal(
      budgetStatus(lenient, s, { kind: 'board', id: 'B-moved' })!.spent.estimatedUsd,
      0,
    );
    assert.equal(budgetStatus(lenient, s, { kind: 'board', id: a.id })!.state, 'exceeded');
  } finally {
    f.cleanup();
  }
});

test('review: recovery does not overwrite a call that finished after the scan', () => {
  const f = contour({});
  try {
    const record: UsageRecord = {
      id: 'legacy',
      repositoryId: 'main',
      runId: 'R-gone',
      stage: 'implementation',
      runtime: 'claude',
      model: 'cheap',
      runtimeVersion: null,
      startedAt: new Date().toISOString(),
      outcome: 'active',
      promptBytes: 1,
      promptDigest: 'd',
      usage: usage(false),
      costUsd: null,
      costSource: 'unknown',
    };
    f.store.atomic(() => f.store.saveLocal('usage', 'main', record.id, record));
    // Между сканированием и транзакцией восстановления вызов завершился.
    const atomic = f.store.atomic.bind(f.store);
    let raced = false;
    f.store.atomic = <T>(action: () => T): T => {
      if (!raced) {
        raced = true;
        atomic(() =>
          f.store.saveLocal('usage', 'main', record.id, {
            ...record,
            outcome: 'returned',
            costUsd: 7,
            costSource: 'provider-reported',
          }),
        );
      }
      return atomic(action);
    };
    assert.deepEqual(abandonCalls(f.h), []);
    const stored = f.store.localRecords<UsageRecord>('usage', 'main')[record.id];
    assert.equal(stored.outcome, 'returned');
    assert.equal(stored.costUsd, 7);
  } finally {
    f.cleanup();
  }
});

test('review 2: an abandoned estimate stays unknown; a call of a dead or stale owner is unknown before recovery; live time does not shrink when the clock moves back', async () => {
  const f = contour({ budgets: { workspace: { usd: 100, timeMs: 3_600_000 }, onUnknown: 'stop' } });
  try {
    const base: UsageRecord = {
      id: 'x',
      repositoryId: 'main',
      stage: 'planning',
      runtime: 'claude',
      model: 'cheap',
      runtimeVersion: null,
      startedAt: new Date().toISOString(),
      outcome: 'abandoned',
      promptBytes: 1,
      promptDigest: 'd',
      usage: usage(),
      costUsd: 3,
      costSource: 'tariff-estimate',
    };
    // Оценка прерванного вызова — нижняя граница, а не стоимость.
    assert.equal(usageTotals([base]).unknownCalls, 1);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const save = (r: UsageRecord) => f.store.atomic(() => f.store.saveLocal('usage', 'main', r.id, r));
    save({ ...base, id: 'dead', outcome: 'active', process: { id: 'gone', pid: dead } });
    // Без восстановления: вызов умершего процесса уже неизвестен.
    const status = budgetStatus(f.h, f.store.read(), { kind: 'workspace' })!;
    assert.equal(status.state, 'undetermined');
    assert.equal(status.spent.liveCalls, 0);
    // Живой pid, но вызов старше двух пределов времени: pid мог смениться.
    save({ ...base, id: 'dead', outcome: 'returned', costSource: 'provider-reported' });
    save({
      ...base,
      id: 'stale',
      outcome: 'active',
      startedAt: new Date(Date.now() - 3 * f.h.config.runTimeoutMs).toISOString(),
      process: { id: 'other', pid: process.pid },
    });
    assert.equal(budgetStatus(f.h, f.store.read(), { kind: 'workspace' })!.spent.liveCalls, 0);
  } finally {
    f.cleanup();
  }
  const g = contour({ budgets: { workspace: { timeMs: 3_600_000 }, onUnknown: 'stop' } });
  const realNow = Date.now;
  try {
    let measured: number | null = null;
    await measuredExecute(
      g.h,
      {
        name: 'claude',
        execute: async (r) => {
          await new Promise((done) => setTimeout(done, 30));
          Date.now = () => realNow() - 60_000;
          const active = usageRecords(g.h).find((x) => x.outcome === 'active')!;
          measured = callDurationMs(active, Date.now());
          Date.now = realNow;
          r.onUsage!(usage(), 'v', 'cheap');
          return { data: {}, log: '', command: [] };
        },
      },
      request,
      { repositoryId: 'main', stage: 'planning' },
    );
    assert.ok(measured !== null && measured >= 25, String(measured));
  } finally {
    Date.now = realNow;
    g.cleanup();
  }
});

test('review 2: history before accounting stays unknown after new calls of the same attempt; a board call stays with its tasks after a move', async () => {
  const f = contour({ budgets: { task: { usd: 5 }, board: { usd: 5 }, onUnknown: 'stop' } });
  try {
    const a = f.h.createBoard('Board A', '', 'main');
    const t = f.h.addTask(a.id, input());
    f.h.approve(a.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    // Попытка до учёта: без кандидата, но с замером реализации.
    f.store.change('fixture.history', (s) => {
      const r = s.runs.find((x) => x.id === run.id)!;
      delete r.callsRecorded;
      r.startedAt = new Date(Date.now() - 60_000).toISOString();
      r.timings = [
        { stage: 'implementation', startedAt: r.startedAt, durationMs: 1000, ok: false },
      ] as never;
    });
    const lenient = f.reopen({
      budgets: { task: { usd: 5 }, board: { usd: 5 }, onUnknown: 'continue' },
    });
    // Новый вызов той же попытки (восстановление) пробел не закрывает.
    await measuredExecute(
      lenient,
      {
        name: 'claude',
        execute: async (r) => {
          await Promise.resolve();
          r.onUsage!(usage(true, 0), 'v', 'cheap');
          return { data: {}, log: '', command: [] };
        },
      },
      request,
      { repositoryId: 'main', runId: run.id, stage: 'property-recovery' },
    );
    const s0 = lenient.store.read();
    assert.equal(budgetStatus(lenient, s0, { kind: 'task', id: t.id })!.spent.uncoveredRuns, 1);
    // Вызов о доске закрепляет её открытые задачи.
    await measuredExecute(
      lenient,
      {
        name: 'claude',
        execute: async (r) => {
          await Promise.resolve();
          r.onUsage!(usage(true, 6), 'v', 'cheap');
          return { data: {}, log: '', command: [] };
        },
      },
      request,
      { repositoryId: 'main', subjectId: a.id, stage: 'plan-review' },
    );
    const boardCall = usageRecords(lenient).find((r) => r.stage === 'plan-review')!;
    assert.deepEqual(boardCall.taskIds, [t.id]);
    lenient.store.change('fixture.move', (s) => {
      const from = s.boards.find((x) => x.id === a.id)!;
      for (const r of from.revisions) r.taskIds = r.taskIds.filter((id) => id !== t.id);
      s.boards.push({
        ...structuredClone(from),
        id: 'B-moved',
        revisions: from.revisions.map((r) => ({ ...r, taskIds: [t.id] })),
      });
    });
    const s = lenient.store.read();
    const own = budgetStatus(lenient, s, { kind: 'task', id: t.id })!;
    assert.equal(own.spent.reportedUsd, 6);
    assert.equal(own.state, 'exceeded');
    assert.ok(
      taskBudgets(lenient, s, s.tasks.find((x) => x.id === t.id)!).some(
        (x) => x.scope.kind === 'board' && x.scope.id === a.id,
      ),
    );
  } finally {
    f.cleanup();
  }
});

test('review 3: history gaps follow the attempt flag, not timestamps; a long history is fine; a refused call leaves no gap', () => {
  const f = contour({ budgets: { task: { usd: 5 }, onUnknown: 'stop' } });
  try {
    const b = f.h.createBoard('Budget board', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    // Выданная учётом попытка с замером реализации без записи — вызова не было
    // (отказ бюджета до вызова): пробела нет.
    f.store.change('fixture.refused', (s) => {
      const r = s.runs.find((x) => x.id === run.id)!;
      r.timings = [
        { stage: 'implementation', startedAt: r.startedAt, durationMs: 1, ok: false },
      ] as never;
    });
    const early: UsageRecord = {
      id: 'early',
      repositoryId: 'main',
      stage: 'planning',
      runtime: 'claude',
      model: 'cheap',
      runtimeVersion: null,
      startedAt: '2020-01-01T00:00:00.000Z',
      finishedAt: '2020-01-01T00:00:01.000Z',
      outcome: 'returned',
      promptBytes: 1,
      promptDigest: 'd',
      usage: usage(true, 0),
      costUsd: 0,
      costSource: 'provider-reported',
    };
    // Длинная история: расчёт не зависит от предела аргументов.
    const many = Array.from({ length: 150_000 }, (_, i) => ({ ...early, id: `e${i}` }));
    const s = f.store.read();
    assert.equal(budgetStatus(f.h, s, { kind: 'task', id: t.id }, many)!.spent.uncoveredRuns, 0);
    // Попытка до учёта: более ранний посторонний вызов пробел не закрывает.
    f.store.change('fixture.legacy', (s) => {
      delete s.runs.find((x) => x.id === run.id)!.callsRecorded;
    });
    assert.equal(
      budgetStatus(f.h, f.store.read(), { kind: 'task', id: t.id }, [early])!.spent.uncoveredRuns,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test('review 3: a reused pid is not a live owner; foreign in-flight time keeps its saved floor; legacy board calls stay with their tasks', async () => {
  const f = contour({ budgets: { task: { usd: 5 }, board: { usd: 5 }, onUnknown: 'stop' } });
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await new Promise((done) => setTimeout(done, 200));
  try {
    const base: UsageRecord = {
      id: 'x',
      repositoryId: 'main',
      stage: 'planning',
      runtime: 'claude',
      model: 'cheap',
      runtimeVersion: null,
      startedAt: new Date().toISOString(),
      outcome: 'active',
      promptBytes: 1,
      promptDigest: 'd',
      usage: usage(false),
      costUsd: null,
      costSource: 'unknown',
    };
    const at = Date.now();
    const max = 2 * f.h.config.runTimeoutMs;
    const started = processStartedAt(owner.pid!);
    // Наш pid у чужой записи и чужой pid с другим моментом старта — не живые.
    assert.equal(
      liveCall({ ...base, process: { id: 'old', pid: process.pid, startedAt: started } }, at, max),
      false,
    );
    const reused = { ...base, process: { id: 'old', pid: owner.pid!, startedAt: started! - 60_000 } };
    assert.equal(liveCall(reused, at, max), false);
    assert.equal(ownerGone(reused), true);
    const real = { ...base, process: { id: 'old', pid: owner.pid!, startedAt: started } };
    assert.equal(liveCall(real, at, max), true);
    assert.equal(ownerGone(real), false);
    // Чужой идущий вызов: откат часов не опускает время ниже сохранённого замера.
    assert.equal(
      callDurationMs({ ...base, elapsedMs: 300, startedAt: new Date(at + 60_000).toISOString() }, at),
      300,
    );
    // Прежняя запись о доске без закреплённых задач закрепляется до изменения графа.
    const b = f.h.createBoard('Board A', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.store.atomic(() =>
      f.store.saveLocal('usage', 'main', 'legacy-board', {
        ...base,
        id: 'legacy-board',
        subjectId: b.id,
        outcome: 'returned',
        usage: usage(true, 6),
        costUsd: 6,
        costSource: 'provider-reported',
      }),
    );
    assert.equal(pinBoardCalls(f.h), 1);
    f.store.change('fixture.move', (s) => {
      const from = s.boards.find((x) => x.id === b.id)!;
      for (const r of from.revisions) r.taskIds = r.taskIds.filter((id) => id !== t.id);
      s.boards.push({
        ...structuredClone(from),
        id: 'B-moved',
        revisions: from.revisions.map((r) => ({ ...r, taskIds: [t.id] })),
      });
    });
    const own = budgetStatus(f.h, f.store.read(), { kind: 'task', id: t.id })!;
    assert.equal(own.spent.reportedUsd, 6);
    assert.equal(own.state, 'exceeded');
  } finally {
    owner.kill();
    f.cleanup();
  }
});
