// Снятие вопроса исполнителя отменой задачи (B2, раунд 2): отмена закрывает
// открытые вопросы, поэтому вопрос, который ведущий не вправе решить сам,
// отменой задачи снимает только оператор. Ведущий — `--by host` в CLI.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlled,
  inputDemos,
  inputFixture,
  untilQuestion,
  type InputFixture,
} from './input-fixture.ts';
import { AgentService } from '../src/application/agent.ts';

after(() => inputDemos.close());

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return `${e.status ?? '-'}:${e.code ?? '-'}`;
  }
};

async function question(f: InputFixture) {
  const { taskId, boardId } = f.askingTask();
  await untilQuestion(f, boardId);
  const [r] = f.service.list({ taskId }).requests;
  return { taskId, requestId: r.requestId };
}

/** Ведущий отменяет задачу и повторяет её: отказ, вопрос открыт, повтор отклонён. */
async function leadCannotRelease(f: InputFixture, q: Awaited<ReturnType<typeof question>>) {
  assert.equal(
    await codeOf(() => f.h.cancel(q.taskId, 'Release the task', 'host')),
    '403:OPERATOR_ANSWERS',
  );
  assert.equal(f.service.show({ requestId: q.requestId }).lifecycle, 'pending');
  assert.equal(f.store.read().tasks.find((t) => t.id === q.taskId)!.status, 'failed');
  assert.equal(
    await codeOf(() =>
      new AgentService(f.h, f.root).execute({
        operation: 'task_retry',
        input: { taskId: q.taskId },
      }),
    ),
    '409:INPUT_REQUIRED',
  );
}

test('Agent mode, critical question: the lead cannot cancel the task; the operator can', async () => {
  const f = await inputFixture(controlled({ critical: true }));
  try {
    const q = await question(f);
    await leadCannotRelease(f, q);
    f.h.cancel(q.taskId, 'Not needed any more', 'operator');
    assert.equal(f.store.read().tasks.find((t) => t.id === q.taskId)!.status, 'cancelled');
    assert.equal(f.service.show({ requestId: q.requestId }).lifecycle, 'cancelled');
  } finally {
    await f.cleanup();
  }
});

test('Operator mode: the lead cannot cancel the task held by a floor-free question; the operator can', async () => {
  const f = await inputFixture(controlled(), { approvalMode: 'operator' });
  try {
    const q = await question(f);
    await leadCannotRelease(f, q);
    f.h.cancel(q.taskId, 'Not needed any more', 'operator');
    assert.equal(f.service.show({ requestId: q.requestId }).lifecycle, 'cancelled');
  } finally {
    await f.cleanup();
  }
});

test('Agent mode, floor-free question: the lead may cancel the task', async () => {
  const f = await inputFixture(controlled());
  try {
    const q = await question(f);
    f.h.cancel(q.taskId, 'Superseded by another approach', 'host');
    assert.equal(f.store.read().tasks.find((t) => t.id === q.taskId)!.status, 'cancelled');
    assert.equal(f.service.show({ requestId: q.requestId }).lifecycle, 'cancelled');
  } finally {
    await f.cleanup();
  }
});
