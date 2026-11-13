// Gates задачи для ведущего: briefing называет то, что исполнит попытка
// задачи (область `gates` с раскрытыми группами или весь профиль), правка
// одних gates не меняет specDigest, но меняет scopeDigest, а карточка
// утверждения плана оператором видит такую правку как новую версию.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContext } from '../src/application/context.ts';
import { AgentService } from '../src/application/agent.ts';
import { AttentionService } from '../src/application/attention.ts';
import { DevContour, digest, scopeDigest, specDigest } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { DomainError } from '../src/core/model.ts';
import { executionOf } from '../src/harness/execution.ts';
import { taskGates } from '../src/application/context.ts';
import { config, input } from './helpers.ts';

const report = { type: 'junit' as const, path: '.reports/junit.xml' };

function gatesFixture() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-task-gates-'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(
    store,
    config({
      gates: [
        { id: 'unit', kind: 'test', command: ['node', 'unit.mjs'], timeoutMs: 60_000, report },
        { id: 'lint', kind: 'check', command: ['node', 'lint.mjs'], timeoutMs: 60_000 },
        {
          id: 'e2e',
          kind: 'test',
          command: ['node', 'e2e.mjs'],
          timeoutMs: 60_000,
          report,
          when: { paths: ['web/**'] },
        },
      ],
      gateGroups: { fast: ['unit', 'lint'] },
    }),
  );
  return {
    store,
    h,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Execution = {
  gateScope: 'task' | 'profile';
  gates: { id: string; kind: string; when?: { paths: string[] } }[];
  outsideScope?: string[];
  gatesError?: string;
};
const briefing = (h: DevContour, taskId: string) =>
  new AgentContext(h).execute('task_briefing', { taskId }) as {
    task: { specDigest: string; scopeDigest: string };
    execution: Execution;
  };

test('task_briefing: execution.gates — область задачи с раскрытыми группами, без области — весь профиль', () => {
  const f = gatesFixture();
  try {
    const board = f.h.createBoard('Board');
    const scoped = f.h.addTask(board.id, { ...input('Scoped task'), gates: ['@fast'] });
    const whole = f.h.addTask(board.id, input('Profile task'));

    const own = briefing(f.h, scoped.id).execution;
    assert.equal(own.gateScope, 'task');
    assert.deepEqual(own.gates, [
      { id: 'unit', kind: 'test' },
      { id: 'lint', kind: 'check' },
    ]);
    assert.deepEqual(own.outsideScope, ['e2e']);

    const profile = briefing(f.h, whole.id).execution;
    assert.equal(profile.gateScope, 'profile');
    assert.deepEqual(profile.gates, [
      { id: 'unit', kind: 'test' },
      { id: 'lint', kind: 'check' },
      { id: 'e2e', kind: 'test', when: { paths: ['web/**'] } },
    ]);
    assert.equal(profile.outsideScope, undefined);
  } finally {
    f.cleanup();
  }
});

test('task_edit: правка одних gates — тот же specDigest, новый scopeDigest; briefing и ответ согласны', () => {
  const f = gatesFixture();
  try {
    const api = new AgentService(f.h);
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, { ...input('Scoped task'), gates: ['@fast'] });
    const before = briefing(f.h, task.id).task;
    assert.equal(before.scopeDigest, scopeDigest(task));

    const edited = api.execute({
      operation: 'task_edit',
      input: {
        taskId: task.id,
        expectedDigest: before.specDigest,
        task: { ...input('Scoped task'), gates: ['unit'] },
      },
    }) as { specDigest: string; scopeDigest: string };
    assert.equal(edited.specDigest, before.specDigest, 'gates не входят в digest постановки');
    assert.notEqual(edited.scopeDigest, before.scopeDigest, 'область проверок закреплена отдельно');

    const after = briefing(f.h, task.id);
    assert.equal(after.task.scopeDigest, edited.scopeDigest);
    assert.deepEqual(after.execution.gates, [{ id: 'unit', kind: 'test' }]);
    assert.deepEqual(after.execution.outsideScope, ['lint', 'e2e']);

    // Ревью плана, прочитавшее прежнюю область, утверждения не даёт.
    const r = f.store.read().boards[0].revisions.at(-1)!;
    assert.throws(
      () =>
        f.h.approve(board.id, [task.id], undefined, {
          revision: r.number,
          reason: r.reason,
          taskIds: r.taskIds,
          tasks: { [task.id]: before.specDigest },
          scopes: { [task.id]: before.scopeDigest },
        }),
      /План изменился/,
    );
    f.h.approve(board.id, [task.id], undefined, {
      revision: r.number,
      reason: r.reason,
      taskIds: r.taskIds,
      tasks: { [task.id]: edited.specDigest },
      scopes: { [task.id]: edited.scopeDigest },
    });
    assert.equal(f.store.read().tasks[0].approvedScope, edited.scopeDigest);
  } finally {
    f.cleanup();
  }
});

