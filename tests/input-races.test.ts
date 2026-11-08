// Ответ на вопрос исполнителя рядом с другими решениями: одновременная отмена
// или применение дают один допустимый исход, а пауза оператора и исчерпанный
// бюджет ответом не снимаются. Модели не вызываются: demo-исполнитель и
// управляемый reviewer ответа.
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
import { executionOf } from '../src/harness/execution.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { InputService } from '../src/application/input.ts';
import type { AgentAdapter } from '../src/runner/adapters.ts';

after(() => inputDemos.close());

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return `${e.status ?? '-'}:${e.code ?? '-'}`;
  }
};

async function question(f: InputFixture, title?: string) {
  const { taskId, boardId } = f.askingTask(title);
  await untilQuestion(f, boardId);
  const [request] = f.service.list({ taskId }).requests;
  return { taskId, boardId, requestId: request.requestId, version: request.version };
}

const runsOf = (f: InputFixture, taskId: string) =>
  f.store.read().runs.filter((r) => r.taskId === taskId);
const writerCalls = (prompts: string[]) => prompts.filter((p) => p.startsWith('writer:')).length;

// Предел бюджета ниже уже записанного расхода: бюджет исчерпан.
function exhaustBudget(f: InputFixture) {
  f.h.config.budgets = { workspace: { usd: 0.01 }, onUnknown: 'stop' };
  f.store.atomic(() =>
    f.store.saveLocal('usage', undefined, 'U-budget', {
      id: 'U-budget',
      stage: 'implementation',
      runtime: 'codex',
      model: 'fixture-model',
      runtimeVersion: null,
      startedAt: new Date().toISOString(),
      outcome: 'returned',
      promptBytes: 1,
      promptDigest: 'd'.repeat(64),
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedUsd: 1,
        complete: true,
        source: 'fixture',
      },
      costUsd: 1,
      costSource: 'provider-reported',
    }),
  );
}

test('R01: answer and cancel on the same version — the first wins, the second is a conflict, nothing resumes', async () => {
  const f = await inputFixture(controlled());
  try {
    // Ответ первым: отмена с показанной версией — конфликт, вопрос отвечен.
    const a = await question(f, 'Answer first');
    f.service.answer(
      { requestId: a.requestId, text: 'Use JSON as now.', expectedVersion: a.version },
      'operator',
    );
    assert.match(
      await codeOf(() =>
        f.service.cancel(
          { requestId: a.requestId, expectedVersion: a.version, reason: 'Not needed any more' },
          'operator',
        ),
      ),
      /^409:/,
    );
    assert.equal(f.service.show({ requestId: a.requestId }).lifecycle, 'answered');
    // Отмена первой: ответ с показанной версией — конфликт, ответа нет.
    const b = await question(f, 'Cancel first');
    f.service.cancel(
      { requestId: b.requestId, expectedVersion: b.version, reason: 'Not needed any more' },
      'operator',
    );
    assert.match(
      await codeOf(() =>
        f.service.answer(
          { requestId: b.requestId, text: 'Use JSON as now.', expectedVersion: b.version },
          'operator',
        ),
      ),
      /^409:/,
    );
    const cancelled = f.service.show({ requestId: b.requestId });
    assert.equal(cancelled.lifecycle, 'cancelled');
    assert.equal(cancelled.answers.length, 0);
    // Ни отвеченный без применения, ни снятый вопрос не дают новой попытки.
    const before = [runsOf(f, a.taskId).length, runsOf(f, b.taskId).length];
    await f.scheduler.drain();
    assert.deepEqual([runsOf(f, a.taskId).length, runsOf(f, b.taskId).length], before);
  } finally {
    await f.cleanup();
  }
});

test('R01: cancel between target and apply — apply is refused and no attempt receives the answer', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, requestId } = await question(f);
    const ready = await prepared(f, requestId);
    f.service.cancel(
      { requestId, expectedVersion: ready.apply.expectedVersion, reason: 'Decided otherwise' },
      'operator',
    );
    assert.match(await codeOf(() => f.service.apply(ready.apply, 'lead')), /^409:/);
    const runs = runsOf(f, taskId).length;
    await f.scheduler.drain();
    // Снятый вопрос не возобновляет задачу сам; ответ ни в какую попытку не ушёл.
    assert.equal(runsOf(f, taskId).length, runs);
    const shown = f.service.show({ requestId });
    assert.equal(shown.lifecycle, 'cancelled');
    for (const run of runsOf(f, taskId)) assert.equal(run.pinned?.contextDigest, undefined);
  } finally {
    await f.cleanup();
  }
});

