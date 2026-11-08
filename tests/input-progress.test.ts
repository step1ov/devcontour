// Задача, остановленная вопросом исполнителя, — ожидание ответа, а не сбой:
// движок записывает остановку `needs-input` отказом (`failed`), но прогресс
// задачи (task_briefing, панель), её статус в панели и корень цепочки
// называют ожидание ответа. Снятый вопрос оставляет обычную упавшую задачу.
// Модели не вызываются: demo-исполнитель и управляемый reviewer ответа.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { AgentContext } from '../src/application/context.ts';
import { panelQueue, panelTask } from '../src/application/panel.ts';
import { inputNextText } from '../src/core/input-labels.ts';
import { chainBlockers } from '../src/core/work-status.ts';
import { statusKey, taskStatus } from '../src/web/status.ts';

after(() => inputDemos.close());

type Progress = { reasons: string[]; input?: { requestId: string }; eligible: boolean };

test('A question stop reads as waiting for an answer, not as a failure to diagnose; a withdrawn question leaves an ordinary failure', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, boardId } = f.askingTask();
    const dependent = f.plainTask(boardId, 'Waits for the asking task', [taskId]);
    await untilQuestion(f, boardId);
    const [request] = f.service.list({ taskId }).requests;
    const briefing = () =>
      new AgentContext(f.h).execute('task_briefing', { taskId }) as {
        task: { status: string };
        progress: Progress;
      };

    const held = briefing();
    // Статус движка не подменяется: остановка записана отказом.
    assert.equal(held.task.status, 'failed');
    assert.ok(held.progress.reasons.includes('input_required'), JSON.stringify(held.progress));
    assert.equal(held.progress.reasons.includes('failure_requires_diagnosis'), false);
    assert.deepEqual(held.progress.input, { requestId: request.requestId });
    assert.equal(held.progress.eligible, false);

    // Панель: тот же прогресс и статус «Ждёт ответа» вместо «Сбой».
    const shown = panelTask(f.h, taskId, {}).task as unknown as {
      status: string;
      blockers: string[];
      progress: Progress;
    };
    assert.ok(shown.progress.reasons.includes('input_required'));
    assert.equal(shown.progress.reasons.includes('failure_requires_diagnosis'), false);
    assert.equal(statusKey(shown), 'input');
    assert.deepEqual(
      { label: taskStatus(shown).label, tone: taskStatus(shown).tone },
      { label: 'Ждёт ответа', tone: 'waiting' },
    );

    // Очередь панели: та же задача — ожидание ответа со следующим шагом, не сбой.
    type QueueItem = {
      id: string;
      status: string;
      blockers: string[];
      input?: { requestId: string; state: string; actor: 'operator' | 'lead'; kind?: string };
    };
    const queued = () => (panelQueue(f.h, {}).items as QueueItem[]).find((i) => i.id === taskId)!;
    const waiting = queued();
    assert.equal(waiting.status, 'failed');
    assert.deepEqual(waiting.blockers, ['input:' + request.requestId]);
    assert.equal(statusKey(waiting), 'input');
    assert.equal(taskStatus(waiting).label, 'Ждёт ответа');
    assert.equal(waiting.input?.requestId, request.requestId);
    assert.equal(waiting.input?.state, 'awaiting-answer');
    assert.equal(inputNextText(waiting.input), inputNextText(request));
    assert.notEqual(inputNextText(waiting.input), '');

    // Корень цепочки зависимой задачи — ожидание ответа, а не «сбой».
    const tasks = f.store.read().tasks.map((t) => ({
      ...t,
      blockers: t.id === taskId ? shown.blockers : [],
    }));
    const [root] = chainBlockers(tasks, f.h.config.maxAttempts);
    assert.equal(root.taskId, taskId);
    assert.equal(root.waiting, 1);
    assert.match(root.reason, /ждёт ответа на вопрос исполнителя/);
    assert.doesNotMatch(root.reason, /сбой/);
    void dependent;

    // Вопрос снят: задача — обычный отказ, который разбирают и повторяют.
    f.service.cancel(
      { requestId: request.requestId, expectedVersion: request.version, reason: 'Not needed now' },
      'operator',
    );
    const released = briefing();
    assert.equal(released.task.status, 'failed');
    assert.equal(released.progress.reasons.includes('input_required'), false);
    assert.ok(released.progress.reasons.includes('failure_requires_diagnosis'));
    assert.equal(released.progress.input, undefined);
    const after = panelTask(f.h, taskId, {}).task as unknown as {
      status: string;
      blockers: string[];
    };
    assert.equal(statusKey(after), 'failed');
    const failedInQueue = queued();
    assert.deepEqual(failedInQueue.blockers, []);
    assert.equal(failedInQueue.input, undefined);
    assert.equal(statusKey(failedInQueue), 'failed');
  } finally {
    await f.cleanup();
  }
});
