// Что видит ведущий: короткий id доски в пакете передачи, задания досок
// компонентов в workflow_status без repositoryId и идущая совместная проверка
// задания ChangeSet (в workflow_status, пакете передачи и строке панели).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGED, complete, fixture, input } from './helpers.ts';
import { specDigest } from '../src/core/service.ts';
import { AgentService } from '../src/application/agent.ts';
import { devcontourHandoff, handoffResponse } from '../src/application/handoff.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { Workspace } from '../src/core/workspace.ts';
import { DomainError } from '../src/core/model.ts';
import { resolveIdPrefix } from '../src/core/id-prefix.ts';
import { workflowWork, type LiveState } from '../src/web/LiveWork.tsx';

type Fixture = ReturnType<typeof fixture>;

/** Выпущенная доска компонента `main` с id `id` (вместо случайного UUID). */
function releasedBoard(f: Fixture, id: string, title: string) {
  const created = f.h.createBoard(title, '', 'main');
  f.store.change('fixture.board-id', (s) => {
    s.boards.find((b) => b.id === created.id)!.id = id;
  });
  f.h.addTask(id, input(title + ' task'));
  f.h.approve(id);
  return id;
}

test('session_handoff: короткий id доски — однозначный префикс; неоднозначный называет кандидатов', () => {
  const f = fixture();
  try {
    const full = releasedBoard(f, 'B-1a2b3c4d-0000-4000-8000-00000000000a', 'Short id');
    releasedBoard(f, 'B-77aa7700-1111-4000-8000-000000000001', 'Twin one');
    releasedBoard(f, 'B-77aa7700-2222-4000-8000-000000000002', 'Twin two');
    const byFull = devcontourHandoff(f.h, { boardId: full });
    const byShort = devcontourHandoff(f.h, { boardId: 'B-1a2b3c4d' });
    assert.deepEqual(byShort.pack, { ...byFull.pack, at: byShort.pack.at });
    // Тот же путь у операции агентского API.
    const viaAgent = new AgentService(f.h, f.root).execute({
      operation: 'session_handoff',
      input: { boardId: 'B-1a2b3c4d' },
    }) as { pack: { graph?: { id: string } } };
    assert.ok(JSON.stringify(viaAgent.pack).includes(full));
    assert.throws(
      () => devcontourHandoff(f.h, { boardId: 'B-77aa7700' }),
      (e: unknown) =>
        e instanceof DomainError &&
        e.status === 409 &&
        /неоднозначен/.test(e.message) &&
        e.message.includes('B-77aa7700-1111-4000-8000-000000000001') &&
        e.message.includes('B-77aa7700-2222-4000-8000-000000000002'),
    );
    // Префикс короче восьми знаков после метки не ищется, даже однозначный:
    // отказ 404 называет нужную длину.
    assert.throws(
      () => devcontourHandoff(f.h, { boardId: 'B-1a2b3c' }),
      (e: unknown) =>
        e instanceof DomainError &&
        e.status === 404 &&
        /не короче 8 знаков после «B-»/.test(e.message),
    );
    assert.throws(
      () => devcontourHandoff(f.h, { boardId: 'B-ffffffff' }),
      (e: unknown) => e instanceof DomainError && e.status === 404,
    );
  } finally {
    f.cleanup();
  }
});

test('resolveIdPrefix: полное совпадение важнее префикса, короткий префикс отклоняется, кандидатов не больше десяти', () => {
  const ids = [
    'B-12345678',
    'B-123456789',
    ...Array.from({ length: 12 }, (_, i) => `C-99999999-${i}`),
  ];
  assert.equal(resolveIdPrefix(ids, 'B-12345678', 'Доска'), 'B-12345678');
  assert.equal(resolveIdPrefix(ids, 'B-123456789', 'Доска'), 'B-123456789');
  // Полный id короче предела находится как есть.
  assert.equal(resolveIdPrefix(['B-1'], 'B-1', 'Доска'), 'B-1');
  assert.equal(resolveIdPrefix(['B-123456789'], 'B-12345678', 'Доска'), 'B-123456789');
  assert.equal(resolveIdPrefix(ids, 'B-ffffffff', 'Доска'), undefined);
  assert.throws(
    () => resolveIdPrefix(['B-123456789'], 'B-1234567', 'Доска'),
    (e: unknown) => e instanceof DomainError && e.status === 404 && /B-xxxxxxxx/.test(e.message),
  );
  assert.throws(
    () => resolveIdPrefix(['abcdefghij'], 'abcdefg', 'Доска'),
    (e: unknown) => e instanceof DomainError && e.status === 404 && /после начала/.test(e.message),
  );
  assert.equal(resolveIdPrefix(['abcdefghij'], 'abcdefgh', 'Доска'), 'abcdefghij');
  assert.throws(
    () => resolveIdPrefix(['B-123456780', 'B-123456781'], 'B-12345678', 'Доска'),
    (e: unknown) =>
      e instanceof DomainError && e.status === 409 && /B-123456780, B-123456781/.test(e.message),
  );
  assert.throws(
    () => resolveIdPrefix(ids, 'C-99999999', 'Доска'),
    (e: unknown) =>
      e instanceof DomainError && /подходят 12/.test(e.message) && /и ещё 2/.test(e.message),
  );
});

