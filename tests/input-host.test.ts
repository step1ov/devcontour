// Порт продолжения после ответа (`ExecutionHost.input`) DevContour: какой
// снимок закрепляется, какие раунды ревью годятся, атомарность активации,
// загрузка закреплённого снимка и снимок получателя. Модели не вызываются.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessError, type InputTargetRequest } from 'devcontour-harness';
import {
  controlled,
  inputDemos,
  inputFixture,
  prepared,
  untilQuestion,
  type InputFixture,
} from './input-fixture.ts';
import { executionOf } from '../src/harness/execution.ts';
import { devcontourInputHost } from '../src/harness/input-host.ts';
import { receiverContext } from '../src/harness/host.ts';

after(() => inputDemos.close());

/** Задача остановлена вопросом; ответ сохранён, снимок построен и одобрен. */
async function answered(runtimes = controlled()) {
  const f = await inputFixture(runtimes);
  const { taskId, boardId } = f.askingTask();
  await untilQuestion(f, boardId);
  const [request] = f.service.list({ taskId }).requests;
  const p = await prepared(f, request.requestId);
  return { f, taskId, requestId: request.requestId, ...p };
}

const hostReview = (
  f: InputFixture,
  taskId: string,
  contextDigest: string | null,
  actor: 'agent' | 'operator',
  request: InputTargetRequest,
) => {
  const { store } = executionOf(f.h);
  const host = devcontourInputHost(f.h, store);
  return store.read((v) => host.review(v.work(taskId)!, contextDigest, actor, v, request));
};
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return error instanceof HarnessError ? error.code : String(error);
  }
};

test('contextDigestOf: nothing without an activated snapshot, the digest while the approval holds, nothing after respec', async () => {
  const { f, taskId, apply, context } = await answered();
  try {
    const { store } = executionOf(f.h);
    const host = devcontourInputHost(f.h, store);
    const pin = () => store.read((v) => host.contextDigestOf(v.work(taskId)!, v));
    assert.equal(pin(), undefined, 'без активации контекст живой из пакетов');
    f.service.apply(apply, 'lead');
    assert.equal(pin(), context.contextDigest);
    // Переутверждение (другой approvedDigest) — снимок к задаче больше не привязан.
    f.store.change('test.respec', (s) => {
      s.tasks.find((t) => t.id === taskId)!.approvedDigest = 'f'.repeat(64);
    });
    assert.equal(pin(), undefined);
  } finally {
    await f.cleanup();
  }
});

test('review refuses another snapshot, an older answer, a changed policy and a rejected round in agent mode; operator mode accepts a rejected round', async () => {
  const verdict = { approve: true };
  const {
    f,
    taskId,
    requestId,
    answered: first,
    context,
  } = await answered(controlled({ verdict }));
  try {
    const request = { id: requestId, answerDigest: first.answerDigest, mode: 'apply' as const };
    assert.equal(
      codeOf(() => hostReview(f, taskId, context.contextDigest, 'agent', request)),
      'ok',
    );
    assert.equal(
      codeOf(() => hostReview(f, taskId, 'e'.repeat(64), 'agent', request)),
      'APPROVAL_REQUIRED',
      'другой снимок',
    );
    assert.equal(
      codeOf(() =>
        hostReview(f, taskId, context.contextDigest, 'agent', {
          ...request,
          answerDigest: 'd'.repeat(64),
        }),
      ),
      'APPROVAL_REQUIRED',
      'другой ответ',
    );
    // Вторая версия ответа и отклонённый раунд.
    const show = f.service.show({ requestId });
    const second = f.service.answer(
      { requestId, text: 'Use JSON and pretty-print it.', expectedVersion: show.version },
      'operator',
    );
    const context2 = await f.service.context({ requestId });
    verdict.approve = false;
    await f.service.review({
      requestId,
      contextDigest: context2.contextDigest,
      authorRuntime: 'codex',
    });
    const request2 = { id: requestId, answerDigest: second.answerDigest, mode: 'apply' as const };
    assert.equal(
      codeOf(() => hostReview(f, taskId, context2.contextDigest, 'agent', request2)),
      'REVIEW_REJECTED',
    );
    assert.equal(
      codeOf(() => hostReview(f, taskId, context2.contextDigest, 'operator', request2)),
      'ok',
      'в режиме оператора решение — применение оператором',
    );
    // Прежний ответ — прежний раунд уже не последний: отказ.
    assert.equal(
      codeOf(() => hostReview(f, taskId, context.contextDigest, 'agent', request)),
      'APPROVAL_REQUIRED',
    );
    // Смена утверждаемой политики (команда gate) — раунд не годится.
    f.h.config = structuredClone(f.h.config);
    f.h.config.gates[0].command = [...f.h.config.gates[0].command, '--changed'];
    assert.equal(
      codeOf(() => hostReview(f, taskId, context2.contextDigest, 'operator', request2)),
      'APPROVAL_REQUIRED',
    );
  } finally {
    await f.cleanup();
  }
});

