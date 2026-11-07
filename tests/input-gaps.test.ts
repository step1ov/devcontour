// Вопросы исполнителя: переживание перезапуска на каждом этапе, устаревшее
// применение, follow-up, маскирование, ожидание задания в режиме оператора,
// остановка восстановления по другой причине и перенос ответа в новую
// редакцию. Модели не вызываются: demo-исполнитель и управляемый reviewer.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  controlled,
  inputDemos,
  inputFixture,
  prepared,
  untilQuestion,
  type InputFixture,
} from './input-fixture.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { InputService, inputHolds } from '../src/application/input.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { AgentService } from '../src/application/agent.ts';
import { LeadWorkflow, WAITING_INPUT } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { readyTasks } from '../src/core/graph.ts';
import { executionOf } from '../src/harness/execution.ts';
import type { AgentAdapter } from '../src/runner/adapters.ts';

after(() => inputDemos.close());

/** Процесс заменён: новое хранилище, DevContour, служба и планировщик над тем же каталогом. */
async function reopened(f: InputFixture, runtimes: Record<string, AgentAdapter>) {
  await f.scheduler.stop();
  f.store.close();
  const store = new Store(join(f.root, 'state.sqlite'));
  const h = new DevContour(store, loadConfig(join(f.root, 'config.json')));
  const scheduler = new Scheduler(h, f.root, runtimes);
  await scheduler.init();
  return Object.assign(f, { store, h, scheduler, service: new InputService(h, f.root, runtimes) });
}

const visible = (f: InputFixture, requestId: string) => {
  const r = f.service.show({ requestId });
  return {
    state: r.state,
    lifecycle: r.lifecycle,
    version: r.version,
    actor: r.actor,
    next: r.next,
    question: r.question,
    answers: r.answers,
    reviews: r.reviews,
  };
};

test('D03-B: question, answer, state and wait reason survive a process restart at every stage; repeats do not duplicate', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [{ requestId }] = f.service.list({ taskId }).requests;
    const survives = async (stage: string) => {
      const before = visible(f, requestId);
      await reopened(f, runtimes);
      assert.deepEqual(visible(f, requestId), before, stage);
      return before;
    };
    assert.equal((await survives('pending')).state, 'awaiting-answer');
    const answer = { requestId, text: 'Use JSON as now.', optionId: 'json', expectedVersion: 1 };
    const answered = f.service.answer(answer, 'operator');
    // Повтор того же ответа после обрыва — та же версия.
    assert.equal(
      f.service.answer({ ...answer, expectedVersion: answered.version }, 'operator').changed,
      false,
    );
    assert.equal((await survives('answered')).state, 'answer-saved');
    const context = await f.service.context({ requestId });
    const review = await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    assert.equal((await survives('reviewed')).state, 'ready-to-apply');
    // Повтор ревью после перезапуска — тот же раунд.
    const again = await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    assert.equal(again.round, review.round);
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    const apply = {
      requestId,
      answerDigest: answered.answerDigest,
      expectedVersion: target.version,
      contextDigest: context.contextDigest,
      targetDigest: target.targetDigest!,
    };
    f.service.apply(apply, 'lead');
    assert.equal((await survives('applied')).state, 'applied-awaiting-claim');
    assert.equal(
      f.service.apply(apply, 'lead').changed,
      false,
      'повтор применения после перезапуска',
    );
    // Остановка прежнего процесса поставила паузу штатной остановки.
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal((await survives('delivered')).state, 'delivered');
    const runs = f.store.read().runs.filter((r) => r.taskId === taskId);
    assert.equal(runs.length, 2, 'одна попытка вопроса и одна с ответом');
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
  } finally {
    await f.cleanup();
  }
});

test('A stale applied answer holds the task, host.next says rebuild, and the rebuilt answer is delivered', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [{ requestId }] = f.service.list({ taskId }).requests;
    const p = await prepared(f, requestId, 'lead');
    f.service.apply(p.apply, 'lead');
    // Снимок перестал относиться к утверждению задачи (как после новой
    // редакции): claim не выдаёт задачу без ответа и возвращает его в answered.
    f.store.change('test.respec-context', (s) => {
      s.tasks.find((t) => t.id === taskId)!.inputContext!.approvedDigest = 'f'.repeat(64);
    });
    await f.scheduler.drain();
    const stale = f.service.show({ requestId });
    assert.equal(stale.state, 'stale');
    assert.equal(stale.lifecycle, 'answered');
    assert.equal(stale.stale?.reason, 'context');
    assert.equal(f.store.read().runs.filter((r) => r.taskId === taskId).length, 1);
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'ready');
    assert.equal(
      readyTasks(f.store.read(), inputHolds(f.h)).some((t) => t.id === taskId),
      false,
    );
    const next = devcontourHandoff(f.h, {}).host.next;
    assert.equal(next?.action, 'apply-input', JSON.stringify(next));
    assert.equal(next?.input?.state, 'stale');
    assert.match(next.detail, /went stale.*rebuild/);
    // Новый снимок, ревью и применение — ответ доходит до исполнителя.
    const context = await f.service.context({ requestId });
    await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    assert.deepEqual(target.problems, []);
    f.service.apply(
      {
        requestId,
        answerDigest: p.answered.answerDigest,
        expectedVersion: target.version,
        contextDigest: context.contextDigest,
        targetDigest: target.targetDigest!,
      },
      'lead',
    );
    await f.scheduler.drain();
    assert.equal(f.service.show({ requestId }).state, 'delivered');
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
  } finally {
    await f.cleanup();
  }
});

