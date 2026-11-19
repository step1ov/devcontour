// F87: остановка пакета, которую DevContour держит сам (доска отложена
// `board_park`, задание мёртвой доски закрыто `workflow_close`), не заслоняет
// следующую. Инвариант: если в центре внимания есть активная карточка
// оператора или ведущего с действием, `host.next` не пуст. Модели не
// вызываются: demo-исполнитель задаёт вопрос, reviewer ответа управляемый.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, type InputFixture } from './input-fixture.ts';
import { DEMO_ASK } from '../src/runner/adapters.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { AttentionService } from '../src/application/attention.ts';
import { AgentService } from '../src/application/agent.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { specDigest } from '../src/core/service.ts';
import { setPark } from '../src/core/board-hold.ts';

after(() => inputDemos.close());

const roleOf = (f: InputFixture) => f.store.read().tasks[0].role;

/** Доска с одним черновиком (решение о плане ведущего). */
function draftBoard(f: InputFixture, title: string) {
  const id = f.h.createBoard(title).id;
  f.h.addTask(id, {
    title: `${title} task`,
    description: 'An observable independent outcome of the demo.',
    role: roleOf(f),
    acceptance: ['The artifact exists.'],
  });
  return id;
}

/**
 * Вопрос исполнителя, исходная остановка которого больше не держится
 * (постановка задачи изменена после ответа): выход — замена вопроса
 * оператором, шаг `apply-moved` с `operatorAnswers`.
 */
async function movedQuestion(f: InputFixture) {
  const boardId = f.h.createBoard('Question board').id;
  const source = 'docs/contracts/artifact-format.md';
  const v1 = f.h.contract('Artifact format', 'Version one.', undefined, undefined, source);
  const taskId = f.h.addTask(boardId, {
    title: 'Task bound to a contract asks',
    description: `An observable outcome that needs a decision ${DEMO_ASK}.`,
    role: roleOf(f),
    acceptance: ['The artifact exists.'],
    contracts: [v1.id],
  }).id;
  f.h.approve(boardId);
  f.h.pause(false);
  await f.scheduler.drain();
  const [summary] = f.service.list({ taskId }).requests;
  f.service.answer(
    {
      requestId: summary.requestId,
      text: 'Use JSON; the contract wording is amended.',
      optionId: 'json',
      expectedVersion: summary.version,
    },
    'operator',
  );
  const v2 = f.h.contract('Artifact format', 'Version two.', undefined, undefined, source);
  assert.deepEqual(f.h.rebind([taskId], [v1.id], v2.id), [taskId]);
  const task = () => f.store.read().tasks.find((t) => t.id === taskId)!;
  f.h.editTask(
    taskId,
    {
      title: 'Task bound to a contract asks, respecified',
      description: task().description,
      role: task().role,
      acceptance: task().acceptance,
      dependsOn: task().dependsOn,
      contracts: task().contracts,
    },
    specDigest(task()),
  );
  f.h.approve(boardId, [taskId]);
  const shown = f.service.show({ requestId: summary.requestId });
  assert.equal(shown.moved, true);
  assert.equal(shown.actor, 'operator');
  return { boardId, taskId, requestId: summary.requestId };
}

const hostNext = (f: InputFixture, boardId?: string) =>
  devcontourHandoff(f.h, boardId ? { boardId } : {}).host.next;

const active = async (f: InputFixture) =>
  (await new AttentionService(f.store, f.h, { root: f.root }).active()).items;

/**
 * Инвариант F87: активная карточка оператора или ведущего с действием (не
 * только переход) — значит, `host.next` workspace не пуст.
 */
async function assertNextCoversAttention(f: InputFixture, label: string) {
  const acting = (await active(f)).filter(
    (i) =>
      (i.actor === 'operator' || i.actor === 'lead') &&
      i.actions.some((a) => a.kind !== 'navigate'),
  );
  assert.ok(acting.length, `${label}: сценарий без карточки с действием ничего не проверяет`);
  assert.ok(
    hostNext(f),
    `${label}: host.next пуст при карточках ${acting.map((i) => i.sourceKey).join(', ')}`,
  );
}

test('F87: отложенная доска с черновиками не заслоняет вопрос, который ждёт оператора — host.next называет apply-moved', async () => {
  const f = await inputFixture(controlled({ affects: ['contract', 'acceptance'] }));
  try {
    // Черновик создан раньше: пакет harness ставит его ревью плана первым.
    const parked = draftBoard(f, 'Debt board');
    const { boardId, requestId } = await movedQuestion(f);
    const handoff = devcontourHandoff(f.h, {});
    assert.equal(handoff.pack.next.code, 'APPROVAL_REQUIRED');
    assert.equal(handoff.host.next?.code, 'plan-unapproved');
    assert.equal(handoff.host.next?.boardId, parked);
    await assertNextCoversAttention(f, 'до отметки');
    const agent = new AgentService(f.h, f.root);
    agent.execute({
      operation: 'board_park',
      input: { boardId: parked, parked: true, reason: 'Owner: after the 0.2.0 release' },
    });
    const after = devcontourHandoff(f.h, {});
    // Пакет harness по-прежнему ставит отложенную доску первой.
    assert.equal(after.pack.next.code, 'APPROVAL_REQUIRED');
    const next = after.host.next;
    assert.ok(next, 'host.next не пуст после board_park');
    assert.equal(next.code, 'apply-moved');
    assert.equal(next.action, 'operator');
    assert.equal(next.boardId, boardId);
    assert.equal(next.input?.requestId, requestId);
    assert.equal(next.input?.actor, 'operator');
    assert.deepEqual(next.params, { operatorAnswers: true });
    const card = (await active(f)).find((i) => i.sourceKey === `input:${requestId}`);
    assert.equal(card?.actor, 'operator');
    assert.ok(card?.actions.some((a) => a.id === 'supersede'));
    await assertNextCoversAttention(f, 'после отметки');
    // Снятие отметки возвращает решение о плане первым.
    agent.execute({ operation: 'board_park', input: { boardId: parked, parked: false } });
    assert.equal(hostNext(f)?.code, 'plan-unapproved');
    assert.equal(hostNext(f)?.boardId, parked);
  } finally {
    await f.cleanup();
  }
});