test('Карточка утверждения плана оператором: правка одних gates — новая версия, прежняя отклоняется', async () => {
  const f = gatesFixture();
  try {
    f.h.config.approvalMode = 'operator';
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, { ...input('Scoped task'), gates: ['@fast'] });
    const card = async () => {
      const items = (await new AttentionService(f.store, f.h).active()).items;
      return items.find((i) => i.sourceKey === `plan:${board.id}`)!;
    };
    const shown = await card();
    assert.ok(shown, 'карточка утверждения плана');
    f.h.editTask(task.id, { ...input('Scoped task'), gates: ['unit'] }, specDigest(task));
    const fresh = await card();
    assert.notEqual(fresh.sourceVersion, shown.sourceVersion);
    await assert.rejects(
      new AttentionService(f.store, f.h).act({
        sourceKey: shown.sourceKey,
        occurrenceId: shown.occurrenceId,
        expectedVersion: shown.sourceVersion,
        action: 'approve',
      }),
      (e: unknown) =>
        e instanceof DomainError && e.status === 409 && e.details?.code === 'attention-stale',
    );
    assert.equal(f.store.read().tasks[0].status, 'draft');
    await new AttentionService(f.store, f.h).act({
      sourceKey: fresh.sourceKey,
      occurrenceId: fresh.occurrenceId,
      expectedVersion: fresh.sourceVersion,
      action: 'approve',
    });
    const approved = f.store.read().tasks[0];
    assert.equal(approved.status, 'ready');
    assert.equal(approved.approvedScope, scopeDigest(approved));
  } finally {
    f.cleanup();
  }
});

test('Карточка утверждения плана: черновики без gates и потребителей сохраняют версию карточки', async () => {
  const f = gatesFixture();
  try {
    f.h.config.approvalMode = 'operator';
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, input('Plain task'));
    const items = (await new AttentionService(f.store, f.h).active()).items;
    const card = items.find((i) => i.sourceKey === `plan:${board.id}`)!;
    // Формула версии до закрепления области: digest постановки каждого черновика.
    const before = digest({
      taskIds: [task.id],
      drafts: [[task.id, specDigest(task)]],
      stale: [],
      blocked: [],
      unverified: [],
    }).slice(0, 32);
    assert.equal(card.sourceVersion, before);
  } finally {
    f.cleanup();
  }
});

test('discussion_resolve: правка одних gates черновика после обращения — принятие по этой задаче', async () => {
  const f = gatesFixture();
  try {
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, { ...input('Scoped task'), gates: ['@fast'] });
    const d = new DiscussionService(f.h);
    await new Promise((r) => setTimeout(r, 5));
    const request = d.post(
      {
        taskId: task.id,
        kind: 'change-request',
        text: 'Add the e2e gate',
        idempotencyKey: 'idem-key-0001',
        expectedVersion: 0,
      },
      'operator',
    );
    await new Promise((r) => setTimeout(r, 5));
    f.h.editTask(
      task.id,
      { ...input('Scoped task'), gates: ['@fast', 'e2e'] },
      specDigest(task),
      scopeDigest(task),
    );
    const done = d.resolve({
      requestId: request.message.id,
      outcome: 'accepted',
      reason: 'The e2e gate is in the task scope',
      refs: { taskIds: [task.id] },
      idempotencyKey: 'idem-key-0002',
      expectedVersion: request.version,
    });
    assert.equal(done.message.kind, 'disposition');
  } finally {
    f.cleanup();
  }
});

test('task_edit: expectedScopeDigest — правка с устаревшей областью отклоняется', () => {
  const f = gatesFixture();
  try {
    const api = new AgentService(f.h);
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, { ...input('Scoped task'), gates: ['@fast'] });
    const seen = { spec: specDigest(task), scope: scopeDigest(task) };
    // Другой правящий меняет одни gates.
    f.h.editTask(task.id, { ...input('Scoped task'), gates: ['unit'] }, seen.spec, seen.scope);
    const edit = (expectedScopeDigest?: string) =>
      api.execute({
        operation: 'task_edit',
        input: {
          taskId: task.id,
          expectedDigest: seen.spec,
          ...(expectedScopeDigest ? { expectedScopeDigest } : {}),
          task: { ...input('Scoped task'), gates: ['@fast'] },
        },
      });
    assert.throws(() => edit(seen.scope), /Задача изменилась/);
    assert.deepEqual(f.store.read().tasks[0].gates, ['unit'], 'чужая правка gates сохранена');
    const current = scopeDigest(f.store.read().tasks[0]);
    assert.equal((edit(current) as { scopeDigest: string }).scopeDigest, seen.scope);
    // Без поля — прежнее поведение: сверяется только specDigest.
    f.h.editTask(task.id, { ...input('Scoped task'), gates: ['unit'] }, seen.spec);
    edit();
    assert.deepEqual(f.store.read().tasks[0].gates, ['@fast']);
  } finally {
    f.cleanup();
  }
});

test('task_briefing: gates совпадают с requiredGates выданной попытки; требования добавляют requirement-source', () => {
  const f = gatesFixture();
  try {
    const board = f.h.createBoard('Board');
    const scoped = f.h.addTask(board.id, { ...input('Scoped task'), gates: ['@fast'] });
    f.h.addTask(board.id, input('Profile task'));
    f.h.approve(board.id);
    f.h.pause(false);
    const { store } = executionOf(f.h);
    for (let i = 0; i < 2; i++) {
      const run = f.h.claim('test')!;
      const required = store.read((v) => v.attempts(run.taskId).at(-1)!.requiredGates);
      assert.deepEqual(
        briefing(f.h, run.taskId).execution.gates.map((g) => g.id),
        required,
        run.taskId === scoped.id ? 'область задачи' : 'весь профиль',
      );
    }
    const withRequirements = taskGates(f.h.config, {
      repositoryId: 'main',
      gates: ['unit'],
      requirements: [
        {
          source: 'docs/spec.md',
          id: 'REQ-a',
          text: 'A',
          digest: 'a'.repeat(64),
          gate: 'unit',
          scenario: 'A',
        },
      ] as never,
    });
    assert.deepEqual('gates' in withRequirements ? withRequirements.gates.map((g) => g.id) : [], [
      'unit',
      'requirement-source',
    ]);
  } finally {
    f.cleanup();
  }
});