test('workflow_status без repositoryId называет задания досок компонентов и как их прочитать', () => {
  const f = fixture();
  try {
    const flow = new LeadWorkflow(f.h);
    const board = f.h.createBoard('Component board', '', 'main');
    const task = f.h.addTask(board.id, input());
    const agent = new AgentService(f.h, f.root);
    // Нет заданий компонентов — нет и сводки.
    const none = agent.execute({ operation: 'workflow_status', input: {} });
    assert.equal('otherOwners' in none, false);
    assert.equal('otherOwnersHint' in none, false);
    const job = flow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    assert.equal(job.owner, 'main');
    const all = agent.execute({ operation: 'workflow_status', input: {} }) as {
      jobs: { key: string }[];
      otherOwners?: { repositoryId: string; jobs: number; active: number }[];
      otherOwnersHint?: string;
    };
    assert.deepEqual(all.jobs, []);
    assert.deepEqual(all.otherOwners, [{ repositoryId: 'main', jobs: 1, active: 1 }]);
    assert.match(all.otherOwnersHint ?? '', /repositoryId main/);
    // С repositoryId — сами задания, без сводки других владельцев.
    const own = agent.execute({
      operation: 'workflow_status',
      input: { repositoryId: 'main' },
    }) as { jobs: { key: string }[]; otherOwners?: unknown };
    assert.deepEqual(
      own.jobs.map((j) => j.key),
      [job.key],
    );
    assert.equal(own.otherOwners, undefined);
    // Задание закончилось (вход изменился — stale): сводка остаётся, действующих
    // нет, подсказка общая, без списка компонентов.
    f.h.editTask(
      task.id,
      { ...input(), description: 'A changed requirement invalidates pending work.' },
      specDigest(task),
    );
    assert.equal(flow.claim(job.key, 'main'), undefined);
    assert.equal(flow.get(job.key, 'main').status, 'stale');
    const done = agent.execute({ operation: 'workflow_status', input: {} }) as typeof all;
    assert.deepEqual(done.otherOwners, [{ repositoryId: 'main', jobs: 1, active: 0 }]);
    assert.match(done.otherOwnersHint ?? '', /^Jobs of component-local boards/);
    assert.doesNotMatch(done.otherOwnersHint ?? '', /repositoryId main/);
  } finally {
    f.cleanup();
  }
});

