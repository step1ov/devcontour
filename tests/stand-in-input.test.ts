// Решения за владельца, которые записывает сам инструмент: ведущий ответил
// на вопрос исполнителя изменением требований или принял допущение
// follow-up. Модели не вызываются: demo-исполнитель и управляемый reviewer.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { DiscussionService } from '../src/application/discussion.ts';

after(() => inputDemos.close());

test('F21: ответ ведущего изменением требований записывает решение за владельца; ответ оператора — нет', async () => {
  const f = await inputFixture(controlled());
  try {
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [r] = f.service.list({ taskId }).requests;
    const d = new DiscussionService(f.h);
    // Уточнение ведущего решением за владельца не считается.
    const clarified = f.service.answer(
      { requestId: r.requestId, text: 'Use JSON as now.', expectedVersion: r.version },
      'lead',
    );
    assert.equal(d.standIns(10).length, 0);
    const changed = f.service.answer(
      {
        requestId: r.requestId,
        text: 'Change the acceptance: produce YAML.',
        kind: 'requirement-change',
        expectedVersion: clarified.version,
      },
      'lead',
    );
    const [stand] = d.standIns(10);
    assert.ok(stand, 'решение за владельца записано инструментом');
    assert.equal(stand.message.taskId, taskId);
    assert.equal(stand.message.author, 'lead');
    assert.match(
      stand.message.text,
      /изменением требований: Change the acceptance: produce YAML\./,
    );
    assert.equal(
      stand.message.standIn?.question,
      f.service.show({ requestId: r.requestId }).question.question,
    );
    assert.match(stand.message.standIn?.impact ?? '', /Постановка и результат задачи/);
    // Тот же ответ повторно — без второй записи.
    f.service.answer(
      {
        requestId: r.requestId,
        text: 'Change the acceptance: produce YAML.',
        kind: 'requirement-change',
        expectedVersion: changed.version,
      },
      'lead',
    );
    assert.equal(d.standIns(10).length, 1);
    // Изменение требований оператором — его собственное решение.
    const current = f.service.show({ requestId: r.requestId });
    f.service.answer(
      {
        requestId: r.requestId,
        text: 'Produce TOML instead.',
        kind: 'requirement-change',
        expectedVersion: current.version,
      },
      'operator',
    );
    assert.equal(d.standIns(10).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('F21: ведущий принимает допущение follow-up — инструмент записывает решение за владельца', async () => {
  const f = await inputFixture(controlled({ assume: true }), {
    edit: (raw) => (raw.inputPolicy = { threshold: 11 }),
  });
  try {
    const board = f.h.createBoard('Autonomous board');
    const taskId = f.plainTask(board.id, 'Autonomous task');
    f.h.approve(board.id);
    f.h.pause(false);
    await f.scheduler.drain();
    const followUps = f.service
      .list()
      .requests.filter((r) => r.kind === 'follow-up' && r.state === 'awaiting-answer');
    const own = followUps.find((r) => r.taskId === taskId)!;
    assert.ok(own);
    const d = new DiscussionService(f.h);
    f.service.cancel(
      { requestId: own.requestId, expectedVersion: own.version, reason: 'assumption accepted' },
      'lead',
    );
    const recorded = d.standIns(50).filter((s) => s.message.taskId === taskId);
    assert.equal(recorded.length, 1);
    assert.match(
      recorded[0].message.text,
      /Ведущий принял допущение исполнителя: .*assumption accepted/,
    );
    // Закрытие follow-up оператором — его решение, записи нет.
    const other = followUps.find((r) => r.taskId !== taskId);
    if (other) {
      f.service.cancel(
        { requestId: other.requestId, expectedVersion: other.version, reason: 'ok' },
        'operator',
      );
      assert.equal(d.standIns(50).filter((s) => s.message.taskId === other.taskId).length, 0);
    }
  } finally {
    await f.cleanup();
  }
});
