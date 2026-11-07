import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { complete, fixture, input } from './helpers.ts';
import { byKey, preparationFixture } from './attention-fixture.ts';

// D04-D (история): после восстановления старые проблемы уходят в историю,
// новое появление видно непрочитанным.

test('Сбой → повтор → тот же сбой: прежнее появление в истории, новое непрочитано и одно', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const service = new AttentionService(f.store, f.h);
    const fail = () => {
      f.h.pause(false);
      const run = f.h.claim('test')!;
      f.h.fail(run.id, run.token, 'unit tests failed', false, 'gate');
      return run;
    };
    const first = fail();
    const card = byKey((await service.active()).items, `work:${t.id}`)!;
    await service.mark({
      marks: [
        {
          sourceKey: card.sourceKey,
          occurrenceId: card.occurrenceId,
          version: card.sourceVersion,
          kind: 'ack',
        },
      ],
    });
    f.h.retry(t.id);
    const second = fail();
    const active = (await service.active()).items.filter((i) => i.sourceKey === card.sourceKey);
    assert.equal(active.length, 1);
    assert.equal(active[0].occurrenceId, second.id);
    assert.equal(active[0].state.unread, true);
    const history = service.history().items.filter((i) => i.sourceKey === card.sourceKey);
    assert.deepEqual(
      history.map((i) => i.occurrenceId),
      [first.id],
    );
    assert.equal(
      history[0].resolvedAt,
      f.store.read().runs.find((r) => r.id === second.id)!.startedAt,
    );
    assert.equal(
      history[0].state.acknowledged,
      true,
      'отметка решённого появления видна в истории',
    );
    assert.deepEqual(history[0].actions, []);
    // Восстановление: повтор и принятие задачи — оба сбоя в истории.
    f.h.retry(t.id);
    complete(f.h, t.id);
    assert.equal(byKey((await service.active()).items, card.sourceKey), undefined);
    const resolved = service.history().items.filter((i) => i.sourceKey === card.sourceKey);
    assert.deepEqual(resolved.map((i) => i.occurrenceId).sort(), [first.id, second.id].sort());
  } finally {
    f.cleanup();
  }
});

test('История подготовки: отвеченный вопрос со временем ответа, в активном списке его нет', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Кто модерирует ночью?' }],
    });
    const q = f.store.read().preparation!.changes[0].questions[0];
    f.p.answer({ changeId: f.changeId, questionId: q.id, text: 'Дежурный' });
    const service = new AttentionService(f.store, undefined);
    const history = service.history().items;
    const answered = history.find((i) => i.sourceKey === `prep:q:${f.changeId}:${q.id}`)!;
    assert.equal(
      answered.resolvedAt,
      f.store.read().preparation!.changes[0].questions[0].answer!.at,
    );
    assert.equal(byKey((await service.active()).items, answered.sourceKey), undefined);
  } finally {
    f.cleanup();
  }
});