test('Идущая совместная проверка задания ChangeSet видна: workflow_status, пакет передачи и строка панели', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Joint board');
    const t = f.h.addTask(b.id, input('Joint task'));
    f.h.approve(b.id);
    complete(f.h, t.id);
    f.h.accept(b.id, MERGED);
    const change = new Workspace(f.h).create({
      title: 'Joint result',
      description: 'A joint verification of the accepted board.',
      boardIds: [b.id],
    });
    // Доска вне набора: пакет этой доски проверку набора не называет.
    const other = f.h.createBoard('Other board');
    f.h.addTask(other.id, input('Other task'));
    f.h.approve(other.id);
    const flow = new LeadWorkflow(f.h);
    const started = flow.start({ kind: 'changeset', id: change.id, authorRuntime: 'codex' });
    // Стадия 0 закончена; стадия 1 ответила «жду» — задание снова в очереди.
    flow.finish(flow.claim(started.key)!);
    flow.finish(flow.claim(started.key)!, true);
    const job = flow.get(started.key);
    assert.equal(job.status, 'queued');
    assert.equal(job.stage, 1);
    assert.equal(job.attempts, 0);
    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const verificationId = '0f0f0f0f-1111-4000-8000-000000000001';
    f.store.change('fixture.verification', (s) => {
      s.changeSets
        .find((c) => c.id === change.id)!
        .verifications.push({
          id: verificationId,
          token: 'fixture-token-0000000',
          leaseUntil: Date.now() + 60_000,
          startedAt,
          status: 'active',
          policyDigest: 'a'.repeat(64),
          specDigest: 'b'.repeat(64),
          tasks: [],
          boards: [],
          evidence: [],
        });
    });
    // workflow_status
    const status = new AgentService(f.h, f.root).execute({
      operation: 'workflow_status',
      input: {},
    }) as {
      jobs: {
        key: string;
        waiting?: { kind: string; verificationId: string; startedAt: string; elapsedMs: number };
      }[];
    };
    const waiting = status.jobs.find((j) => j.key === job.key)?.waiting;
    assert.equal(waiting?.kind, 'verification');
    assert.equal(waiting?.verificationId, verificationId);
    assert.equal(waiting?.startedAt, startedAt);
    assert.ok(waiting.elapsedMs >= 3 * 60_000 && waiting.elapsedMs < 4 * 60_000);
    // Пакет передачи: и без доски, и с доской набора.
    for (const value of [devcontourHandoff(f.h), devcontourHandoff(f.h, { boardId: b.id })]) {
      const [v] = value.host.verifications ?? [];
      assert.equal(v?.changeSetId, change.id);
      assert.equal(v?.verificationId, verificationId);
      assert.deepEqual(v?.job, { key: job.key, status: 'queued', stage: 1, attempts: 0 });
      assert.ok(v.elapsedMs >= 3 * 60_000);
      const md = handoffResponse(value, 'md').markdown!;
      assert.match(md, new RegExp(`совместная проверка ChangeSet ${change.id}: ${verificationId}`));
    }
    // Панель: строка «Совместная проверка» с id проверки и временем от её начала.
    const view = flow.view().find((w) => w.key === job.key)!;
    assert.equal((view.waiting as { kind?: string } | undefined)?.kind, 'verification');
    const state = {
      runs: [],
      workflows: [view],
      changeSets: [{ id: change.id, title: change.title }],
      tasks: [],
      boards: [],
      paused: false,
      ready: [],
      config: { concurrency: 1 },
    } as unknown as LiveState;
    const [row] = workflowWork(state);
    assert.equal(row?.label, 'Совместная проверка');
    assert.equal(row?.since, startedAt);
    assert.match(row?.who ?? '', /0f0f0f0f/);
    assert.equal(devcontourHandoff(f.h, { boardId: other.id }).host.verifications, undefined);
    const quiet = () => {
      const s = new AgentService(f.h, f.root).execute({
        operation: 'workflow_status',
        input: {},
      }) as { jobs: { key: string; waiting?: unknown }[] };
      assert.equal(s.jobs.find((j) => j.key === job.key)?.waiting, undefined);
      assert.equal(devcontourHandoff(f.h).host.verifications, undefined);
      const w = flow.view().find((x) => x.key === job.key)!;
      assert.deepEqual(workflowWork({ ...state, workflows: [w] }), []);
    };
    const setVerification = (patch: {
      status?: 'active' | 'passed';
      finishedAt?: string;
      manifest?: Record<string, never>;
      manifestDigest?: string;
      leaseUntil?: number;
    }) =>
      f.store.change('fixture.verification-patch', (s) => {
        Object.assign(s.changeSets.find((c) => c.id === change.id)!.verifications[0], patch);
      });
    // Закончившаяся проверка со всё ещё действующим сроком — не идёт.
    setVerification({
      status: 'passed',
      finishedAt: new Date().toISOString(),
      manifest: {},
      manifestDigest: 'c'.repeat(64),
    });
    quiet();
    setVerification({
      status: 'active',
      finishedAt: undefined,
      manifest: undefined,
      manifestDigest: undefined,
    });
    // Проверка с истёкшим сроком владения не идёт — ни ожидания, ни строки.
    setVerification({ leaseUntil: 0 });
    quiet();
    // Задание не на стадии 1 (стадия 2, приёмка) — идущая проверка не его ожидание.
    setVerification({ leaseUntil: Date.now() + 60_000 });
    flow.finish(flow.claim(job.key)!);
    assert.equal(flow.get(job.key).stage, 2);
    quiet();
  } finally {
    f.cleanup();
  }
});
