// D04-A, строка S15: вопрос исполнителя в центре внимания. Demo-исполнитель
// спрашивает (`[demo:ask]`), модели не вызываются.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { controlled, inputDemos, inputFixture, prepared, untilQuestion } from './input-fixture.ts';
import { DomainError } from '../src/core/model.ts';
import { join } from 'node:path';
import { executionOf } from '../src/harness/execution.ts';
import { dumpDatabase } from './attention-fixture.ts';
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
    // Чтение при ожидающем вопросе ничего не пишет.
    const before = dumpDatabase(join(f.root, 'state.sqlite'));
    await items();
    assert.equal(dumpDatabase(join(f.root, 'state.sqlite')), before);
    // Ответ с карточки (правило D03: сообщение обсуждения со ссылкой на версию
    // ответа); повтор с тем же ключом — прежнее сообщение, без второго ответа.
    const service = new AttentionService(f.store, f.h, { root: f.root });
    const body = {
      sourceKey: card.sourceKey,
      occurrenceId: card.occurrenceId,
      expectedVersion: card.sourceVersion,
      action: 'answer',
      input: { text: 'Use JSON as now.' },
      idempotencyKey: 'attention-input-answer-1',
    };
    await service.act(body);
    const revisions = () => executionOf(f.h).engine.inputRequest(request.requestId).answers.length;
    assert.equal(revisions(), 1);
    const replay = await service.act(body);
    assert.equal((replay.result as { replayed: boolean }).replayed, true);
    assert.equal(revisions(), 1);
    // Без ключа старая карточка устарела: версия запроса другая.
    await assert.rejects(
      service.act({ ...body, idempotencyKey: undefined }),
      (e: unknown) =>
        e instanceof DomainError && e.status === 409 && e.details?.code === 'attention-stale',
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
    // История: снятый вопрос со временем закрытия из записи запроса.
    const history = new AttentionService(f.store, f.h, { root: f.root })
      .history()
      .items.filter((i) => i.sourceKey === key);
    assert.equal(history.length, 1);
    assert.equal(history[0].occurrenceId, request.requestId);
    assert.ok(history[0].resolvedAt);
  } finally {
    await f.cleanup();
  }
});

test('Применение ответа с карточки: отклонённое ревью — только с подтверждением, в режиме agent оператору не предлагается', async () => {
  const f = await inputFixture(controlled({ verdict: { approve: false } }), {
    approvalMode: 'operator',
  });
  try {
    const { boardId, taskId } = f.askingTask('Asking task');
    await untilQuestion(f, boardId);
    const [request] = f.service.list({ taskId }).requests;
    await prepared(f, request.requestId);
    const service = new AttentionService(f.store, f.h, { root: f.root });
    const key = `input:${request.requestId}`;
    const card = byKey((await service.active()).items, key)!;
    assert.equal(card.actor, 'operator');
    const apply = card.actions.find((a) => a.id === 'apply')!;
    assert.match((apply as { label: string }).label, /отклонённому ревью/);
    const body = {
      sourceKey: card.sourceKey,
      occurrenceId: card.occurrenceId,
      expectedVersion: card.sourceVersion,
      action: 'apply',
    };
    const lifecycle = () => f.service.list({ taskId }).requests[0].lifecycle;
    const before = lifecycle();
    await assert.rejects(
      service.act(body),
      (e: unknown) =>
        e instanceof DomainError && e.status === 409 && e.details?.code === 'confirmation-required',
    );
    assert.equal(lifecycle(), before);
    // В режиме agent применяет ведущий: оператору действие не предлагается.
    f.h.config.approvalMode = 'agent';
    const agentCard = byKey((await service.active()).items, key)!;
    assert.equal(agentCard.actor, 'lead');
    assert.equal(
      agentCard.actions.some((a) => a.kind === 'domain'),
      false,
    );
    await assert.rejects(
      service.act({ ...body, expectedVersion: agentCard.sourceVersion }),
      (e: unknown) => e instanceof DomainError && e.status === 400,
    );
    assert.equal(lifecycle(), before);
    f.h.config.approvalMode = 'operator';
    const done = await service.act({ ...body, input: { confirm: true } });
    assert.equal((done.result as { applied: boolean }).applied, true);
    assert.equal(lifecycle(), 'applied');
    assert.equal(done.resolved, true);
  } finally {
    await f.cleanup();
  }
});