test('Autonomous threshold 11: a critical writer decision becomes a follow-up; host.next tells the lead to close it', async () => {
  const runtimes = controlled({ assume: true });
  const f = await inputFixture(runtimes, {
    edit: (raw) => (raw.inputPolicy = { threshold: 11 }),
  });
  try {
    const board = f.h.createBoard('Autonomous board');
    const taskId = f.plainTask(board.id, 'Autonomous task');
    f.h.approve(board.id);
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
    const [followUp] = f.service.list({ taskId }).requests;
    assert.equal(followUp.kind, 'follow-up');
    assert.equal(followUp.blocking, false);
    const next = devcontourHandoff(f.h, {}).host.next;
    assert.equal(next?.action, 'close-follow-up', JSON.stringify(next));
    assert.match(next.detail, /input_cancel/);
    // Задача follow-up обычно уже дала результат: изменение требований — корректировка доски.
    assert.match(next.detail, /board_correct.*input_supersede with the replacement task/);
    // Демо выполнило и свои задачи: follow-up есть у каждой. Ведущий
    // закрывает их сам — решение принято.
    const open = f.service
      .list()
      .requests.filter((r) => r.kind === 'follow-up' && r.state === 'awaiting-answer');
    assert.ok(open.some((r) => r.requestId === next?.input?.requestId));
    for (const r of open)
      assert.equal(
        f.service.cancel(
          { requestId: r.requestId, expectedVersion: r.version, reason: 'assumption accepted' },
          'lead',
        ).lifecycle,
        'cancelled',
      );
    assert.notEqual(devcontourHandoff(f.h, {}).host.next?.action, 'close-follow-up');
    void followUp;
  } finally {
    await f.cleanup();
  }
});

test('D03-L: a secret the writer repeats in its question is masked in show, list, handoff and the answer snapshot', async () => {
  const secret = 'fixture-input-secret-4f1c9a';
  process.env.INPUT_FIXTURE_SECRET = secret;
  const runtimes = controlled({ leak: 'FIXTURE_TOKEN' });
  const f = await inputFixture(runtimes, {
    edit: (raw) =>
      (raw.environment = {
        inherit: [],
        values: {},
        secrets: { FIXTURE_TOKEN: 'INPUT_FIXTURE_SECRET' },
      }),
  });
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [{ requestId }] = f.service.list({ taskId }).requests;
    const shown = f.service.show({ requestId });
    assert.match(shown.question.question, /token seen/, 'исполнитель пересказал значение');
    assert.equal(JSON.stringify(shown).includes(secret), false);
    assert.equal(JSON.stringify(f.service.list({ taskId })).includes(secret), false);
    assert.equal(JSON.stringify(devcontourHandoff(f.h, {})).includes(secret), false);
    f.service.answer(
      { requestId, text: 'Use JSON as now.', expectedVersion: shown.version },
      'operator',
    );
    const context = await f.service.context({ requestId });
    const { store } = executionOf(f.h);
    const snapshot = store.read((v) =>
      v.local('context-snapshots', '@workspace', context.contextDigest),
    );
    assert.ok(snapshot);
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal(JSON.stringify(f.store.allEvents()).includes(secret), false);
  } finally {
    delete process.env.INPUT_FIXTURE_SECRET;
    await f.cleanup();
  }
});

