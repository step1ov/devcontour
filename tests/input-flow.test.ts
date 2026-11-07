// Вопрос исполнителя (H02) в DevContour: wire-схема, demo-вопрос, ответ,
// снимок с ответом, ревью, применение и доставка — без вызова моделей.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { implementationOutputSchema } from 'devcontour-harness';
import { controlled, inputDemos, inputFixture, prepared, untilQuestion } from './input-fixture.ts';
import { fixture, input } from './helpers.ts';
import { blockers, readyTasks } from '../src/core/graph.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import {
  adapters,
  cliArguments,
  implementationResult,
  implementationSchema,
} from '../src/runner/adapters.ts';
import { InputService, inputHolds } from '../src/application/input.ts';
import { executionOf } from '../src/harness/execution.ts';

after(() => inputDemos.close());

test('The writer wire schema carries the harness question and assumptions exactly', () => {
  const ours = implementationSchema as unknown as typeof implementationOutputSchema;
  assert.deepEqual(ours.required, implementationOutputSchema.required);
  assert.deepEqual(
    Object.keys(ours.properties).sort(),
    Object.keys(implementationOutputSchema.properties).sort(),
  );
  assert.deepEqual(
    ours.properties.inputRequest,
    implementationOutputSchema.properties.inputRequest,
  );
  assert.deepEqual(ours.properties.assumptions, implementationOutputSchema.properties.assumptions);
  // CLI runtime получает именно эту схему.
  const request = {
    cwd: '/tmp/x',
    artifactDir: '/tmp/x',
    prompt: 'p',
    review: false,
    task: {} as never,
    signal: new AbortController().signal,
    timeoutMs: 1000,
  };
  const argv = cliArguments('claude', request, '/tmp/x/schema.json', '/tmp/x/result.json');
  assert.deepEqual(
    JSON.parse(argv[argv.indexOf('--json-schema') + 1]),
    JSON.parse(JSON.stringify(implementationSchema)),
  );
  // Разбор ответа хоста пропускает вопрос и решения к controller.
  const parsed = implementationResult.parse({
    completed: false,
    summary: 's',
    discoveries: [],
    inputRequest: { question: 'q' },
    assumptions: [{ question: 'a' }],
  });
  assert.deepEqual(parsed.inputRequest, { question: 'q' });
  assert.equal(parsed.assumptions?.length, 1);
});

