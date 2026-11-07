// Вопрос исполнителя (H02) в DevContour: wire-схема, demo-вопрос, ответ,
// снимок с ответом, ревью, применение и доставка — без вызова моделей.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { implementationOutputSchema } from 'devcontour-harness';
import { demoPool, testDemo } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import {
  DEMO_ASK,
  adapters,
  cliArguments,
  implementationResult,
  implementationSchema,
} from '../src/runner/adapters.ts';
import { executionOf } from '../src/harness/execution.ts';

const demos = demoPool(testDemo);
after(() => demos.close());

export async function inputFixture() {
  const seed = await demos.acquire();
  const root = seed.root;
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, loadConfig(join(root, 'config.json')));
  const scheduler = new Scheduler(h, root);
  await scheduler.init();
  const role = store.read().tasks[0].role;
  return {
    root,
    store,
    h,
    scheduler,
    /** Доска с задачей, demo-исполнитель которой спрашивает (`[demo:ask]`). */
    askingTask(title = 'Asking task') {
      const board = h.createBoard('Input board');
      const task = h.addTask(board.id, {
        title,
        description: `An observable outcome that needs a decision ${DEMO_ASK}.`,
        role,
        acceptance: ['The artifact exists.'],
      });
      h.approve(board.id);
      return { boardId: board.id, taskId: task.id };
    },
    cleanup: async () => {
      await scheduler.stop();
      store.close();
      seed.release();
    },
  };
}

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
    const { taskId } = f.askingTask();
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
  } finally {
    await f.cleanup();
  }
});
