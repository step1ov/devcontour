import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AttentionService } from '../src/application/attention.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { DomainError } from '../src/core/model.ts';
import { specDigest } from '../src/core/service.ts';
import { Preparation } from '../src/core/preparation.ts';
import { Store } from '../src/core/store.ts';
import type { AttentionItem } from '../src/core/attention-model.ts';
import { product } from './preparation-fixture.ts';
import { byKey, preparationFixture } from './attention-fixture.ts';
import { fixture, input } from './helpers.ts';

// D04-C: решение из старой вкладки после смены версии отклоняется, уже
// выполненное действие не повторяется.

const act = (item: AttentionItem, action: string, extra: Record<string, unknown> = {}) => ({
  sourceKey: item.sourceKey,
  occurrenceId: item.occurrenceId,
  expectedVersion: item.sourceVersion,
  action,
  ...extra,
});
const refusal = (code: string) => (error: unknown) =>
  error instanceof DomainError && error.status === 409 && error.details?.code === code;

test('План оператора: старая версия — attention-stale без изменений, двойная отправка — одно утверждение', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Board');
    const one = f.h.addTask(b.id, input('One task'));
    const service = new AttentionService(f.store, f.h);
    const shown = byKey((await service.active()).items, `plan:${b.id}`)!;
    // Вторая вкладка: правка постановки между показом и решением.
    f.h.editTask(
      one.id,
      { ...input('One task, edited'), description: 'An edited observable outcome.' },
      specDigest(f.store.read().tasks.find((t) => t.id === one.id)!),
    );
    let stale: unknown;
    await assert.rejects(service.act(act(shown, 'approve')), (error) => {
      stale = error;
      return refusal('attention-stale')(error);
    });
    const current = (stale as DomainError).details!.item as AttentionItem;
    assert.equal(current.id, shown.id);
    assert.notEqual(current.sourceVersion, shown.sourceVersion);
    assert.equal(f.store.read().tasks.find((t) => t.id === one.id)!.status, 'draft');
    const done = await service.act(act(current, 'approve'));
    assert.deepEqual(done.resolved, true);
    const approvedAt = f.store.read().tasks.find((t) => t.id === one.id)!.approvedAt;
    assert.ok(approvedAt);
    await assert.rejects(service.act(act(current, 'approve')), refusal('attention-resolved'));
    assert.equal(f.store.read().tasks.find((t) => t.id === one.id)!.approvedAt, approvedAt);
  } finally {
    f.cleanup();
  }
});

test('Ответ оператора в обсуждении: повтор с тем же ключом — replayed, одно сообщение', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const discussion = new DiscussionService(f.h);
    const request = discussion.post(
      {
        taskId: t.id,
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'attention-act-1',
        expectedVersion: 0,
      },
      'operator',
    ).message;
    discussion.resolve({
      requestId: request.id,
      outcome: 'needs-answer',
      reason: 'Какой режим по умолчанию?',
      idempotencyKey: 'attention-act-2',
      expectedVersion: f.store.discussionVersion(undefined, t.id),
    });
    const service = new AttentionService(f.store, f.h);
    const card = byKey((await service.active()).items, `discussion:na:${request.id}`)!;
    const body = act(card, 'answer', {
      input: { text: 'Дневной по умолчанию' },
      idempotencyKey: 'attention-act-answer-1',
    });
    const first = await service.act(body);
    assert.equal(first.resolved, true);
    const version = f.store.discussionVersion(undefined, t.id);
    const again = await service.act(body);
    assert.deepEqual((again.result as { replayed: boolean }).replayed, true);
    assert.equal(f.store.discussionVersion(undefined, t.id), version, 'второго сообщения нет');
    // Без ключа повтор — карточка уже решена.
    await assert.rejects(
      service.act({ ...body, idempotencyKey: undefined }),
      refusal('attention-resolved'),
    );
  } finally {
    f.cleanup();
  }
});

test('Пауза оператора: запуск очереди с карточки; действие ведущего не предлагается оператору', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(true);
    let ticks = 0;
    const service = new AttentionService(f.store, f.h);
    const queue = byKey((await service.active()).items, 'queue')!;
    await assert.rejects(
      service.act(act(queue, 'resume'), { stopping: () => true }),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
    assert.equal(f.store.read().paused, true);
    const done = await service.act(act(queue, 'resume'), {
      tick: () => Promise.resolve(++ticks),
    });
    assert.equal(done.resolved, true);
    assert.equal(f.store.read().paused, false);
    assert.equal(ticks, 1);
    // Карточка ведущего: доменного действия у оператора нет.
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    const work = byKey((await service.active()).items, `work:${t.id}`)!;
    await assert.rejects(
      service.act(act(work, 'retry')),
      (e: unknown) => e instanceof DomainError && e.status === 400,
    );
  } finally {
    f.cleanup();
  }
});

test('До setup: ответ на вопрос и согласование с карточки; гонка со второй базой — один победитель', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      stage: 'architecture',
      add: [{ text: 'Кто модерирует ночью?', options: ['Бот', 'Дежурный'] }],
    });
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: null,
      reason: 'Постановка',
      content: product,
    });
    const view = f.p.status(f.changeId);
    if (!view.enabled) throw new Error('preparation');
    f.p.execute('preparation_submit', {
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: view.current!.product!.digest,
    });
    const service = new AttentionService(f.store, undefined);
    const items = (await service.active()).items;
    const question = items.find((i) => i.source === 'prep-question')!;
    const answered = await service.act(act(question, 'answer', { input: { optionId: '1' } }));
    assert.equal(answered.resolved, true);
    assert.equal(f.store.read().preparation!.changes[0].questions[0].answer!.text, 'Дежурный');
    // Решение из второго процесса раньше карточки: карточка отклоняется.
    const stage = byKey(items, `prep:stage:${f.changeId}:product`)!;
    const other = new Store(join(f.root, 'state.sqlite'));
    try {
      new Preparation(other).decide({
        changeId: f.changeId,
        stage: 'product',
        expectedDigest: view.current!.product!.digest,
        decision: 'approve',
        comment: 'Из другой вкладки',
      });
    } finally {
      other.close();
    }
    await assert.rejects(service.act(act(stage, 'approve')), refusal('attention-resolved'));
    const decisions = f.store.read().preparation!.changes[0].product.filter((r) => r.decision);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision!.comment, 'Из другой вкладки');
    // Действия движка до setup отсутствуют: карточек движка нет.
    await assert.rejects(
      service.act({
        sourceKey: 'queue',
        occurrenceId: 'initial',
        expectedVersion: 'x',
        action: 'resume',
      }),
      refusal('attention-resolved'),
    );
  } finally {
    f.cleanup();
  }
});
