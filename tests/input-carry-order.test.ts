// Изменение требований через перенос ответа: порядок шагов и область роли.
// F14 — снимок, ревью и применение ответа в черновике устаревали при новом
// утверждении задачи, и цепочку проходили дважды: теперь до утверждения она
// отказывает с ясным шагом, после — проходит за один раз без `stale`.
// F15 — ответ, расширяющий область записи задачи за область роли, не доходит
// до попытки: правка задачи и перенос ответа отказывают с советом об
// отдельной задаче роли-владельца, а ревью ответа видит область роли.
// Модели не вызываются: demo-исполнитель и управляемый reviewer.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';

after(() => inputDemos.close());

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    return `${e.status ?? '-'}:${e.code ?? '-'}`;
  }
};

/** Роль задачи пишет только `deliverables`, роль qa — `apps/mobile`. */
const scoped = (raw: Record<string, unknown>) => {
  const roles = raw.roles as Record<string, Record<string, unknown>>;
  roles.architect.writePaths = ['deliverables'];
  roles.qa.writePaths = ['apps/mobile'];
};

/** Вопрос, ответ «изменение требований», возврат и новая постановка, замена той же задачей. */
async function respecified(
  f: Awaited<ReturnType<typeof inputFixture>>,
  options: {
    /** Новая постановка привязывает утверждённый контракт: утверждение закрепит его digest. */
    contract?: boolean;
    /** Задача с вопросом — единственная на доске: после возврата граф не выпущен. */
    alone?: boolean;
  } = {},
) {
  const text = 'Write the artifact as JSON.';
  // Доска выпущена и без задачи с вопросом: её соседняя задача утверждена.
  const board = f.h.createBoard('Input board').id;
  if (!options.alone) f.plainTask(board, 'Neighbour task of the board');
  const { taskId, boardId } = f.askingTask('Asking task', { boardId: board });
  await untilQuestion(f, boardId);
  const [{ requestId }] = f.service.list({ taskId }).requests;
  const answered = f.service.answer(
    { requestId, text, optionId: 'json', kind: 'requirement-change', expectedVersion: 1 },
    'operator',
  );
  assert.match(
    answered.nextStep,
    /input_supersede.*carry the answer while the task is a draft.*then approve/,
  );
  f.h.pause(true);
  f.h.reopen(taskId, 'The answer changes the requirements of the task');
  const draft = f.store.read().tasks.find((t) => t.id === taskId)!;
  f.h.editTask(
    taskId,
    {
      title: draft.title,
      description: draft.description + ' The artifact is JSON.',
      role: draft.role,
      acceptance: draft.acceptance,
      dependsOn: draft.dependsOn,
      ...(options.contract
        ? { contracts: [f.h.contract('Artifact format', 'The artifact is a JSON object.').id] }
        : {}),
    },
    specDigest(draft),
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
  assert.equal(superseded.carry, true);
  return { taskId, boardId, requestId, answered, superseded };
}

/** Перенос ответа: снимок, ревью, цель и применение. */
async function carry(
  f: Awaited<ReturnType<typeof inputFixture>>,
  requestId: string,
  answerDigest: string,
) {
  const context = await f.service.context({ requestId });
  const review = await f.service.review({
    requestId,
    contextDigest: context.contextDigest,
    authorRuntime: 'codex',
  });
  assert.equal(review.approved, true);
  const target = f.service.target({ requestId, contextDigest: context.contextDigest });
  assert.equal(target.mode, 'carry');
  assert.deepEqual(target.problems, []);
  const carried = f.service.apply(
    {
      requestId,
      answerDigest,
      expectedVersion: target.version,
      contextDigest: context.contextDigest,
      targetDigest: target.targetDigest!,
    },
    'lead',
  );
  assert.equal(carried.applied, true);
  return context.contextDigest;
}

const staleEvents = (f: Awaited<ReturnType<typeof inputFixture>>) =>
  f.store.events().filter((e) => JSON.stringify(e).includes('"input.stale"')).length;

for (const contract of [false, true])
  test(`F14: the answer carried into the draft survives the approval of that spec and is delivered in one pass${contract ? ' (contract-bound task)' : ''}`, async () => {
    const prompts: string[] = [];
    const f = await inputFixture(controlled({ prompts }), { edit: scoped });
    try {
      const { taskId, boardId, requestId, answered, superseded } = await respecified(f, {
        contract,
      });
      assert.match(superseded.nextStep ?? '', /^carry the answer while the task is a draft/);
      assert.match(
        f.service.show({ requestId }).next,
        /^carry the answer while the task is a draft/,
      );
      // Документированный порядок: перенос в черновике, затем утверждение.
      const contextDigest = await carry(f, requestId, answered.answerDigest);
      // F15: ревью ответа видит область записи роли.
      assert.ok(
        prompts.some(
          (p) =>
            p.startsWith('review:') &&
            p.includes('Write scope of the role architect') &&
            p.includes('deliverables'),
        ),
      );
      f.h.approve(boardId, [taskId]);
      const approved = f.store.read().tasks.find((t) => t.id === taskId)!;
      // У задачи с контрактом утверждение закрепляет его digest после
      // переноса: сверяется постановка черновика до закрепления.
      assert.equal(Object.keys(approved.contractDigests).length, contract ? 1 : 0);
      assert.equal(approved.inputContext?.approvedDigest, approved.approvedDigest);
      f.h.pause(false);
      await f.scheduler.drain();
      assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
      const run = f.store.read().runs.findLast((r) => r.taskId === taskId)!;
      assert.equal(run.pinned?.contextDigest, contextDigest);
      assert.equal(f.service.show({ requestId }).state, 'delivered');
      // Ни устаревшего применения, ни второго раунда ревью.
      assert.equal(staleEvents(f), 0);
      assert.equal(f.service.show({ requestId }).reviews.length, 1);
    } finally {
      await f.cleanup();
    }
  });

test('F14: a spec edited after the carry does not inherit the answer; a draft review does not cover another draft', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { taskId, boardId, requestId, answered } = await respecified(f);
    // Ревью одной редакции черновика не годится для применения к другой.
    const context = await f.service.context({ requestId });
    await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    const draft = () => f.store.read().tasks.find((t) => t.id === taskId)!;
    const edit = (suffix: string) =>
      f.h.editTask(
        taskId,
        {
          title: draft().title,
          description: draft().description + suffix,
          role: draft().role,
          acceptance: draft().acceptance,
          dependsOn: draft().dependsOn,
        },
        specDigest(draft()),
      );
    edit(' Pretty-printed.');
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    assert.equal(
      await codeOf(() =>
        f.service.apply(
          {
            requestId,
            answerDigest: answered.answerDigest,
            expectedVersion: target.version,
            contextDigest: context.contextDigest,
            targetDigest: target.targetDigest!,
          },
          'lead',
        ),
      ),
      '409:APPROVAL_REQUIRED',
    );
    // Перенос по текущей редакции, затем ещё одна правка: утверждается другая
    // постановка, и перенесённый ответ устаревает до выдачи.
    await carry(f, requestId, answered.answerDigest);
    edit(' Sorted keys.');
    f.h.approve(boardId, [taskId]);
    assert.equal(draft().inputContext?.approvedDigest, undefined);
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(staleEvents(f), 1);
    assert.equal(f.service.show({ requestId }).state, 'stale');
    assert.notEqual(draft().status, 'done');
  } finally {
    await f.cleanup();
  }
});