test('review refuses a round whose reviewer binding no longer matches', async () => {
  const { f, taskId, requestId, answered: first, context } = await answered();
  try {
    const request = { id: requestId, answerDigest: first.answerDigest, mode: 'apply' as const };
    // Раунд с другим назначением reviewer (как после смены модели в политике).
    const { store } = executionOf(f.h);
    const [entry] = store
      .read((v) => v.locals('reviews'))
      .filter((r) => r.value.subject === 'input-' + requestId);
    f.store.atomic(() =>
      f.store.saveLocal('reviews', undefined, entry.key, {
        ...entry.value,
        reviewerBinding: 'c'.repeat(64),
      }),
    );
    assert.equal(
      codeOf(() => hostReview(f, taskId, context.contextDigest, 'agent', request)),
      'APPROVAL_STALE',
    );
  } finally {
    await f.cleanup();
  }
});

test('activation and the applied request roll back together', async () => {
  const { f, taskId, requestId, apply } = await answered();
  try {
    const { store } = executionOf(f.h);
    assert.throws(
      () =>
        store.host('test.rollback', () => {
          f.service.apply(apply, 'lead');
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.inputContext, undefined);
    assert.equal(f.service.show({ requestId }).lifecycle, 'answered');
    assert.equal(f.store.read().tasks.find((t) => t.id === taskId)!.status, 'failed');
  } finally {
    await f.cleanup();
  }
});

test('receiverContext names the input snapshot of an answered task', async () => {
  const { f, taskId, apply, context } = await answered();
  try {
    f.service.apply(apply, 'lead');
    const { store } = executionOf(f.h);
    const receiver = await receiverContext(f.h, store, taskId);
    assert.equal(receiver.contextDigest, context.contextDigest);
  } finally {
    await f.cleanup();
  }
});

test('A pinned snapshot that is missing or altered holds only its task (needs-lead) before any writer call', async () => {
  const prompts: string[] = [];
  const { f, taskId, apply, context } = await answered(controlled({ prompts }));
  try {
    f.service.apply(apply, 'lead');
    const { store } = executionOf(f.h);
    const snapshot = store.read((v) =>
      v.local('context-snapshots', '@workspace', context.contextDigest),
    )!;
    f.store.atomic(() =>
      f.store.saveLocal('context-snapshots', undefined, context.contextDigest, {
        ...snapshot,
        missing: [{ id: 'ghost', reason: 'altered after review' }],
      }),
    );
    prompts.length = 0;
    await f.scheduler.drain();
    const task = f.store.read().tasks.find((t) => t.id === taskId)!;
    assert.equal(task.status, 'failed');
    assert.equal(task.failureKind, 'needs-lead');
    assert.match(task.failure ?? '', /не найден/);
    assert.equal(prompts.filter((p) => p.startsWith('writer:')).length, 0);
    assert.equal(f.store.read().paused, false, 'очередь не останавливается');
  } finally {
    await f.cleanup();
  }
});

test('R7-4: approving another task of the board leaves the answered stop and its target valid (order content, not graph)', async () => {
  const { f, taskId, requestId, apply, context } = await answered();
  try {
    const boardId = f.store
      .read()
      .boards.find((b) => b.revisions.some((r) => r.taskIds.includes(taskId)))!.id;
    const sibling = f.plainTask(boardId, 'Follow-up sibling');
    f.h.approve(boardId, [sibling]);
    // Граф доски сменился, постановка задачи вопроса — нет: остановка
    // держится, применение не требует замены вопроса (digest цели называет
    // новый граф — его предлагают заново).
    const target = f.service.target({ requestId, contextDigest: context.contextDigest });
    assert.deepEqual(target.problems, []);
    const applied = f.service.apply({ ...apply, targetDigest: target.targetDigest! }, 'lead');
    assert.equal(applied.applied, true);
  } finally {
    await f.cleanup();
  }
});