test('F87: отложенная доска не заслоняет решение о плане другой доски', async () => {
  const f = await inputFixture(controlled({ affects: ['contract', 'acceptance'] }));
  try {
    f.h.pause(false);
    const parked = draftBoard(f, 'Debt board');
    const other = draftBoard(f, 'Real work');
    assert.equal(hostNext(f)?.boardId, parked);
    new AgentService(f.h, f.root).execute({
      operation: 'board_park',
      input: { boardId: parked, parked: true, reason: 'Owner: after the 0.2.0 release' },
    });
    const next = hostNext(f);
    assert.equal(next?.code, 'plan-unapproved');
    assert.equal(next?.boardId, other);
    await assertNextCoversAttention(f, 'две доски');
  } finally {
    await f.cleanup();
  }
});

test('F87: инвариант после workflow_close — закрытое задание мёртвой доски не оставляет host.next пустым при вопросе оператора', async () => {
  const f = await inputFixture(controlled({ affects: ['contract', 'acceptance'] }));
  try {
    // Мёртвая доска: выданная задача упала и отменена, задание упало (D46).
    const dead = f.h.createBoard('Dead board').id;
    const stopped = f.h.addTask(dead, {
      title: 'Fails its gate',
      description: 'An observable independent outcome of the demo.',
      role: roleOf(f),
      acceptance: ['The artifact exists.'],
    });
    f.h.approve(dead);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: dead, authorRuntime: 'codex', maxAttempts: 3 });
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, stopped.id);
    f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
    f.h.cancel(stopped.id, 'Replanned on another board', 'host');
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 4; i++) await runner.tick();
    await runner.stop();
    assert.equal(flow.get(job.key, job.owner).status, 'failed');
    f.h.pause(true);
    const { requestId } = await movedQuestion(f);
    assert.equal(hostNext(f, dead)?.code, 'job-cancelled-task');
    new AgentService(f.h, f.root).execute({
      operation: 'workflow_close',
      input: { boardId: dead, reason: 'Work was replanned on board B-next and accepted' },
    });
    assert.equal(hostNext(f, dead), undefined);
    const next = hostNext(f);
    assert.ok(next, 'host.next не пуст после workflow_close');
    assert.equal(next.input?.requestId, requestId);
    await assertNextCoversAttention(f, 'после закрытия');
  } finally {
    await f.cleanup();
  }
});

test('F87: отложенная доска с усечённым списком черновиков не прячет решение о плане другой доски', async () => {
  const f = await inputFixture(controlled({ affects: ['contract', 'acceptance'] }));
  try {
    f.h.pause(false);
    // Больше черновиков, чем пакет harness перечисляет в свёрнутой остановке.
    const parked = f.h.createBoard('Big debt board').id;
    for (let i = 0; i < 25; i++)
      f.h.addTask(parked, {
        title: `Debt task ${i}`,
        description: 'An observable independent outcome of the demo.',
        role: roleOf(f),
        acceptance: ['The artifact exists.'],
      });
    const other = draftBoard(f, 'Real work');
    new AgentService(f.h, f.root).execute({
      operation: 'board_park',
      input: { boardId: parked, parked: true, reason: 'Owner: after the 0.2.0 release' },
    });
    const next = hostNext(f);
    assert.equal(next?.code, 'plan-unapproved', JSON.stringify(next));
    assert.equal(next?.boardId, other);
  } finally {
    await f.cleanup();
  }
});

test('F87: в approvalMode operator отложенная доска не прячет шаг вопроса за общим шагом оператора', async () => {
  const f = await inputFixture(controlled({ affects: ['contract', 'acceptance'] }), {
    approvalMode: 'operator',
  });
  try {
    const parked = draftBoard(f, 'Debt board');
    const { requestId } = await movedQuestion(f);
    assert.equal(hostNext(f)?.code, 'operator');
    setPark(f.h, parked, { parked: true, reason: 'Owner: after the 0.2.0 release' }, 'operator');
    const next = hostNext(f);
    assert.equal(next?.code, 'apply-moved', JSON.stringify(next));
    assert.equal(next?.input?.requestId, requestId);
  } finally {
    await f.cleanup();
  }
});

test('F87: после пропущенной остановки пустая доска не вытесняет старт задания утверждённой доски', async () => {
  const f = await inputFixture(controlled({ affects: ['contract', 'acceptance'] }));
  try {
    f.h.pause(false);
    const parked = draftBoard(f, 'Debt board');
    f.h.createBoard('Empty board');
    const approved = draftBoard(f, 'Approved work');
    f.h.approve(approved);
    new AgentService(f.h, f.root).execute({
      operation: 'board_park',
      input: { boardId: parked, parked: true, reason: 'Owner: after the 0.2.0 release' },
    });
    const next = hostNext(f);
    assert.notEqual(next?.code, 'input-refused', JSON.stringify(next));
    assert.equal(next?.boardId, approved, JSON.stringify(next));
  } finally {
    await f.cleanup();
  }
});
