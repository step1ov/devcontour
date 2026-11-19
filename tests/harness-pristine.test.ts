// `ExecutionView.pristine()` адаптера DevContour: движок harness берёт учёт
// вызовов при выдаче из кэша по `dataVersion` только в нетронутой внешней
// транзакции. Здесь — что выдача на простое через хост DevContour не читает
// историю попыток и записей вызовов, первая выдача после изменения видит
// новый расход, а вложенная, писавшая и откаченная части `pristine` не дают.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Engine, WORKSPACE_OWNER, type ExecutionView } from 'devcontour-harness';
import { fixture, input } from './helpers.ts';
import { loadedDigest } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import type { Run } from '../src/core/model.ts';
import type { UsageRecord } from '../src/core/usage.ts';
import { callOf } from '../src/harness/projection.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import { devcontourHost, projectionOptions } from '../src/harness/host.ts';
import { policyFromConfig } from '../src/harness/policy.ts';

type Fixture = ReturnType<typeof fixture>;

/** Завершённый вызов модели задачи с известной стоимостью (запись DevContour). */
const call = (id: string, taskId: string, costUsd: number): UsageRecord => ({
  id,
  taskId,
  stage: 'implementation',
  runtime: 'codex',
  model: 'EXAMPLE_MODEL',
  runtimeVersion: null,
  startedAt: '2026-11-01T00:00:00.000Z',
  finishedAt: '2026-11-01T00:00:01.000Z',
  // Время вызова закончено: причина удержания не меняется с часами.
  durationMs: 1000,
  outcome: 'returned',
  promptBytes: 1,
  promptDigest: 'd'.repeat(64),
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedUsd: costUsd,
    complete: true,
    source: 'codex-turn-events',
  },
  costUsd,
  costSource: 'provider-reported',
});

/** Прежняя попытка задачи: завершена, её вызовы записаны. */
const pastRun = (id: string, taskId: string, policyDigest: string): Run =>
  ({
    id,
    taskId,
    repositoryId: 'main',
    attempt: 1,
    token: 'token-'.padEnd(32, 'x'),
    owner: 'controller',
    runtime: 'demo',
    reviewer: 'demo',
    policyDigest,
    status: 'failed',
    phase: 'running',
    startedAt: '2026-11-01T00:00:00.000Z',
    endedAt: '2026-11-01T00:01:00.000Z',
    leaseUntil: 0,
    evidence: [],
    error: 'fixture',
    callsRecorded: true,
  }) as unknown as Run;

/**
 * Две утверждённые задачи, обе исчерпали бюджет задачи: выдавать нечего, но
 * у готовых поручений `claim` каждый раз оценивает бюджеты. История —
 * `history` прежних попыток и записей вызовов.
 */
function idleBoard(history: number) {
  const f = fixture();
  f.h.config.budgets = { task: { usd: 0.05 }, onUnknown: 'stop' };
  const { boardId } = f.h.importPlan({
    title: 'Release',
    description: 'Цель этапа',
    tasks: ['Task A', 'Task B'].map((t, i) => ({ ...input(t), key: 'k' + i, contracts: [] })),
  });
  f.h.approve(boardId);
  const tasks = f.store.read().tasks.map((t) => t.id);
  const digest = f.h.taskPolicyDigest(f.store.read().tasks[0]);
  f.store.change('test.history', (s) => {
    for (let i = 0; i < history; i++) s.runs.push(pastRun('R-old-' + i, tasks[i % 2], digest));
  });
  f.store.atomic(() => {
    for (let i = 0; i < history; i++)
      f.store.saveLocal('usage', undefined, 'U-old-' + i, call('U-old-' + i, tasks[i % 2], 0));
    // Расход каждой задачи — ровно предел: обе удержаны бюджетом.
    for (const id of tasks)
      f.store.saveLocal('usage', undefined, 'U-' + id, call('U-' + id, id, 0.05));
  });
  const store = new DevContourExecutionStore(f.h.store, projectionOptions(f.h));
  const counters = { attempts: 0, usage: 0, views: 0, pristine: [] as boolean[] };
  spy(store, counters);
  const engine = new Engine({
    host: devcontourHost(f.h, store),
    policy: policyFromConfig(f.h.config),
    policyIdentity: loadedDigest(f.h.config),
  });
  assert.ok(engine.lead('controller'));
  engine.resume();
  return { f, store, engine, tasks, counters };
}

/**
 * Счётчики чтения истории на каждом виде адаптера: попытки (`attempts`,
 * `attempt`) и записи вызовов (`locals('usage')`, `local('usage')`), а также
 * ответы `pristine()`. Вид — тот же объект (адаптер узнаёт его по ссылке).
 */
