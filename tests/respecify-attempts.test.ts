// Счётчик попыток после возврата задачи и новой постановки (D47): новое
// утверждение изменённого основания один раз начинает счёт заново, прежние
// попытки остаются историей и записью журнала. Та же постановка, второй
// перезапуск, возврат из отмены человеком (D46) и исчерпанный счётчик
// его не меняют. Модели не вызываются: demo-исполнитель, «Idle»-задача
// отвечает «готово», ничего не изменив.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture } from './input-fixture.ts';
import { specDigest } from '../src/core/service.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { taskOwner } from '../src/core/sync-state.ts';
import { attemptHistory } from '../src/runner/agent-control.ts';

after(() => inputDemos.close());

async function failedOnce(maxAttempts?: number) {
  const f = await inputFixture(controlled({ idleTitle: 'Idle' }), {
    ...(maxAttempts
      ? { edit: (raw: Record<string, unknown>) => (raw.maxAttempts = maxAttempts) }
      : {}),
  });
  const boardId = f.h.createBoard('Respecify board').id;
  const taskId = f.plainTask(boardId, 'Idle task to respecify');
  f.h.approve(boardId);
  const task = () => f.store.read().tasks.find((t) => t.id === taskId)!;
  const drain = async () => {
    f.h.pause(false);
    await f.scheduler.drain();
    f.h.pause(true);
  };
  await drain();
  assert.equal(task().status, 'failed');
  assert.equal(task().attempt, 1);
  const respecify = (title: string) => {
    f.h.reopen(taskId, 'The failure shows the spec must change');
    f.h.editTask(
      taskId,
      {
        title,
        description: task().description,
        role: task().role,
        acceptance: task().acceptance,
        dependsOn: task().dependsOn,
      },
      specDigest(task()),
    );
    return f.h.approve(boardId, [taskId]);
  };
  return { f, boardId, taskId, task, respecify, drain };
}

type Fixture = Awaited<ReturnType<typeof failedOnce>>['f'];
const journaled = (f: Fixture, key: string, taskId: string) =>
  f.store.events().some((e) => JSON.stringify(e).includes(`"${key}":[{"taskId":"${taskId}"`));

test('F16: re-approving a changed spec after reopen restarts the attempt counter; the same spec keeps it', async () => {
  const { f, boardId, taskId, task, respecify, drain } = await failedOnce();
  try {
    assert.equal(f.h.config.maxAttempts > 1, true);
    // Та же постановка: возврат и новое утверждение счётчик не трогают.
    f.h.reopen(taskId, 'Re-approve the same spec once more');
    const same = f.h.approve(boardId, [taskId]);
    assert.equal('attemptsRestarted' in same, false);
    assert.equal('attemptsKept' in same, false);
    assert.equal(task().attempt, 1);
    // Изменённая постановка: попытки прежней к ней не относятся.
    const changed = respecify('Respecified task that writes the artifact');
    assert.deepEqual(changed.attemptsRestarted, [{ taskId, spent: 1 }]);
    assert.equal(task().attempt, 0);
    assert.equal(task().attemptRestarts, 1);
    assert.ok(journaled(f, 'attemptsRestarted', taskId), 'журнал хранит снятые попытки');
    await drain();
    assert.equal(task().status, 'done');
    // Нумерация попыток ведёт движок: после перезапуска — снова с 1.
    assert.deepEqual(
      f.store
        .read()
        .runs.filter((r) => r.taskId === taskId)
        .map((r) => [r.attempt, r.status]),
      [
        [1, 'failed'],
        [1, 'succeeded'],
      ],
    );
    // Принятая после перезапуска задача — не «с первой попытки»: метрика
    // считает только задачи без перезапуска.
    const owner = taskOwner(task());
    const local = f.store.read().tasks.filter((t) => !t.sharedCompletion && taskOwner(t) === owner);
    const finished = local.filter(
      (t) => ['done', 'failed', 'cancelled'].includes(t.status) && t.attempt > 0,
    );
    const firstTry = finished.filter(
      (t) => t.status === 'done' && t.attempt === 1 && t.id !== taskId,
    );
    assert.ok(finished.some((t) => t.id === taskId));
    assert.equal(
      workflowMetrics(f.h, owner).firstAttemptAcceptanceRate,
      firstTry.length / finished.length,
    );
  } finally {
    await f.cleanup();
  }
});