test('R01: apply first — a cancel with the version seen before apply is a conflict; the answer reaches exactly one new attempt', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, requestId } = await question(f);
    const ready = await prepared(f, requestId);
    f.service.apply(ready.apply, 'lead');
    assert.match(
      await codeOf(() =>
        f.service.cancel(
          { requestId, expectedVersion: ready.apply.expectedVersion, reason: 'Too late' },
          'operator',
        ),
      ),
      /^409:/,
    );
    await f.scheduler.drain();
    const runs = runsOf(f, taskId);
    assert.equal(runs.length, 2, 'попытка вопроса и одна попытка с ответом');
    assert.equal(runs[1].pinned?.contextDigest, ready.context.contextDigest);
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'done');
  } finally {
    await f.cleanup();
  }
});

test('R01: an operator pause is not lifted by an answer and its apply; no writer runs until the operator resumes', async () => {
  const prompts: string[] = [];
  const f = await inputFixture(controlled({ prompts }));
  try {
    const { taskId, requestId } = await question(f);
    const writers = writerCalls(prompts);
    f.h.pause(true);
    const ready = await prepared(f, requestId);
    f.service.apply(ready.apply, 'lead');
    assert.equal(f.store.read().paused, true, 'ответ и применение не снимают паузу');
    const runs = runsOf(f, taskId).length;
    await f.scheduler.drain();
    assert.equal(runsOf(f, taskId).length, runs);
    assert.equal(writerCalls(prompts), writers, 'исполнитель не запускался');
    // Пауза — единственное, что держало задачу: оператор снимает её сам.
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(runsOf(f, taskId).length, runs + 1);
    assert.equal(writerCalls(prompts), writers + 1);
  } finally {
    await f.cleanup();
  }
});

test('R01: an exhausted budget is not lifted by an answer; the task stays blocked and no writer runs', async () => {
  const prompts: string[] = [];
  const f = await inputFixture(controlled({ prompts }));
  try {
    const { taskId, requestId, version } = await question(f);
    const writers = writerCalls(prompts);
    exhaustBudget(f);
    // Движок читается заново: правка конфигурации даёт движок с новой политикой.
    const blocked = () => {
      const { engine } = executionOf(f.h);
      return engine.read((v) => engine.budgetBlockOf(taskId, v));
    };
    const reason = blocked();
    assert.ok(reason, 'бюджет исчерпан до ответа');
    const reviews = () => prompts.filter((p) => p.startsWith('review:')).length;
    const reviewed = reviews();
    f.service.answer(
      { requestId, text: 'Use JSON as now.', optionId: 'json', expectedVersion: version },
      'operator',
    );
    assert.equal(blocked(), reason, 'ответ не снимает блокировку бюджета');
    // Ревью ответа — вызов модели: при исчерпанном бюджете оно отклоняется до вызова.
    const context = await f.service.context({ requestId });
    assert.equal(
      await codeOf(() =>
        f.service.review({
          requestId,
          contextDigest: context.contextDigest,
          authorRuntime: 'codex',
        }),
      ),
      '409:BUDGET_EXHAUSTED',
    );
    assert.equal(reviews(), reviewed, 'reviewer не вызывался');
    const runs = runsOf(f, taskId).length;
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(runsOf(f, taskId).length, runs);
    assert.equal(writerCalls(prompts), writers, 'исполнитель не запускался');
    assert.equal(f.service.show({ requestId }).lifecycle, 'answered');
    // Предел поднят решением оператора — тогда ответ проходит обычный путь.
    f.h.config.budgets = { workspace: { usd: 5 }, onUnknown: 'continue' };
    assert.equal(blocked(), undefined);
    const ready = await prepared(f, requestId);
    f.service.apply(ready.apply, 'lead');
    await f.scheduler.drain();
    assert.equal(runsOf(f, taskId).length, runs + 1);
    assert.equal(writerCalls(prompts), writers + 1);
  } finally {
    await f.cleanup();
  }
});