function spy(
  store: DevContourExecutionStore,
  counters: { attempts: number; usage: number; views: number; pristine: boolean[] },
) {
  const target = store as unknown as { view: (...args: unknown[]) => ExecutionView };
  const original = target.view.bind(store);
  target.view = (...args: unknown[]) => {
    const view = original(...args) as ExecutionView & Record<string, unknown>;
    counters.views++;
    const attempts = view.attempts.bind(view);
    view.attempts = (workId?: string) => {
      const out = attempts(workId);
      counters.attempts += out.length;
      return out;
    };
    const attempt = view.attempt.bind(view);
    view.attempt = (id: string) => {
      const out = attempt(id);
      if (out) counters.attempts++;
      return out;
    };
    const locals = view.locals.bind(view) as (n: string, o?: string) => unknown[];
    view.locals = ((namespace: string, owner?: string) => {
      const out = locals(namespace, owner);
      if (namespace === 'usage') counters.usage += out.length;
      return out;
    }) as ExecutionView['locals'];
    const local = view.local.bind(view) as (n: string, o: string, k: string) => unknown;
    view.local = ((namespace: string, owner: string, key: string) => {
      const out = local(namespace, owner, key);
      if (namespace === 'usage' && out) counters.usage++;
      return out;
    }) as ExecutionView['local'];
    const pristine = view.pristine!.bind(view);
    view.pristine = () => {
      const out = pristine();
      counters.pristine.push(out);
      return out;
    };
    return view;
  };
}

const blocks = (f: Fixture) =>
  Object.fromEntries(f.store.read().tasks.map((t) => [t.id, t.budgetBlock?.reason]));

test('выдача на простое через хост DevContour не читает историю; первая после изменения видит новый расход', () => {
  const cost = (history: number) => {
    const b = idleBoard(history);
    try {
      const reset = () => {
        b.counters.attempts = 0;
        b.counters.usage = 0;
        b.counters.pristine = [];
      };
      const claim = () => {
        reset();
        assert.equal(b.engine.claim('controller'), undefined, 'обе задачи удержаны бюджетом');
        return { attempts: b.counters.attempts, usage: b.counters.usage };
      };
      const first = claim();
      assert.deepEqual(b.counters.pristine, [true], 'выдача — нетронутая внешняя транзакция');
      const held = blocks(b.f);
      for (const id of b.tasks) assert.match(held[id] ?? '', /исчерпан/, id);
      // Первая выдача записала удержания — ревизия данных сменилась, и
      // следующая выдача читает историю ещё раз, уже ничего не записывая.
      const revision = b.f.store.revision();
      const settle = claim();
      assert.equal(b.f.store.revision(), revision, 'повтор без изменений ничего не записал');
      let steady = { attempts: 0, usage: 0 };
      for (let i = 0; i < 3; i++) {
        const c = claim();
        steady = { attempts: steady.attempts + c.attempts, usage: steady.usage + c.usage };
      }
      assert.equal(b.f.store.revision(), revision, 'выдачи на простое ничего не записали');
      assert.deepEqual(blocks(b.f), held);

      // Новый расход задачи A (запись вызова, как её пишет движок) — первая
      // же выдача видит его и пишет новую причину.
      b.store.transact('usage.recorded', (tx) =>
        tx.putLocal('usage', WORKSPACE_OWNER, 'U-new', callOf(call('U-new', b.tasks[0], 0.02))),
      );
      const after = claim();
      const next = blocks(b.f);
      assert.match(next[b.tasks[0]]!, /сообщено \$0\.0700/, 'новый расход A виден');
      assert.equal(next[b.tasks[1]], held[b.tasks[1]], 'расход B прежний');
      // Расход, записанный другим соединением с тем же файлом (другой
      // процесс), тоже виден первой выдаче.
      const other = new Store(join(b.f.root, 'state.sqlite'));
      try {
        other.atomic(() =>
          other.saveLocal('usage', undefined, 'U-peer', call('U-peer', b.tasks[1], 0.03)),
        );
      } finally {
        other.close();
      }
      claim();
      assert.match(blocks(b.f)[b.tasks[1]]!, /сообщено \$0\.0800/, 'расход другого процесса виден');
      return { first, settle, steady, after };
    } finally {
      b.f.cleanup();
    }
  };
  const small = cost(4);
  const large = cost(60);
  // На простое — ни одной попытки и записи вызовов, при любой истории.
  assert.deepEqual(small.steady, { attempts: 0, usage: 0 });
  assert.deepEqual(large.steady, { attempts: 0, usage: 0 });
  // Первая выдача и первая после изменения читают историю (один раз, а не
  // на каждое поручение и область бюджета): цена растёт с историей.
  for (const r of [large.first, large.settle, large.after]) {
    assert.ok(r.attempts >= 60 && r.attempts <= 2 * 60 + 4, JSON.stringify(r));
    assert.ok(r.usage >= 60 + 2 && r.usage <= 2 * (60 + 3), JSON.stringify(r));
  }
});

