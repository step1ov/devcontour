import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WORKSPACE_OWNER, digestOf } from 'devcontour-harness';
import { executionStoreContract } from 'devcontour-harness/testing';
import { Store } from '../src/core/store.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import { specDigest } from '../src/core/service.ts';
import type { Run, Task } from '../src/core/model.ts';

const policy = digestOf('policy');
const options = { policyDigest: () => policy };
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-harness-store-')));

// Центральная база: один файл SQLite.
const central = (dir: string) =>
  new DevContourExecutionStore(new Store(join(dir, 'state.sqlite')), options);
// Хранение по компонентам: coordinator и база компонента `app` в его каталоге.
const component = (dir: string) => {
  mkdirSync(join(dir, 'app'), { recursive: true });
  return new DevContourExecutionStore(
    new Store(join(dir, 'coordinator.sqlite'), [{ id: 'app', path: join(dir, 'app') }]),
    options,
  );
};

executionStoreContract('DevContour central', test, central, temp);
executionStoreContract('DevContour component', test, component, temp);

/** Задача доски так, как её создаёт продукт (с утверждением). */
function seed(store: Store) {
  const task: Task = {
    id: 'T-1',
    title: 'Добавить приветствие',
    description: 'Функция greet возвращает приветствие по имени.',
    role: 'backend',
    repositoryId: 'app',
    scope: 'component',
    dependsOn: [],
    acceptance: ['greet("Ada") возвращает Hello, Ada!'],
    contracts: [],
    contractDigests: {},
    writePaths: ['src'],
    status: 'ready',
    attempt: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    featureId: 'F-1',
  } as unknown as Task;
  task.approvedDigest = specDigest(task);
  task.approvedAt = '2026-01-01T00:01:00.000Z';
  task.approval = { actor: 'agent', authorRuntime: 'claude', reviewerRuntime: 'codex' };
  store.change('plan.imported', (s) => {
    s.tasks.push(task);
    s.boards.push({
      id: 'B-1',
      title: 'Доска',
      description: 'Цель доски',
      revisions: [
        {
          number: 1,
          status: 'active',
          reason: 'план',
          taskIds: ['T-1'],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    return { boardId: 'B-1' };
  });
}
const run = (over: Partial<Run> = {}): Run => ({
  id: 'R-1',
  taskId: 'T-1',
  repositoryId: 'app',
  attempt: 1,
  token: 'token-'.padEnd(32, 'x'),
  owner: 'controller-1',
  runtime: 'demo',
  reviewer: 'demo',
  policyDigest: policy,
  status: 'active',
  phase: 'running',
  startedAt: '2026-01-01T00:02:00.000Z',
  leaseUntil: Date.now() + 60_000,
  evidence: [],
  memory: { revision: 'm1', ids: ['K-1'], digest: digestOf('memory'), bytes: 10 },
  wait: { approvedAt: '2026-01-01T00:01:00.000Z' },
  ...over,
});

for (const [name, open] of [
  ['central', central],
  ['component', component],
] as const) {
  test(`${name}: задача доски — поручение графа доски; поля продукта сохраняются при записи исполнения`, () => {
    const dir = temp();
    const s = open(dir);
    seed(s.store);
    const work = s.read((v) => v.work('T-1'))!;
    assert.equal(work.graphId, 'B-1');
    assert.equal(work.order.goal, 'Функция greet возвращает приветствие по имени.');
    assert.deepEqual(work.order.writeScope, ['src']);
    assert.equal(work.order.source.revision, work.approvedDigest);
    const graph = s.read((v) => v.graph('B-1'))!;
    assert.deepEqual(
      graph.graph.orders.map((o) => o.id),
      ['T-1'],
    );
    assert.equal(
      graph.approval?.digest,
      graph.digest,
      'согласование графа — утверждения его задач',
    );
    assert.equal(graph.policyDigest, policy);
    s.transact('run.phase', (tx) =>
      tx.putWork({ ...tx.work('T-1')!, status: 'running', activeRunId: 'R-1' }),
    );
    const task = s.store.read().tasks[0] as Task & { featureId?: string };
    assert.equal(task.status, 'running');
    assert.equal(task.featureId, 'F-1', 'продуктовое поле задачи не тронуто');
    // Постановку меняет продукт: другое поручение отклоняется целиком.
    assert.throws(
      () =>
        s.transact('run.phase', (tx) =>
          tx.putWork({ ...tx.work('T-1')!, order: { ...tx.work('T-1')!.order, title: 'Другое' } }),
        ),
      /постановку задачи меняет продукт/,
    );
    // Регистрация графа исполнением отклоняется: граф регистрирует продукт.
    assert.throws(
      () => s.transact('graph.registered', (tx) => tx.putGraph({ ...graph, id: 'B-new' })),
      /граф регистрирует продукт/,
    );
    s.close();
  });

  test(`${name}: попытка — запись Run; поля хоста (memory, wait) сохраняются, runtime demo ↔ fixture`, () => {
    const s = open(temp());
    seed(s.store);
    s.store.change('run.claimed', (st) => {
      st.runs.push(run());
      return { runId: 'R-1' };
    });
    const a = s.read((v) => v.attempt('R-1'))!;
    assert.equal(a.workId, 'T-1');
    assert.equal(a.runtime, 'fixture');
    assert.equal(
      (a as Record<string, unknown>).memory,
      undefined,
      'поле хоста не попадает в попытку',
    );
    s.transact('run.phase', (tx) =>
      tx.putAttempt({ ...tx.attempt('R-1')!, phase: 'verifying', candidateSha: 'c'.repeat(40) }),
    );
    const stored = s.store.read().runs[0];
    assert.equal(stored.phase, 'verifying');
    assert.equal(stored.candidateSha, 'c'.repeat(40));
    assert.equal(stored.runtime, 'demo', 'сохранённое значение runtime прежнее');
    assert.deepEqual(stored.memory, run().memory, 'memory хоста сохранена');
    assert.deepEqual(stored.wait, run().wait);
    // Снятое поле попытки удаляется из Run.
    s.transact('run.phase', (tx) =>
      tx.putAttempt({ ...tx.attempt('R-1')!, candidateSha: undefined }),
    );
    assert.equal('candidateSha' in s.store.read().runs[0], false);
    s.close();
  });

  test(`${name}: попытка снимка разбирается один раз, но читающий получает свою копию; запись видна сразу, и в транзакции`, () => {
    const s = open(temp());
    seed(s.store);
    s.store.change('run.claimed', (st) => {
      st.runs.push(run());
      return { runId: 'R-1' };
    });
    // Первое чтение разбирает и кеширует; правится уже ответ из кеша.
    s.read((v) => v.attempt('R-1'));
    const first = s.read((v) => v.attempt('R-1'))!;
    (first as { phase: string }).phase = 'integrating';
    first.evidence.push({} as never);
    const again = s.read((v) => v.attempts('T-1'))[0];
    assert.equal(again.phase, 'running', 'правка копии не меняет следующий ответ');
    assert.equal(again.evidence.length, 0);
    s.transact('run.phase', (tx) => {
      tx.putAttempt({ ...tx.attempt('R-1')!, phase: 'verifying' });
      assert.equal(tx.attempt('R-1')!.phase, 'verifying', 'в транзакции — записанное значение');
    });
    assert.equal(
      s.read((v) => v.attempt('R-1'))!.phase,
      'verifying',
      'новая версия — новое значение',
    );
    s.close();
  });

  test(`${name}: поручение задачи без утверждения берёт digest контракта из прочитанного состояния, не перечитывая хранилище`, () => {
    const s = open(temp());
    seed(s.store);
    const digest = digestOf('contract');
    s.store.change('plan.imported', (st) => {
      st.contracts.push({ id: 'C-1', digest } as never);
      for (const id of ['T-2', 'T-3', 'T-4']) {
        const task = structuredClone(st.tasks[0]);
        Object.assign(task, { id, contracts: ['C-1'], status: 'draft' });
        delete task.approvedDigest;
        delete task.approval;
        st.tasks.push(task);
      }
      return {};
    });
    const read = s.store.read.bind(s.store);
    let reads = 0;
    s.store.read = () => {
      reads++;
      return read();
    };
    const works = s.read((v) => v.works());
    assert.deepEqual(
      works.filter((w) => w.id !== 'T-1').map((w) => w.order.contracts),
      [[{ id: 'C-1', digest }], [{ id: 'C-1', digest }], [{ id: 'C-1', digest }]],
    );
    assert.equal(reads, 0, 'такт очереди не перечитывает хранилище на каждую задачу');
    s.close();
  });

  test(`${name}: журнал — прежняя форма данных без токенов и harnessEvents; курсор id × 1024 + индекс`, () => {
    const s = open(temp());
    seed(s.store);
    s.store.change('run.claimed', (st) => {
      st.runs.push(run());
      return { runId: 'R-1' };
    });
    s.transact('run.phase', (tx) => {
      tx.putAttempt({ ...tx.attempt('R-1')!, phase: 'verifying' });
      tx.emit({
        type: 'attempt.phase',
        workId: 'T-1',
        runId: 'R-1',
        payload: { phase: 'verifying' },
      });
      tx.emit({
        type: 'attempt.phase',
        workId: 'T-1',
        runId: 'R-1',
        payload: { phase: 'reviewing' },
      });
    });
    const last = s.store.allEvents().at(-1)!;
    assert.equal(last.type, 'run.phase');
    const data = last.data as { taskId: string; runId: string; harnessEvents: unknown[] };
    assert.equal(data.taskId, 'T-1', 'ссылка на задачу — компонент события и фильтры хоста');
    assert.equal(data.runId, 'R-1');
    assert.equal(data.harnessEvents.length, 2);
    const events = s.events();
    assert.deepEqual(
      events.map((e) => e.seq),
      [last.id * 1024, last.id * 1024 + 1],
    );
    assert.deepEqual(
      s.events(events[0].seq).map((e) => e.payload),
      [{ phase: 'reviewing' }],
    );
    // Прежняя форма от хоста: повтор с причиной сброса; токены отсекаются на любой глубине.
    s.host('task.retry', (h) => {
      h.state.sequence++;
      h.journal({
        taskId: 'T-1',
        reset: { spent: 3, reason: 'база обновлена' },
        run: { token: 'secret-token-1' },
      });
    });
    const retry = s.store.allEvents().at(-1)!;
    assert.equal(retry.type, 'task.retry');
    assert.deepEqual(retry.data, {
      taskId: 'T-1',
      reset: { spent: 3, reason: 'база обновлена' },
      run: {},
    });
    assert.ok(!JSON.stringify(s.store.allEvents()).includes('secret-token-1'));
    assert.ok(
      !JSON.stringify(s.store.allEvents()).includes(run().token),
      'токен попытки не в журнале',
    );
    s.close();
  });

  test(`${name}: транзакция хоста — продуктовые поля и переходы движка одной записью; отказ откатывает обе части`, () => {
    const s = open(temp());
    seed(s.store);
    const events = s.store.eventCount();
    s.host('run.claimed', (h) => {
      (h.state.tasks[0] as Task & { assignee?: string }).assignee = 'dev-1';
      s.transact('run.claimed', (tx) => {
        tx.putWork({ ...tx.work('T-1')!, status: 'running' });
        tx.emit({ type: 'attempt.phase', workId: 'T-1', payload: { phase: 'running' } });
      });
    });
    assert.equal(s.store.eventCount(), events + 1, 'одно событие на всю транзакцию хоста');
    const task = s.store.read().tasks[0] as Task & { assignee?: string };
    assert.equal(task.status, 'running');
    assert.equal(task.assignee, 'dev-1');
    assert.throws(() =>
      s.host('run.claimed', (h) => {
        h.state.tasks[0].title = 'Испорчено';
        s.transact('run.phase', (tx) => tx.putWork({ ...tx.work('T-1')!, status: 'verifying' }));
        throw new Error('продуктовый отказ');
      }),
    );
    assert.equal(s.store.read().tasks[0].status, 'running');
    assert.equal(s.store.read().tasks[0].title, 'Добавить приветствие');
    assert.equal(s.store.eventCount(), events + 1);
    s.close();
  });

  test(`${name}: событие без изменения документа пишется Store.appendEvent; heartbeat события не пишет`, () => {
    const s = open(temp());
    seed(s.store);
    const before = s.store.eventCount();
    s.transact('delivery.recorded', (tx) => {
      tx.putLocal('delivery', WORKSPACE_OWNER, 'k1', {
        sink: 'files',
        key: 'k1',
        revision: '1',
        status: 'pending',
        attempts: 0,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      tx.emit({
        type: 'delivery.pending',
        payload: { sink: 'files', key: 'k1', revision: '1', attempts: 0 },
      });
    });
    assert.equal(s.store.eventCount(), before + 1);
    assert.equal(s.store.allEvents().at(-1)!.type, 'delivery.recorded');
    s.transact('heartbeat', (tx) => tx.putWork({ ...tx.work('T-1')!, attempt: 1 }));
    assert.equal(s.store.eventCount(), before + 1);
    s.close();
  });
}

test('component: локальные записи и события задачи компонента лежат в базе компонента', () => {
  const dir = temp();
  const s = component(dir);
  seed(s.store);
  s.transact('usage.recorded', (tx) =>
    tx.putLocal('usage', 'app', 'c1', {
      id: 'c1',
      stage: 'implementation',
      runtime: 'fixture',
      model: null,
      runtimeVersion: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      outcome: 'returned',
      promptBytes: 1,
      promptDigest: digestOf('p'),
      workId: 'T-1',
      groupId: 'B-1',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedUsd: null,
        complete: true,
        source: 'fixture',
      },
      costUsd: null,
      costSource: 'unknown',
    }),
  );
  // Хранится прежней формой учёта DevContour (taskId/boardId) в базе компонента.
  const raw = s.store.localRecords<{ taskId?: string; boardId?: string }>('usage', 'app').c1;
  assert.equal(raw.taskId, 'T-1');
  assert.equal(raw.boardId, 'B-1');
  assert.equal(s.read((v) => v.local('usage', 'app', 'c1'))?.workId, 'T-1');
  s.transact('run.phase', (tx) => {
    tx.putWork({ ...tx.work('T-1')!, status: 'running' });
    tx.emit({ type: 'attempt.phase', workId: 'T-1', payload: { phase: 'running' } });
  });
  // Событие задачи компонента — в журнале компонента; в coordinator — ссылка.
  const db = new DatabaseSync(join(dir, 'app', '.devcontour-local', 'state.sqlite'));
  const local = db.prepare('SELECT type, data FROM events ORDER BY id DESC LIMIT 1').get() as {
    type: string;
    data: string;
  };
  db.close();
  assert.equal(local.type, 'run.phase');
  assert.ok((JSON.parse(local.data) as { harnessEvents: unknown[] }).harnessEvents.length);
  assert.equal(s.events().at(-1)!.workId, 'T-1');
  s.close();
});

test('попытка вне договора: явный отказ с названием записи, а не тихая подмена', () => {
  const s = central(temp());
  seed(s.store);
  s.store.change('run.claimed', (st) => {
    st.runs.push(run({ candidateSha: 'candidate' }));
    return null;
  });
  assert.throws(
    () => s.read((v) => v.attempt('R-1')),
    /Попытка R-1: запись не соответствует договору harness — candidateSha/,
  );
  s.close();
});

test('транзакция с событиями сверх предела отклоняется целиком', () => {
  const s = central(temp());
  seed(s.store);
  assert.throws(
    () =>
      s.transact('run.phase', (tx) => {
        tx.putWork({ ...tx.work('T-1')!, status: 'running' });
        for (let i = 0; i <= 1024; i++)
          tx.emit({ type: 'attempt.phase', workId: 'T-1', payload: { phase: 'running' } });
      }),
    /Слишком много событий/,
  );
  assert.equal(s.store.read().tasks[0].status, 'ready');
  s.close();
});

test('движок поверх адаптера: выдача, fencing чужого токена и истёкшей попытки — в документе DevContour', async () => {
  const { Engine, executionDigest, executionPolicySchema, standaloneHost, HarnessError } =
    await import('devcontour-harness');
  const policy = executionPolicySchema.parse({
    policyVersion: 1,
    repositories: [
      {
        id: 'app',
        path: '.',
        targetRef: 'refs/heads/devcontour/accepted',
        gates: [
          {
            id: 'test',
            kind: 'test',
            command: ['node', 'verify.mjs'],
            report: { type: 'junit', path: '.reports/junit.xml' },
          },
        ],
      },
    ],
    roles: { backend: { writer: { runtime: 'claude' } } },
    review: {
      code: { reviewer: { runtime: 'codex' } },
      plan: { reviewer: { runtime: 'codex' } },
      contract: { reviewer: { runtime: 'codex' } },
    },
  });
  const dir = temp();
  const store = new Store(join(dir, 'state.sqlite'));
  const adapter = new DevContourExecutionStore(store, {
    policyDigest: () => executionDigest(policy),
  });
  seed(store);
  store.change('scheduler.started', (s) => {
    s.paused = false;
    return {};
  });
  const standalone = standaloneHost(adapter, policy);
  let now = Date.now();
  const engine = new Engine({
    host: {
      ...standalone,
      basis: {
        ...standalone.basis,
        // Основание постановки — формула DevContour (задаёт хост).
        orderDigest: (work) => specDigest(store.read().tasks.find((t) => t.id === work.id)!),
      },
    },
    policy,
    now: () => now,
  });
  assert.equal(engine.lead('controller-1'), true);
  assert.equal(store.read().leader?.owner, 'controller-1', 'роль controller — leader DevContour');
  const a = engine.claim('controller-1')!;
  assert.ok(a, 'утверждённая задача доски выдана');
  const run = store.read().runs.find((r) => r.id === a.id)!;
  assert.equal(run.taskId, 'T-1');
  assert.equal(run.token, a.token, 'токен владения хранится в Run');
  assert.equal(store.read().tasks[0].status, 'running');
  const refused = (code: string) => (e: unknown) => e instanceof HarnessError && e.code === code;
  const snapshot = JSON.stringify(store.read().runs);
  assert.throws(() => engine.heartbeat(a.id, 'x'.repeat(32)), refused('LEASE_STALE'));
  assert.equal(JSON.stringify(store.read().runs), snapshot, 'чужой токен ничего не записал');
  now += policy.leaseMs + 1;
  engine.expire();
  assert.equal(store.read().runs[0].status, 'expired');
  assert.throws(
    () => engine.phase(a.id, a.token, 'verifying', { candidateSha: 'c'.repeat(40) }),
    refused('LEASE_STALE'),
  );
  assert.equal(store.read().runs[0].candidateSha, undefined, 'истёкшая попытка не пишет');
  adapter.close();
});
