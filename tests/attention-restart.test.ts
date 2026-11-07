import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { DiscussionService } from '../src/application/discussion.ts';
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

test('История плана: каждое утверждение оператора решает появление, которое было активным', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('One task'));
    const service = new AttentionService(f.store, f.h);
    const key = `plan:${b.id}`;
    const first = byKey((await service.active()).items, key)!;
    f.h.approve(b.id);
    f.h.addTask(b.id, input('Two task'));
    const second = byKey((await service.active()).items, key)!;
    f.h.approve(b.id);
    const history = service.history().items.filter((i) => i.sourceKey === key);
    assert.deepEqual(
      history.map((i) => i.occurrenceId).sort(),
      [first.occurrenceId, second.occurrenceId].sort(),
    );
    const approvals = [...new Set(f.store.read().tasks.map((t) => t.approvedAt))].sort();
    assert.deepEqual(history.map((i) => i.resolvedAt).sort(), approvals);
  } finally {
    f.cleanup();
  }
});

test('История обращений: обработка решает очередь ведущего, ответ оператора — его вопрос', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const discussion = new DiscussionService(f.h);
    const version = () => f.store.discussionVersion(undefined, t.id);
    const request = discussion.post(
      {
        taskId: t.id,
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'attention-hist-1',
        expectedVersion: version(),
      },
      'operator',
    ).message;
    const service = new AttentionService(f.store, f.h);
    const cr = `discussion:cr:${request.id}`;
    const na = `discussion:na:${request.id}`;
    const open1 = byKey((await service.active()).items, cr)!;
    const asked = discussion.resolve({
      requestId: request.id,
      outcome: 'needs-answer',
      reason: 'Какой режим по умолчанию?',
      idempotencyKey: 'attention-hist-2',
      expectedVersion: version(),
    }).message;
    const question = byKey((await service.active()).items, na)!;
    const answer = discussion.post(
      {
        taskId: t.id,
        kind: 'note',
        text: 'Дневной',
        replyTo: asked.id,
        idempotencyKey: 'attention-hist-3',
        expectedVersion: version(),
      },
      'operator',
    ).message;
    const open2 = byKey((await service.active()).items, cr)!;
    const rejected = discussion.resolve({
      requestId: request.id,
      outcome: 'rejected',
      reason: 'Вне объёма',
      idempotencyKey: 'attention-hist-4',
      expectedVersion: version(),
    }).message;
    const history = service.history().items;
    const requests = history.filter((i) => i.sourceKey === cr);
    assert.deepEqual(
      requests.map((i) => [i.occurrenceId, i.resolvedAt]).sort(),
      [
        [open1.occurrenceId, asked.createdAt],
        [open2.occurrenceId, rejected.createdAt],
      ].sort(),
    );
    const answers = history.filter((i) => i.sourceKey === na);
    assert.deepEqual(
      answers.map((i) => [i.occurrenceId, i.resolvedAt]),
      [[question.occurrenceId, answer.createdAt]],
    );
  } finally {
    f.cleanup();
  }
});

test('История задач: сбой, решённый отменой, — в истории; сбой, который сам повторился, — нет', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Cancelled later'));
    const u = f.h.addTask(b.id, input('Retried quietly'));
    f.h.approve(b.id);
    const service = new AttentionService(f.store, f.h);
    const fail = (taskId: string) => {
      f.h.pause(false);
      const run = f.h.claim('test')!;
      assert.equal(run.taskId, taskId);
      f.h.fail(run.id, run.token, 'unit tests failed', false, 'gate');
      f.h.pause(true);
      return run;
    };
    const first = fail(t.id);
    // Корректировка отменяет упавшую задачу без новой попытки.
    f.h.cancel(t.id, 'replanned by a correction', 'operator');
    const resolved = service.history().items.filter((i) => i.sourceKey === `work:${t.id}`);
    assert.deepEqual(
      resolved.map((i) => i.occurrenceId),
      [first.id],
    );
    assert.ok(resolved[0].resolvedAt);
    // Сбой без отметки, после которого задача повторена и принята: в истории
    // только последний сбой перед принятием.
    const quiet = fail(u.id);
    f.h.retry(u.id);
    const lastFailure = fail(u.id);
    f.h.retry(u.id);
    complete(f.h, u.id);
    const own = service.history().items.filter((i) => i.sourceKey === `work:${u.id}`);
    assert.deepEqual(
      own.map((i) => i.occurrenceId),
      [lastFailure.id],
    );
    assert.notEqual(quiet.id, lastFailure.id);
  } finally {
    f.cleanup();
  }
});