test('pristine: только внешняя транзакция адаптера без записей', () => {
  const b = idleBoard(2);
  try {
    const { store } = b;
    const pristine = (v: ExecutionView) => v.pristine?.() === true;
    store.transact('task.retry', (tx) => {
      assert.equal(pristine(tx), true, 'нетронутая внешняя');
      store.transact('task.retry', (inner) => {
        assert.equal(pristine(inner), false, 'вложенная');
        assert.equal(pristine(tx), false, 'внешняя, пока идёт вложенная');
      });
      assert.equal(pristine(tx), true, 'вложенная без записей ничего не изменила');
      // Вид вложенной части и после её конца не становится «внешним».
      const kept = store.transact('task.retry', (inner) => inner);
      assert.equal(pristine(kept), false, 'вид закончившейся вложенной части');
      assert.throws(() =>
        store.transact('task.retry', (inner) => {
          inner.putLocal(
            'usage',
            WORKSPACE_OWNER,
            'U-rolled',
            callOf(call('U-rolled', b.tasks[0], 1)),
          );
          throw new Error('откат вложенной части');
        }),
      );
      assert.equal(pristine(tx), false, 'после отката писавшей вложенной части');
    });
    assert.equal(
      store.read((v) => v.local('usage', WORKSPACE_OWNER, 'U-rolled')),
      undefined,
      'откаченная запись не зафиксирована',
    );
    const writes: [string, (tx: Parameters<Parameters<typeof store.transact>[1]>[0]) => void][] = [
      [
        'локальная запись',
        (tx) => tx.putLocal('usage', WORKSPACE_OWNER, 'U-x', callOf(call('U-x', b.tasks[0], 0))),
      ],
      ['запись модели', (tx) => tx.putWork({ ...tx.work(b.tasks[0])! })],
      ['управление', (tx) => tx.setControl(tx.control())],
      ['роль controller', (tx) => tx.setController(tx.controller())],
      [
        'событие',
        (tx) =>
          tx.emit({
            type: 'work.held',
            graphId: tx.work(b.tasks[0])!.graphId,
            workId: b.tasks[0],
            payload: { operation: 'x', reason: 'y', released: true },
          }),
      ],
    ];
    for (const [label, write] of writes)
      store.transact('task.retry', (tx) => {
        write(tx);
        assert.equal(pristine(tx), false, label);
      });
    // Хост: продуктовая правка документа в транзакции хоста; движок в ней — вложенный.
    store.host('test.host', (ht) => {
      assert.equal(pristine(ht.tx), true, 'транзакция хоста до записи');
      store.transact('task.retry', (inner) => assert.equal(pristine(inner), false));
      void ht.state.tasks;
      assert.equal(pristine(ht.tx), false, 'после правки документа хостом');
    });
    store.read((v) => assert.equal(pristine(v), false, 'вид чтения'));
    // Внешняя транзакция откатилась: ревизия и данные прежние, следующая — нетронута.
    const revision = b.f.store.revision();
    assert.throws(() =>
      store.transact('task.retry', (tx) => {
        tx.putLocal('usage', WORKSPACE_OWNER, 'U-gone', callOf(call('U-gone', b.tasks[0], 1)));
        throw new Error('откат');
      }),
    );
    assert.equal(b.f.store.revision(), revision);
    store.transact('task.retry', (tx) => {
      assert.equal(pristine(tx), true);
      assert.equal(tx.dataVersion?.(), revision);
    });
  } finally {
    b.f.cleanup();
  }
});

test('pristine: попытка со сроком в документе (прежняя версия до D53) — false; heartbeat с записью модели меняет dataVersion', () => {
  const b = idleBoard(0);
  try {
    const { store, f, tasks } = b;
    const digest = f.h.taskPolicyDigest(f.store.read().tasks[0]);
    // Попытка, которую ведёт версия до D53, записана другим процессом: срок
    // в документе, строки аренды нет; ревизия данных поднята (запись данных).
    const other = new DatabaseSync(join(f.root, 'state.sqlite'));
    try {
      const doc = JSON.parse(
        (other.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string }).data,
      ) as { runs: unknown[] };
      doc.runs.push({
        ...pastRun('R-legacy', tasks[0], digest),
        status: 'active',
        leaseUntil: Date.now() + 60_000,
      });
      other.prepare('UPDATE main.state SET data=? WHERE id=1').run(JSON.stringify(doc));
      other.prepare('UPDATE main.revision SET n=n+1 WHERE id=1').run();
    } finally {
      other.close();
    }
    assert.equal(f.store.attemptLeaseRow('R-legacy'), undefined, 'срок — в документе');
    store.transact('task.retry', (tx) =>
      assert.equal(tx.pristine?.(), false, 'прежняя версия продлевает срок без ревизии данных'),
    );
    // Попытка этой версии (срок в строке) кэшу не мешает.
    f.store.change('test.finish', (s) => {
      s.runs.find((r) => r.id === 'R-legacy')!.status = 'failed';
    });
    store.transact('task.retry', (tx) => assert.equal(tx.pristine?.(), true));

    // Запись модели под видом heartbeat (договор хранилища её допускает).
    const before = f.store.revision();
    store.transact('heartbeat', (tx) => tx.setController(tx.controller()));
    assert.equal(f.store.revision(), before, 'продление роли — не данные');
    store.transact('heartbeat', (tx) =>
      tx.putWork({
        ...tx.work(tasks[0])!,
        budgetBlock: { reason: 'fixture', at: '2026-11-01T00:00:00.000Z' },
      }),
    );
    assert.ok(f.store.revision() > before, 'запись модели в heartbeat поднимает ревизию данных');
  } finally {
    b.f.cleanup();
  }
});