test('R01: an answer reviewed before the budget ran out is refused at apply while the budget is exhausted; no writer runs until the limit is raised', async () => {
  const prompts: string[] = [];
  const f = await inputFixture(controlled({ prompts }));
  try {
    const { taskId, requestId } = await question(f);
    const writers = writerCalls(prompts);
    // Ответ отвечен и одобрен, пока бюджет ещё есть.
    const ready = await prepared(f, requestId);
    assert.equal(ready.review.approved, true);
    exhaustBudget(f);
    const blocked = () => {
      const { engine } = executionOf(f.h);
      return engine.read((v) => engine.budgetBlockOf(taskId, v));
    };
    assert.ok(blocked(), 'бюджет исчерпан после ревью');
    // Применение отклоняется мягко: ответ не связан с попыткой, причина — бюджет.
    const refused = f.service.apply(ready.apply, 'lead');
    assert.equal(refused.applied, false, 'применение отклонено');
    assert.equal(refused.changed, false);
    assert.equal(refused.blocker?.code, 'BUDGET_EXHAUSTED');
    assert.equal(f.service.show({ requestId }).state, 'ready-to-apply');
    const runs = runsOf(f, taskId).length;
    f.h.pause(false);
    await f.scheduler.drain();
    assert.equal(runsOf(f, taskId).length, runs, 'новая попытка не добавлена');
    assert.equal(writerCalls(prompts), writers, 'исполнитель не запускался');
    assert.ok(blocked(), 'отказ не снимает блокировку бюджета');
    // Предел поднят оператором: тот же проверенный ответ применяется обычным
    // путём и уходит ровно в одну попытку.
    f.h.config.budgets = { workspace: { usd: 5 }, onUnknown: 'continue' };
    assert.equal(blocked(), undefined);
    const target = f.service.target({ requestId, contextDigest: ready.context.contextDigest });
    const applied = f.service.apply(
      { ...ready.apply, expectedVersion: target.version, targetDigest: target.targetDigest! },
      'lead',
    );
    assert.equal(applied.applied, true);
    await f.scheduler.drain();
    const after = runsOf(f, taskId);
    assert.equal(after.length, runs + 1);
    assert.equal(writerCalls(prompts), writers + 1);
    assert.equal(after.at(-1)!.pinned?.contextDigest, ready.context.contextDigest);
  } finally {
    await f.cleanup();
  }
});

test('R01: two concurrent answer reviews of one request — one reviewer call; the second is REVIEW_IN_PROGRESS, also from another process; an expired lease does not block', async () => {
  // Reviewer ответа держит первый вызов до сигнала теста и считает вызовы.
  let reviewerCalls = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const base = controlled();
  const gated = (adapter: AgentAdapter): AgentAdapter => ({
    ...adapter,
    execute: async (request) => {
      // Ревью ответа идёт без задачи; исполнитель и ревью попыток — мимо.
      if (request.review && !request.task?.id) {
        reviewerCalls++;
        await gate;
      }
      return adapter.execute(request);
    },
  });
  const runtimes = {
    ...base,
    demo: gated(base.demo),
    codex: gated(base.codex),
    claude: gated(base.claude),
  };
  const f = await inputFixture(runtimes);
  try {
    const { requestId, version } = await question(f);
    f.service.answer(
      { requestId, text: 'Use JSON as now.', optionId: 'json', expectedVersion: version },
      'operator',
    );
    const context = await f.service.context({ requestId });
    const raw = { requestId, contextDigest: context.contextDigest, authorRuntime: 'codex' };
    // Отказ второго вызова — сразу; без аренды он ждал бы reviewer.
    const settled = (p: Promise<unknown>) =>
      Promise.race([
        codeOf(() => p),
        new Promise((resolve) => setTimeout(() => resolve('still waiting for the reviewer'), 5000)),
      ]);
    const [first, second] = [f.service.review(raw), f.service.review(raw)];
    try {
      assert.equal(await settled(second), '409:REVIEW_IN_PROGRESS');
      // Другой процесс той же базы видит ту же аренду.
      const store = new Store(join(f.root, 'state.sqlite'));
      try {
        const other = new InputService(new DevContour(store, f.h.config), f.root, runtimes);
        assert.equal(await settled(other.review(raw)), '409:REVIEW_IN_PROGRESS');
      } finally {
        store.close();
      }
    } finally {
      open();
      await Promise.allSettled([second]);
    }
    const reviewed = await first;
    assert.equal(reviewed.approved, true);
    assert.equal(reviewerCalls, 1, 'один вызов reviewer на два одновременных ревью');
    // Аренда снята: повтор с тем же одобренным раундом модель не вызывает.
    assert.equal(f.store.localRecord('input-review-lease', undefined, requestId), undefined);
    assert.equal((await f.service.review(raw)).round, reviewed.round);
    assert.equal(reviewerCalls, 1);
    // Аренда упавшего процесса с истёкшим сроком ревью не задерживает.
    f.store.atomic(() =>
      f.store.saveLocal('input-review-lease', undefined, requestId, {
        token: 'crashed',
        startedAt: new Date(0).toISOString(),
        leaseUntil: Date.now() - 1,
      }),
    );
    assert.equal((await f.service.review(raw)).approved, true);
    assert.equal(f.store.localRecord('input-review-lease', undefined, requestId), undefined);
  } finally {
    await f.cleanup();
  }
});