test('The demo [demo:ask] writer is a marked fixture and stops the attempt with needs-input', async () => {
  const f = await inputFixture();
  try {
    const { taskId, boardId } = f.askingTask();
    f.h.approve(boardId);
    f.h.pause(false);
    await f.scheduler.drain();
    const task = f.store.read().tasks.find((t) => t.id === taskId)!;
    assert.equal(task.status, 'failed');
    assert.equal(task.failureKind, 'needs-input');
    const run = f.store.read().runs.findLast((r) => r.taskId === taskId)!;
    assert.deepEqual(run.inputPolicy, { threshold: 7, criticalPaths: [] });
    const { engine } = executionOf(f.h);
    const [request] = engine.inputRequests({ workId: taskId });
    assert.equal(request.lifecycle, 'pending');
    assert.equal(request.kind, 'question');
    assert.match(request.question.question, /^Demo fixture:/);
    // Повтора без ответа нет: задача держится вопросом.
    await f.scheduler.drain();
    assert.equal(f.store.read().runs.filter((r) => r.taskId === taskId).length, 1);
    // Fixture-маркер виден в журнале вызова: это не вопрос модели.
    const reply = await adapters.demo.execute({
      cwd: f.root,
      artifactDir: f.root,
      prompt: 'no answer yet',
      review: false,
      task,
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    assert.match(reply.log, /fixture/i);
    assert.deepEqual(reply.command, ['internal:demo-writer-ask']);
    // Ревью без задачи (ответ, план) у demo — детерминированное одобрение, не модель.
    const review = await adapters.demo.execute({
      cwd: f.root,
      artifactDir: f.root,
      prompt: 'review the answer',
      review: true,
      task: {} as typeof task,
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    assert.equal((review.data as { approved: boolean }).approved, true);
    assert.deepEqual(review.command, ['internal:demo-plan-review']);
  } finally {
    await f.cleanup();
  }
});

test('Answer → snapshot → review → target → apply: the next attempt pins the snapshot and the answer is delivered', async () => {
  const f = await inputFixture();
  const prompts: string[] = [];
  const runtimes = controlled({ prompts });
  try {
    const { taskId, boardId } = f.askingTask();
    f.h.approve(boardId);
    f.h.pause(false);
    const scheduler = new Scheduler(f.h, f.root, runtimes);
    await scheduler.init();
    await scheduler.drain();
    const service = new InputService(f.h, f.root, runtimes);
    const [listed] = service.list({ taskId }).requests;
    assert.equal(listed.state, 'awaiting-answer');
    assert.equal(
      listed.actor,
      'lead',
      'вопрос без минимумов в режиме agent ведущий может ответить',
    );
    const answered = service.answer(
      {
        requestId: listed.requestId,
        text: 'Use JSON as now.',
        optionId: 'json',
        expectedVersion: 1,
      },
      'operator',
    );
    assert.equal(answered.revision, 1);
    assert.equal(service.list({ taskId }).requests[0].state, 'answer-saved');
    const context = await service.context({ requestId: listed.requestId });
    // Повтор — тот же снимок.
    assert.equal(
      (await service.context({ requestId: listed.requestId })).contextDigest,
      context.contextDigest,
    );
    // Применение без ревью отказывает до активации.
    const early = service.target({
      requestId: listed.requestId,
      contextDigest: context.contextDigest,
    });
    assert.ok(
      early.problems.some((p) => /input_review/.test(p)),
      JSON.stringify(early.problems),
    );
    const review = await service.review({
      requestId: listed.requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    assert.equal(review.approved, true);
    assert.equal(service.list({ taskId }).requests[0].state, 'ready-to-apply');
    const target = service.target({
      requestId: listed.requestId,
      contextDigest: context.contextDigest,
    });
    assert.deepEqual(target.problems, []);
    const apply = {
      requestId: listed.requestId,
      answerDigest: answered.answerDigest,
      expectedVersion: target.version,
      contextDigest: context.contextDigest,
      targetDigest: target.targetDigest!,
    };
    const applied = service.apply(apply, 'lead');
    assert.equal(applied.applied, true);
    // Повтор применения — без второй попытки и без изменений.
    assert.equal(service.apply(apply, 'lead').changed, false);
    const task = f.store.read().tasks.find((t) => t.id === taskId)!;
    assert.equal(task.status, 'ready');
    assert.equal(task.inputContext?.digest, context.contextDigest);
    assert.equal(service.list({ taskId }).requests[0].state, 'applied-awaiting-claim');
    prompts.length = 0;
    await scheduler.drain();
    await scheduler.stop();
    const done = f.store.read().tasks.find((t) => t.id === taskId)!;
    assert.equal(done.status, 'done', done.failure);
    const run = f.store.read().runs.findLast((r) => r.taskId === taskId)!;
    assert.equal(run.pinned?.contextDigest, context.contextDigest);
    assert.equal(run.input?.requestId, listed.requestId);
    // Writer и оба reviewer видели файл ответа.
    const marker = `### input/${listed.requestId}.md`;
    assert.ok(prompts.filter((p) => p.startsWith('writer:')).every((p) => p.includes(marker)));
    const reviews = prompts.filter((p) => p.startsWith('review:'));
    assert.equal(reviews.length, 2);
    assert.ok(reviews.every((p) => p.includes(marker)));
    const [after] = service.list({ taskId }).requests;
    assert.equal(after.state, 'delivered');
    assert.equal(after.lifecycle, 'applied');
  } finally {
    await f.cleanup();
  }
});

test('reopen keeps the open question; after re-approval of the same spec the answer applies as usual', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes);
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [request] = f.service.list({ taskId }).requests;
    assert.deepEqual([...inputHolds(f.h)], [[taskId, request.requestId]]);
    const state = f.store.read();
    assert.deepEqual(
      blockers(
        state.tasks.find((t) => t.id === taskId)!,
        state,
        inputHolds(f.h),
      ),
      ['input:' + request.requestId],
    );
    f.h.pause(true);
    f.h.reopen(taskId, 'The question shows the spec needs a second look');
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'draft');
    // Вопрос не снят: снятый вопрос при той же постановке нельзя ни применить,
    // ни перенести (исходная остановка держится) — ответ был бы потерян.
    assert.equal(f.service.show({ requestId: request.requestId }).lifecycle, 'pending');
    f.h.approve(boardId, [taskId]);
    assert.equal(
      readyTasks(f.store.read(), inputHolds(f.h)).some((t) => t.id === taskId),
      false,
    );
    const p = await prepared(f, request.requestId, 'lead');
    assert.deepEqual(p.target.problems, []);
    assert.equal(f.service.apply(p.apply, 'lead').applied, true);
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
    assert.equal(f.service.show({ requestId: request.requestId }).state, 'delivered');
  } finally {
    await f.cleanup();
  }
});

test('readyTasks and blockers leave out a ready task held by a question', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board');
    const a = f.h.addTask(board.id, input('Held task')).id;
    const b = f.h.addTask(board.id, input('Free task')).id;
    f.h.approve(board.id);
    const state = f.store.read();
    const holds = new Map([[a, 'IR-' + '0'.repeat(24)]]);
    assert.deepEqual(
      readyTasks(state).map((t) => t.id),
      [a, b],
    );
    assert.deepEqual(
      readyTasks(state, holds).map((t) => t.id),
      [b],
    );
    assert.deepEqual(
      blockers(
        state.tasks.find((t) => t.id === a)!,
        state,
        holds,
      ),
      ['input:IR-' + '0'.repeat(24)],
    );
  } finally {
    f.cleanup();
  }
});