test('F15: a respecification that widens the write scope beyond the role is refused with a separate-task advice', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [{ requestId }] = f.service.list({ taskId }).requests;
    f.service.answer(
      {
        requestId,
        text: 'Also update the mobile snapshot.',
        optionId: 'json',
        kind: 'requirement-change',
        expectedVersion: 1,
      },
      'operator',
    );
    f.h.pause(true);
    f.h.reopen(taskId, 'The answer widens the scope of the task');
    const draft = f.store.read().tasks.find((t) => t.id === taskId)!;
    const spec = {
      title: draft.title,
      description: draft.description + ' Update the mobile snapshot.',
      role: draft.role,
      acceptance: draft.acceptance,
      dependsOn: draft.dependsOn,
      writePaths: ['deliverables', 'apps/mobile/src/feature.test.ts'],
    };
    // Правка задачи: путь другой роли — отказ с названной ролью-владельцем.
    assert.throws(
      () => f.h.editTask(taskId, spec, specDigest(draft)),
      (e: Error) =>
        /apps\/mobile\/src\/feature\.test\.ts вне области записи роли architect/.test(e.message) &&
        /отдельную задачу роли qa/.test(e.message),
    );
    // Новая задача — тоже.
    assert.throws(
      () => f.h.addTask(boardId, { ...spec, title: 'Another task beyond the role' }),
      /вне области записи роли architect/,
    );
    // Путь, записанный до правила (или до сужения роли), правка оставляет,
    // а перенос ответа его ловит: попытка ушла бы в отказ по области.
    f.h.config.roles.architect.writePaths = undefined;
    f.h.editTask(taskId, spec, specDigest(draft));
    f.h.config.roles.architect.writePaths = ['deliverables'];
    const edited = f.store.read().tasks.find((t) => t.id === taskId)!;
    f.h.editTask(
      taskId,
      { ...spec, description: spec.description + ' Keep the format.' },
      specDigest(edited),
    );
    f.service.supersede(
      {
        requestId,
        expectedVersion: f.service.show({ requestId }).version,
        reason: 'The spec now includes the mobile snapshot',
        successorTaskId: taskId,
      },
      'operator',
    );
    f.h.approve(boardId, [taskId]);
    assert.equal(await codeOf(() => f.service.context({ requestId })), '409:ROLE_SCOPE');
    // Ровно то, что увидел бы ведущий, у которого снимок уже был.
    f.h.config.roles.architect.writePaths = undefined;
    const context = await f.service.context({ requestId });
    f.h.config.roles.architect.writePaths = ['deliverables'];
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    assert.ok(
      target.problems.some((p) => /вне области записи роли architect.*роли qa/.test(p)),
      JSON.stringify(target.problems),
    );
    // Ревью и применение отказывают тем же кодом: ревью — до вызова модели,
    // применение — в своей транзакции.
    assert.equal(
      await codeOf(() =>
        f.service.review({
          requestId,
          contextDigest: context.contextDigest,
          authorRuntime: 'codex',
        }),
      ),
      '409:ROLE_SCOPE',
    );
    assert.equal(f.service.show({ requestId }).reviews.length, 0);
    assert.equal(
      await codeOf(() =>
        f.service.apply(
          {
            requestId,
            answerDigest: f.service.show({ requestId }).answers.at(-1)!.digest,
            expectedVersion: target.version,
            contextDigest: context.contextDigest,
            targetDigest: target.targetDigest ?? '0'.repeat(64),
          },
          'lead',
        ),
      ),
      '409:ROLE_SCOPE',
    );
  } finally {
    await f.cleanup();
  }
});