test('F16: a second respecification does not restart the counter again: one automatic restart per task', async () => {
  const { f, taskId, task, respecify, drain } = await failedOnce();
  try {
    assert.deepEqual(respecify('Idle task respecified once').attemptsRestarted, [
      { taskId, spent: 1 },
    ]);
    await drain();
    assert.equal(task().status, 'failed');
    assert.equal(task().attempt, 1);
    const again = respecify('Idle task respecified twice');
    assert.equal('attemptsRestarted' in again, false);
    assert.deepEqual(again.attemptsKept, [{ taskId, spent: 1, reason: 'restart-limit' }]);
    assert.equal(task().attempt, 1);
    assert.equal(task().attemptRestarts, 1);
    assert.ok(journaled(f, 'attemptsKept', taskId));
    // Ревьюер плана видит прежние попытки и использованный перезапуск.
    const shown = attemptHistory(f.store.read(), [task()], f.h.config.maxAttempts);
    assert.equal(shown.attemptHistory?.tasks[0].restartsUsed, 1);
    assert.deepEqual(
      shown.attemptHistory?.tasks[0].runs.map((r) => [r.attempt, r.status, r.failureKind]),
      [
        [1, 'failed', 'empty-result'],
        [1, 'failed', 'empty-result'],
      ],
    );
  } finally {
    await f.cleanup();
  }
});

test('F16: a contract-only change (rebind to a new revision) is a new basis and restarts the counter', async () => {
  const f = await inputFixture(controlled({ idleTitle: 'Idle' }));
  try {
    const boardId = f.h.createBoard('Contract board').id;
    const source = 'docs/contracts/artifact-format.md';
    const v1 = f.h.contract('Artifact format', 'Version one.', undefined, undefined, source);
    const taskId = f.h.addTask(boardId, {
      title: 'Idle task bound to a contract',
      description: 'An observable independent outcome of the demo.',
      role: f.store.read().tasks[0].role,
      acceptance: ['The artifact exists.'],
      contracts: [v1.id],
    }).id;
    f.h.approve(boardId);
    f.h.pause(false);
    await f.scheduler.drain();
    f.h.pause(true);
    const task = () => f.store.read().tasks.find((t) => t.id === taskId)!;
    assert.equal(task().attempt, 1);
    const spec = { title: task().title, description: task().description };
    const v2 = f.h.contract('Artifact format', 'Version two.', undefined, undefined, source);
    assert.deepEqual(f.h.rebind([taskId], [v1.id], v2.id), [taskId]);
    // Постановка та же, кроме контракта.
    assert.deepEqual({ title: task().title, description: task().description }, spec);
    const approved = f.h.approve(boardId, [taskId]);
    assert.deepEqual(approved.attemptsRestarted, [{ taskId, spent: 1 }]);
    assert.equal(task().attempt, 0);
  } finally {
    await f.cleanup();
  }
});

test('F16: reopening a task cancelled by a human keeps the counter (D46)', async () => {
  const { f, taskId, task, respecify } = await failedOnce();
  try {
    f.h.cancel(taskId, 'The operator stops this task');
    const reopened = f.h.reopen(taskId, 'The lead brings the task back with a new spec');
    assert.equal(reopened.humanCancel, true);
    assert.equal(task().restartBlocked, 'human-cancel');
    // respecify возвращает черновик ещё раз (повтор возврата безвреден).
    const approved = respecify('Respecified task after a human cancel');
    assert.equal('attemptsRestarted' in approved, false);
    assert.deepEqual(approved.attemptsKept, [{ taskId, spent: 1, reason: 'human-cancel' }]);
    assert.equal(task().attempt, 1);
  } finally {
    await f.cleanup();
  }
});

test('F16: an exhausted counter is not restarted by reopen and a new spec: the reset stays a human decision', async () => {
  const { f, taskId, task, respecify, drain } = await failedOnce(1);
  try {
    const changed = respecify('Respecified task that writes the artifact');
    assert.equal('attemptsRestarted' in changed, false);
    assert.deepEqual(changed.attemptsKept, [{ taskId, spent: 1, reason: 'exhausted' }]);
    assert.equal(task().attempt, 1);
    await drain();
    // Очередь исчерпанную задачу не выдаёт: нужен retry --reset человека.
    assert.equal(task().status, 'ready');
    assert.equal(f.store.read().runs.filter((r) => r.taskId === task().id).length, 1);
  } finally {
    await f.cleanup();
  }
});
