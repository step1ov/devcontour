// Что видит ведущий: короткий id доски в пакете передачи, задания досок
// компонентов в workflow_status без repositoryId и идущая совместная проверка
// задания ChangeSet (в workflow_status, пакете передачи и строке панели).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MERGED, complete, fixture, input } from './helpers.ts';
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
    const full = releasedBoard(f, 'B-94be8215-0f87-4717-9eb5-2d2e0ea2bf2f', 'Short id');
    releasedBoard(f, 'B-77aa0001-0000-4000-8000-000000000001', 'Twin one');
    releasedBoard(f, 'B-77aa0002-0000-4000-8000-000000000002', 'Twin two');
    const byFull = devcontourHandoff(f.h, { boardId: full });
    const byShort = devcontourHandoff(f.h, { boardId: 'B-94be8215' });
    assert.deepEqual(byShort.pack, { ...byFull.pack, at: byShort.pack.at });
    // Тот же путь у операции агентского API.
    const viaAgent = new AgentService(f.h, f.root).execute({
      operation: 'session_handoff',
      input: { boardId: 'B-94be8215' },
    }) as { pack: { graph?: { id: string } } };
    assert.ok(JSON.stringify(viaAgent.pack).includes(full));
    assert.throws(
      () => devcontourHandoff(f.h, { boardId: 'B-77aa' }),
      (e: unknown) =>
        e instanceof DomainError &&
        e.status === 409 &&
        /неоднозначен/.test(e.message) &&
        e.message.includes('B-77aa0001-0000-4000-8000-000000000001') &&
        e.message.includes('B-77aa0002-0000-4000-8000-000000000002'),
    );
    assert.throws(
      () => devcontourHandoff(f.h, { boardId: 'B-ffffffff' }),
      (e: unknown) => e instanceof DomainError && e.status === 404,
    );
  } finally {
    f.cleanup();
  }
});

test('resolveIdPrefix: полное совпадение важнее префикса, короткий префикс не ищется, кандидатов не больше десяти', () => {
  const ids = ['B-1234', 'B-12345', ...Array.from({ length: 12 }, (_, i) => `C-9999-${i}`)];
  assert.equal(resolveIdPrefix(ids, 'B-1234', 'Доска'), 'B-1234');
  assert.equal(resolveIdPrefix(ids, 'B-12345', 'Доска'), 'B-12345');
  assert.equal(resolveIdPrefix(['B-12345'], 'B-123', 'Доска'), 'B-12345');
  assert.equal(resolveIdPrefix(['B-12345'], 'B-1', 'Доска'), undefined);
  assert.equal(resolveIdPrefix(ids, 'B-x9', 'Доска'), undefined);
  assert.throws(
    () => resolveIdPrefix(ids, 'B-123', 'Доска'),
    (e: unknown) =>
      e instanceof DomainError && e.status === 409 && /B-1234, B-12345/.test(e.message),
  );
  assert.throws(
    () => resolveIdPrefix(ids, 'C-9999', 'Доска'),
    (e: unknown) =>
      e instanceof DomainError && /подходят 12/.test(e.message) && /и ещё 2/.test(e.message),
  );
});

test('workflow_status без repositoryId называет задания досок компонентов и как их прочитать', () => {
  const f = fixture();
  try {
    const flow = new LeadWorkflow(f.h);
    const board = f.h.createBoard('Component board', '', 'main');
    f.h.addTask(board.id, input());
    const job = flow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    assert.equal(job.owner, 'main');
    const agent = new AgentService(f.h, f.root);
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
    const verificationId = 'fe786c6d-d95e-45c7-a5e3-b41506042ceb';
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
    assert.match(row?.who ?? '', /fe786c6d/);
    // Проверка с истёкшим сроком владения не идёт — ни ожидания, ни строки.
    f.store.change('fixture.lease', (s) => {
      s.changeSets.find((c) => c.id === change.id)!.verifications[0].leaseUntil = 0;
    });
    const after = new AgentService(f.h, f.root).execute({
      operation: 'workflow_status',
      input: {},
    }) as { jobs: { key: string; waiting?: unknown }[] };
    assert.equal(after.jobs.find((j) => j.key === job.key)?.waiting, undefined);
    assert.equal(devcontourHandoff(f.h).host.verifications, undefined);
  } finally {
    f.cleanup();
  }
});