test('F15: paths inside the role scope are accepted, and plan import refuses a task path outside it', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const boardId = f.h.createBoard('Scope board').id;
    const base = {
      description: 'An observable independent outcome of the demo.',
      role: 'architect',
      acceptance: ['The artifact exists.'],
    };
    // Внутри области роли и шире неё (путь содержит область роли) — принято.
    const inside = f.h.addTask(boardId, {
      ...base,
      title: 'Task inside the role scope',
      writePaths: ['deliverables/catalog.json'],
    });
    assert.deepEqual(inside.writePaths, ['deliverables/catalog.json']);
    f.h.config.roles.architect.writePaths = ['deliverables/catalog'];
    const wider = f.h.addTask(boardId, {
      ...base,
      title: 'Task wider than the role scope',
      writePaths: ['deliverables'],
    });
    assert.deepEqual(wider.writePaths, ['deliverables']);
    f.h.config.roles.architect.writePaths = ['deliverables'];
    const plan = (writePaths: string[]) => ({
      title: 'Scope plan',
      description: 'A plan whose task names its write scope.',
      tasks: [
        { ...base, key: 'one', title: 'Planned task', dependsOn: [], contracts: [], writePaths },
      ],
    });
    assert.throws(
      () => f.h.importPlan(plan(['deliverables', 'apps/mobile/src/feature.ts'])),
      (e: Error) =>
        /Задача плана one: пути apps\/mobile\/src\/feature\.ts вне области записи роли architect/.test(
          e.message,
        ) && /роли qa/.test(e.message),
    );
    assert.equal(f.h.importPlan(plan(['deliverables/plan.json'])).tasks, 1);
  } finally {
    await f.cleanup();
  }
});

