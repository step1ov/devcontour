// Замена вопроса исполнителя (B1, раунд 1): замена снимает блокировку, как
// отмена, поэтому подчиняется тому же праву (критический вопрос и режим
// оператора — только оператор) и не допускается, пока исходная остановка
// держится. Воспроизведение рецензента: input_supersede, затем task_retry.
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
  // Новее вопроса: задача той же доски, добавленная ведущим после вопроса.
  const newer = f.plainTask(boardId, 'Newer task of the same board');
  return { taskId, boardId, requestId: r.requestId, version: r.version, newer };
}

/** Ведущий пытается заменить вопрос и повторить задачу: задача остаётся в ожидании ответа. */
async function bypass(
  f: InputFixture,
  q: Awaited<ReturnType<typeof question>>,
  expected: string,
  options: { retry?: boolean } = {},
) {
  const agent = new AgentService(f.h, f.root);
  for (const successorTaskId of [q.taskId, q.newer]) {
    const input = {
      requestId: q.requestId,
      expectedVersion: q.version,
      reason: 'Replace the question',
      successorTaskId,
    };
    assert.equal(
      await codeOf(() => agent.execute({ operation: 'input_supersede', input })),
      expected,
      'агентская замена: ' + successorTaskId,
    );
    // CLI `--by host` — тоже ведущий.
    assert.equal(await codeOf(() => f.service.supersede(input, 'host')), expected, 'CLI host');
  }
  assert.equal(f.service.show({ requestId: q.requestId }).lifecycle, 'pending');
  if (options.retry === false) return;
  assert.equal(
    await codeOf(() => agent.execute({ operation: 'task_retry', input: { taskId: q.taskId } })),
    '409:INPUT_REQUIRED',
  );
  assert.equal(f.store.read().tasks.find((t) => t.id === q.taskId)!.status, 'failed');
}

test('Agent mode, critical question: the lead cannot supersede (same task or newer task) and task_retry stays refused', async () => {
  const f = await inputFixture(controlled({ critical: true }));
  try {
    const q = await question(f);
    assert.deepEqual(f.service.show({ requestId: q.requestId }).floors, ['declared']);
    await bypass(f, q, '403:OPERATOR_ANSWERS');
  } finally {
    await f.cleanup();
  }
});

test('Operator mode: the lead cannot supersede even a floor-free question; the operator cannot either while the stop holds', async () => {
  const f = await inputFixture(controlled(), { approvalMode: 'operator' });
  try {
    const q = await question(f);
    await bypass(f, q, '403:OPERATOR_ANSWERS');
    assert.equal(
      await codeOf(() =>
        f.service.supersede(
          {
            requestId: q.requestId,
            expectedVersion: q.version,
            reason: 'Replace',
            successorTaskId: q.taskId,
          },
          'operator',
        ),
      ),
      '409:SPEC_UNCHANGED',
    );
  } finally {
    await f.cleanup();
  }
});

test('Agent mode, floor-free question: supersede is refused while the spec is unchanged; after reopen and a new spec it works', async () => {
  const f = await inputFixture(controlled());
  try {
    const q = await question(f);
    await bypass(f, q, '409:SPEC_UNCHANGED');
    // Черновик без новой постановки — по-прежнему отказ: замена молча сняла
    // бы вопрос, а после того же утверждения ответ не перенести.
    f.h.pause(true);
    f.h.reopen(q.taskId, 'The question shows the spec must change');
    await bypass(f, q, '409:SPEC_UNCHANGED', { retry: false });
    // Новая постановка задачи — замена разрешена.
    const draft = f.store.read().tasks.find((t) => t.id === q.taskId)!;
    f.h.editTask(
      q.taskId,
      {
        title: draft.title,
        description: draft.description + ' The artifact is JSON.',
        role: draft.role,
        acceptance: draft.acceptance,
        dependsOn: draft.dependsOn,
      },
      (await import('../src/core/service.ts')).specDigest(draft),
    );
    f.h.approve(q.boardId, [q.taskId]);
    const closed = new AgentService(f.h, f.root).execute({
      operation: 'input_supersede',
      input: {
        requestId: q.requestId,
        expectedVersion: q.version,
        reason: 'The spec now names the format',
        successorTaskId: q.taskId,
      },
    });
    assert.equal(closed.lifecycle, 'superseded');
  } finally {
    await f.cleanup();
  }
});