test('Operator mode: the board job waits for the answer (no lead loop runs), workflow_status says so, also after restart', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes, { approvalMode: 'operator' });
  try {
    const { boardId, taskId: a } = f.askingTask('Asking A');
    const b = f.plainTask(boardId, 'Independent B');
    f.plainTask(boardId, 'Dependent C', [a]);
    const job = new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    await untilQuestion(f, boardId);
    // Цикл ведущего в режиме оператора не работает: задание не тратит попыток.
    await new LeadRunner(f.h, f.root, runtimes).tick();
    assert.equal(f.store.read().tasks.find((t) => t.id === b)!.status, 'done');
    const [{ requestId }] = f.service.list({ taskId: a }).requests;
    // Стадия 0 в режиме оператора не согласует: задание ещё до выдачи, а
    // ожидание — у задач её доски (стадия ≥ 1). Ставим стадию выдачи явно.
    const status = () =>
      (
        new AgentService(f.h, f.root).execute({
          operation: 'workflow_status',
          input: job.owner ? { repositoryId: job.owner } : {},
        }) as { jobs: { key: string; status: string; waiting?: unknown }[] }
      ).jobs.find((j) => j.key === job.key)!;
    const workflow = new LeadWorkflow(f.h);
    assert.deepEqual(workflow.waitingOf({ kind: 'board', id: boardId, stage: 1 }), {
      kind: 'input',
      requestIds: [requestId],
    });
    assert.notEqual(status().status, 'failed');
    await reopened(f, runtimes);
    assert.deepEqual(new LeadWorkflow(f.h).waitingOf({ kind: 'board', id: boardId, stage: 2 }), {
      kind: 'input',
      requestIds: [requestId],
    });
    assert.notEqual(status().status, 'failed');
    assert.equal(f.store.read().runs.filter((r) => r.taskId === a).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('A repair stop for another failure class names that task, not the question; the independent task still finishes', async () => {
  const runtimes = controlled({ idleTitle: 'Idle' });
  const f = await inputFixture(runtimes, { edit: (raw) => (raw.repairBudget = 0) });
  try {
    const { boardId, taskId: a } = f.askingTask('Asking A');
    const b = f.plainTask(boardId, 'Independent B');
    const d = f.plainTask(boardId, 'Idle D');
    const job = new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await lead.tick();
    await lead.tick();
    await f.scheduler.drain();
    await lead.tick();
    await lead.tick();
    const status = (id: string) => f.store.read().tasks.find((t) => t.id === id)!.status;
    assert.equal(status(b), 'done');
    assert.equal(status(d), 'failed');
    assert.equal(f.store.read().tasks.find((t) => t.id === a)!.failureKind, 'needs-input');
    const saved = new LeadWorkflow(f.h).get(job.key, job.owner);
    assert.equal(saved.status, 'failed');
    assert.match(saved.error ?? '', new RegExp(d));
    assert.equal(new RegExp(a).test(saved.error ?? ''), false, saved.error);
    assert.equal(
      saved.history.some((e) => e.event === WAITING_INPUT),
      false,
    );
    assert.equal(f.store.read().runs.filter((r) => r.taskId === a).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('Carry end to end: reopen, a changed spec, supersede by the same task, the answer is carried into the new revision and delivered', async () => {
  const prompts: string[] = [];
  const runtimes = controlled({ prompts });
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [{ requestId }] = f.service.list({ taskId }).requests;
    const answered = f.service.answer(
      { requestId, text: 'Use JSON as now.', optionId: 'json', expectedVersion: 1 },
      'operator',
    );
    f.h.pause(true);
    f.h.reopen(taskId, 'Clarify the acceptance before the next attempt');
    const draft = f.store.read().tasks.find((t) => t.id === taskId)!;
    f.h.editTask(
      taskId,
      {
        title: draft.title,
        description: draft.description + ' The artifact is JSON.',
        role: draft.role,
        acceptance: draft.acceptance,
        dependsOn: draft.dependsOn,
      },
      specDigest(draft),
    );
    f.h.approve(boardId, [taskId]);
    // Постановка изменилась: продолжение остановки невозможно, выход назван.
    const first = await f.service.context({ requestId });
    const blocked = f.service.target({ requestId, contextDigest: first.contextDigest });
    assert.ok(
      blocked.problems.some((p) => /supersedeInput/.test(p)),
      JSON.stringify(blocked.problems),
    );
    const superseded = f.service.supersede(
      {
        requestId,
        expectedVersion: f.service.show({ requestId }).version,
        reason: 'The spec now names the format',
        successorTaskId: taskId,
      },
      'lead',
    );
    assert.equal(superseded.lifecycle, 'superseded');
    // Заменённый вопрос без переноса задачу не держит; очередь на паузе.
    const context = await f.service.context({ requestId });
    await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    assert.equal(target.mode, 'carry');
    assert.deepEqual(target.problems, []);
    const carried = f.service.apply(
      {
        requestId,
        answerDigest: answered.answerDigest,
        expectedVersion: target.version,
        contextDigest: context.contextDigest,
        targetDigest: target.targetDigest!,
      },
      'lead',
    );
    assert.equal(carried.mode, 'carry');
    assert.equal(carried.applied, true);
    assert.equal(
      f.store.read().tasks.find((t) => t.id === taskId)!.inputContext?.digest,
      context.contextDigest,
    );
    prompts.length = 0;
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
    const run = f.store.read().runs.findLast((r) => r.taskId === taskId)!;
    assert.equal(run.pinned?.contextDigest, context.contextDigest);
    assert.ok(
      prompts.some((p) => p.startsWith('writer:') && p.includes(`### input/${requestId}.md`)),
    );
    // Нового вопроса нет: исполнитель получил перенесённый ответ.
    assert.equal(f.service.list({ taskId }).requests.length, 1);
    assert.equal(f.service.show({ requestId }).state, 'delivered');
  } finally {
    await f.cleanup();
  }
});