test('F14: a single-task board has no basis in the draft: the hints name pause, approve, carry, and that order delivers', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { taskId, boardId, requestId, answered, superseded } = await respecified(f, {
      alone: true,
    });
    const order =
      /^the board of the task has no approved task yet.*pause the queue.*approve the task.*carry the answer.*lift the pause/;
    assert.match(superseded.nextStep ?? '', order);
    assert.match(f.service.show({ requestId }).next, order);
    const context = await f.service.context({ requestId });
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    assert.equal(target.targetDigest, null);
    assert.match(target.problems[0], /ещё не выпущена.*Поставьте очередь на паузу/);
    assert.equal(
      await codeOf(() =>
        f.service.apply(
          {
            requestId,
            answerDigest: answered.answerDigest,
            expectedVersion: target.version,
            contextDigest: context.contextDigest,
            targetDigest: '0'.repeat(64),
          },
          'lead',
        ),
      ),
      '409:NOT_READY',
    );
    // Названный порядок: очередь на паузе (её поставил respecified),
    // утверждение, перенос, снятие паузы.
    f.h.approve(boardId, [taskId]);
    assert.match(f.service.show({ requestId }).next, /^carry the answer now/);
    await carry(f, requestId, answered.answerDigest);
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
    assert.equal(f.service.show({ requestId }).state, 'delivered');
    assert.equal(staleEvents(f), 0);
  } finally {
    await f.cleanup();
  }
});

test('F14: host.next names the answer waiting to be carried, in the order of the board, until it is carried', async () => {
  for (const alone of [false, true]) {
    const f = await inputFixture(controlled(), { edit: scoped });
    try {
      const { taskId, boardId, requestId, answered } = await respecified(f, { alone });
      // Заменённый вопрос выдачу не держит, и пакет harness его не называет:
      // без шага ведущий видел бы утверждение плана или паузу.
      const next = (input = {}) => devcontourHandoff(f.h, input).host.next;
      const expectCarry = (order: string, input = {}) => {
        const step = next(input);
        assert.equal(step?.action, 'apply-input', JSON.stringify(step));
        assert.equal(step.code, 'apply-carry');
        assert.deepEqual(step.params, { order });
        assert.deepEqual(step.input, { requestId, taskId, state: 'superseded', actor: 'lead' });
        assert.equal(step.boardId, boardId);
        assert.ok(step.detail.includes(requestId), step.detail);
      };
      expectCarry(alone ? 'unreleased' : 'draft');
      if (!alone) expectCarry('draft', { boardId });
      if (alone) {
        // Названный порядок: утверждение под паузой, затем перенос сразу.
        f.h.approve(boardId, [taskId]);
        expectCarry('now');
        expectCarry('now', { boardId });
      }
      // Пакет другой доски переноса этой не называет.
      const other = f.h.createBoard('Other board').id;
      f.plainTask(other, 'Task of another board');
      f.h.approve(other);
      assert.notEqual(next({ boardId: other })?.code, 'apply-carry');
      await carry(f, requestId, answered.answerDigest);
      assert.notEqual(next()?.code, 'apply-carry', JSON.stringify(next()));
    } finally {
      await f.cleanup();
    }
  }
});

