// D04-A, строка S15: вопрос исполнителя в центре внимания. Demo-исполнитель
// спрашивает (`[demo:ask]`), модели не вызываются.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { byKey } from './attention-fixture.ts';

after(() => inputDemos.close());

test('S15 вопрос исполнителя: забирает задачу, ответ — существенное обновление, отмена снимает', async () => {
  const f = await inputFixture(undefined, { approvalMode: 'operator' });
  try {
    const { boardId, taskId } = f.askingTask('Asking task');
    const dependent = f.plainTask(boardId, 'Waits for the asking task', [taskId]);
    await untilQuestion(f, boardId);
    const [request] = f.service.list({ taskId }).requests;
    assert.ok(request, 'demo writer asked');
    const items = async () =>
      (await new AttentionService(f.store, f.h, { root: f.root }).active()).items;
    const key = `input:${request.requestId}`;
    const first = await items();
    const card = byKey(first, key)!;
    assert.equal(card.actor, 'operator');
    assert.equal(card.category, 'question');
    assert.equal(card.occurrenceId, request.requestId);
    assert.ok(card.actions.some((a) => a.id === 'answer'));
    assert.deepEqual(card.impact.taskIds, [taskId]);
    assert.equal(card.impact.waiting, 1, `${dependent} waits for the asking task`);
    // Задача, которую держит вопрос, своей карточки не даёт.
    assert.equal(byKey(first, `work:${taskId}`), undefined);
    const repeat = byKey(await items(), key)!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [card.id, card.sourceVersion]);
    // Ответ сохранён: та же карточка, новая версия, дальше действует ведущий.
    f.service.answer(
      { requestId: request.requestId, text: 'Use JSON as now.', expectedVersion: request.version },
      'operator',
    );
    const answered = byKey(await items(), key)!;
    assert.equal(answered.id, card.id);
    assert.notEqual(answered.sourceVersion, card.sourceVersion);
    assert.equal(answered.actor, 'lead');
    const current = f.service.list({ taskId }).requests[0];
    f.service.cancel(
      {
        requestId: request.requestId,
        expectedVersion: current.version,
        reason: 'Решено без ответа',
      },
      'operator',
    );
    assert.equal(byKey(await items(), key), undefined);
  } finally {
    await f.cleanup();
  }
});