test('F14: host.next drops a carry the engine would refuse: the task was cancelled after the supersede', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { taskId, requestId } = await respecified(f);
    const next = (input = {}) => devcontourHandoff(f.h, input).host.next;
    assert.equal(next()?.code, 'apply-carry');
    f.h.cancel(taskId, 'The respecified task is not needed');
    // Переносить некуда: шаг не держит пакет, и шаг другой доски виден.
    assert.notEqual(next()?.code, 'apply-carry', JSON.stringify(next()));
    const other = f.h.createBoard('Other board').id;
    f.plainTask(other, 'Task of another board');
    f.h.approve(other);
    const own = next({ boardId: other });
    assert.ok(own, 'у другой доски есть шаг');
    assert.notEqual(next()?.code, 'apply-carry');
    assert.equal(next()?.code, own.code);
    // Запрос остаётся заменённым: отметка переноса — лишь запись момента замены.
    assert.equal(f.service.show({ requestId }).state, 'superseded');
  } finally {
    await f.cleanup();
  }
});

/** Вторая соседняя задача доски утверждена, очередь идёт, её попытка выдана. */
function runningNeighbour(f: Awaited<ReturnType<typeof inputFixture>>, boardId: string) {
  const neighbour = f.h.addTask(boardId, {
    title: 'Second neighbour task',
    description: 'An observable independent outcome of the demo.',
    role: 'architect',
    acceptance: ['The artifact exists.'],
  }).id;
  f.h.approve(boardId, [neighbour]);
  f.h.pause(false);
  // Выдача — от контура, который ведёт очередь, без её выполнения.
  const run = f.h.claim(f.scheduler.owner)!;
  assert.ok(run);
  return { neighbour, run };
}

test('F14: while attempts run on the board, host.next waits with the carry instead of asking to carry now', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { taskId, boardId, requestId } = await respecified(f);
    // Попытка соседней задачи той же доски: движок откажет в переносе до её конца.
    const { neighbour, run } = runningNeighbour(f, boardId);
    assert.equal(run.taskId, neighbour);
    // Черновик очередь не выдаст: паузы не нужно, только ожидание.
    const waiting = devcontourHandoff(f.h, {}).host.next;
    assert.equal(waiting?.action, 'wait', JSON.stringify(waiting));
    assert.equal(waiting.code, 'apply-carry');
    assert.deepEqual(waiting.params, { order: 'draft', active: [run.id] });
    assert.deepEqual(waiting.input, { requestId, taskId, state: 'superseded', actor: 'lead' });
    assert.match(waiting.detail, new RegExp(`Wait: attempts run on the board.*${run.id}`));
    // Попытка закончилась — снова перенос.
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    const carry = devcontourHandoff(f.h, {}).host.next;
    assert.equal(carry?.action, 'apply-input', JSON.stringify(carry));
    assert.deepEqual(carry.params, { order: 'draft' });
  } finally {
    await f.cleanup();
  }
});

test('F14: an approved task waiting for the carry while the queue runs: pause first, then wait, then carry', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { taskId, boardId } = await respecified(f);
    // Задачу утвердили до переноса: перенос — сразу, но в графе идёт попытка.
    f.h.approve(boardId, [taskId]);
    const { run } = runningNeighbour(f, boardId);
    const next = () => devcontourHandoff(f.h, {}).host.next;
    const pause = next();
    assert.equal(pause?.action, 'queue_set', JSON.stringify(pause));
    assert.equal(pause.code, 'apply-carry');
    assert.deepEqual(pause.params, { order: 'now', active: [run.id], pause: true });
    assert.match(pause.detail, /First pause the queue yourself \(queue_set \{"paused": true\};/);
    f.h.pause(true);
    const waiting = next();
    assert.equal(waiting?.action, 'wait', JSON.stringify(waiting));
    assert.deepEqual(waiting.params, { order: 'now', active: [run.id] });
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    const carry = next();
    assert.equal(carry?.action, 'apply-input', JSON.stringify(carry));
    assert.deepEqual(carry.params, { order: 'now' });
  } finally {
    await f.cleanup();
  }
});

test('F14: in the workspace pack a waiting carry stands in for the plan decision of its own board', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { boardId } = await respecified(f);
    runningNeighbour(f, boardId);
    // Другая доска утверждена, задания нет: её пакет называет старт задания.
    const other = f.h.createBoard('Other board').id;
    f.plainTask(other, 'Task of another board');
    f.h.approve(other);
    const own = devcontourHandoff(f.h, { boardId: other }).host.next;
    assert.equal(own?.action, 'workflow_start', JSON.stringify(own));
    // Пакет workspace выбирает шаг по доске первой работы пакета (здесь —
    // доска с черновиком): ожидание переноса стоит вместо её решения о плане.
    const next = devcontourHandoff(f.h, {}).host.next;
    assert.equal(next?.code, 'apply-carry', JSON.stringify(next));
    assert.equal(next.boardId, boardId);
  } finally {
    await f.cleanup();
  }
});

test('F14: on the plan path a waiting carry does not hide the failed job of another board', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { boardId } = await respecified(f);
    runningNeighbour(f, boardId);
    // Упавшее задание другой доски: повтор продвинет его.
    const other = f.h.createBoard('Board with a failed job').id;
    f.plainTask(other, 'Task of the failed job');
    f.h.approve(other);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: other, authorRuntime: 'codex', maxAttempts: 3 });
    flow.fail(flow.claim(job.key, job.owner)!, 'plan review runtime unavailable');
    const next = devcontourHandoff(f.h, {}).host.next;
    assert.equal(next?.action, 'workflow_retry', JSON.stringify(next));
    assert.equal(next.boardId, other);
    // Пакет доски переноса по-прежнему называет ожидание переноса.
    assert.equal(devcontourHandoff(f.h, { boardId }).host.next?.code, 'apply-carry');
  } finally {
    await f.cleanup();
  }
});

test('F14: under a pause the job loop lifts, a carry into an approved task still asks for the lead pause', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { taskId, boardId } = await respecified(f);
    f.h.approve(boardId, [taskId]);
    const { run } = runningNeighbour(f, boardId);
    // Начальная пауза (без причины), которую снимет задание доски: она
    // задачу не удержит.
    f.store.change('fixture', (s) => {
      s.paused = true;
      s.pauseReason = undefined;
      return {};
    });
    new LeadWorkflow(f.h).start({
      kind: 'board',
      id: boardId,
      authorRuntime: 'codex',
      maxAttempts: 3,
    });
    const pause = devcontourHandoff(f.h, {}).host.next;
    assert.equal(pause?.action, 'queue_set', JSON.stringify(pause));
    assert.deepEqual(pause.params, { order: 'now', active: [run.id], pause: true });
    // Пауза ведущего после старта задания: её цикл не снимет — ожидание.
    f.h.pause(true);
    const waiting = devcontourHandoff(f.h, {}).host.next;
    assert.equal(waiting?.action, 'wait', JSON.stringify(waiting));
    assert.deepEqual(waiting.params, { order: 'now', active: [run.id] });
  } finally {
    await f.cleanup();
  }
});

test('F14: apply-carry yields to a question waiting for an answer and is absent in approvalMode operator', async () => {
  const f = await inputFixture(controlled(), { edit: scoped });
  try {
    const { requestId } = await respecified(f, { alone: true });
    const operator = new DevContour(f.store, { ...f.h.config, approvalMode: 'operator' });
    // Режим оператора: переносит оператор в панели, у ведущего шага переноса нет.
    assert.notEqual(devcontourHandoff(operator, {}).host.next?.code, 'apply-carry');
    assert.equal(devcontourHandoff(f.h, {}).host.next?.code, 'apply-carry');
    // Блокирующий вопрос другой доски, ждущий ответа, — срочнее переноса.
    const asking = f.askingTask('Another asking task');
    await untilQuestion(f, asking.boardId);
    const next = devcontourHandoff(f.h, {}).host.next;
    assert.equal(next?.action, 'answer-input', JSON.stringify(next));
    assert.equal(next.input?.taskId, asking.taskId);
    assert.notEqual(next.input?.requestId, requestId);
  } finally {
    await f.cleanup();
  }
});
