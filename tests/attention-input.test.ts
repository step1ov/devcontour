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
import { inputStateLabels, suggestedAnswerKind } from '../src/core/input-labels.ts';
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
    const answerAction = card.actions.find((a) => a.id === 'answer') as {
      prompt?: string;
      choices?: { id: string; label: string; recommended?: boolean }[];
    };
    const asked = f.service.show({ requestId: request.requestId }) as unknown as {
      question: { question: string; options: { id: string }[] };
    };
    assert.equal(answerAction.prompt, asked.question.question);
    assert.deepEqual(
      answerAction.choices!.map((c) => c.id),
      asked.question.options.map((o) => o.id),
    );
    assert.equal(card.subject.href, `/?view=boards&tab=list&task=${taskId}#input`);
    // Итог карточки — вопрос и следующий шаг словами оператора; указание
    // ведущему из сводки запроса (по-английски) в неё не попадает, а его
    // ссылка — адрес панели, а не путь, которого у панели нет.
    assert.ok(card.reason.endsWith('Дальше: ответьте на вопрос в карточке задачи.'), card.reason);
    assert.doesNotMatch(card.reason, /answer in the panel|\/tasks\//);
    assert.equal(
      request.next,
      `answer in the panel: /?view=boards&tab=list&task=${taskId}#input; the lead may propose an answer (input_propose) for the operator to confirm`,
    );
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
      // Только вариант, без текста: ответом становится вариант.
      input: { optionId: answerAction.choices![0].id },
      idempotencyKey: 'attention-input-answer-1',
    };
    await service.act(body);
    const revisions = () => executionOf(f.h).engine.inputRequest(request.requestId).answers.length;
    assert.equal(revisions(), 1);
    assert.equal(
      executionOf(f.h).engine.inputRequest(request.requestId).answers[0].text,
      answerAction.choices![0].label,
    );
    const replay = await service.act(body);
    assert.equal((replay.result as { replayed: boolean }).replayed, true);
    assert.equal(revisions(), 1);
    // Тот же ключ с другим ответом — конфликт без новой версии ответа.
    await assert.rejects(
      service.act({ ...body, input: { text: 'Другой ответ' } }),
      (e: unknown) =>
        e instanceof DomainError && e.status === 409 && e.details?.code === 'idempotency-conflict',
    );
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
    // Состояние словами оператора (подписи карточки задачи), не код.
    assert.doesNotMatch(answered.title, /answer-saved/);
    assert.ok(answered.title.endsWith(inputStateLabels['answer-saved']), answered.title);
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

test('Применение ответа с карточки: отклонённый раунд — только подтверждением этого раунда (правило D03), в режиме agent оператору не предлагается', async () => {
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
    const round = (apply as { round?: number }).round!;
    const summary = f.service.list({ taskId }).requests[0];
    assert.equal(summary.state, 'review-rejected');
    assert.equal(round, summary.round);
    assert.match(
      (apply as { label: string }).label,
      new RegExp(`вопреки ревью \\(раунд ${round}\\)`),
    );
    assert.match(card.reason, /Fixture: the answer changes the spec/);
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
      (e: unknown) => e instanceof DomainError && e.status === 409 && /раунд/.test(e.message),
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
    // Подтверждён не показанный раунд — отказ правила D03 в транзакции применения.
    await assert.rejects(
      service.act({ ...body, input: { confirmRejectedRound: round + 1 } }),
      (e: unknown) =>
        e instanceof DomainError && e.status === 409 && /Подтверждён раунд/.test(e.message),
    );
    assert.equal(lifecycle(), before);
    const done = await service.act({ ...body, input: { confirmRejectedRound: round } });
    assert.equal((done.result as { applied: boolean }).applied, true);
    assert.equal(lifecycle(), 'applied');
    assert.equal(done.resolved, true);
  } finally {
    await f.cleanup();
  }
});

test('F38: вопрос о контракте — форма ответа предлагает «изменение требований», прочие вопросы — уточнение', async () => {
  assert.equal(suggestedAnswerKind(['contract', 'acceptance']), 'requirement-change');
  assert.equal(suggestedAnswerKind(['api']), 'clarification');
  assert.equal(suggestedAnswerKind([]), 'clarification');
  assert.equal(suggestedAnswerKind(undefined), 'clarification');
  for (const [affects, kind] of [
    [['contract', 'acceptance'], 'requirement-change'],
    [['api'], undefined],
  ] as const) {
    const f = await inputFixture(controlled({ affects: [...affects] }));
    try {
      const { boardId, taskId } = f.askingTask('Asking task');
      await untilQuestion(f, boardId);
      const [request] = f.service.list({ taskId }).requests;
      const card = byKey(
        (await new AttentionService(f.store, f.h, { root: f.root }).active()).items,
        `input:${request.requestId}`,
      )!;
      assert.equal(card.actor, 'operator');
      const answer = card.actions.find((a) => a.id === 'answer') as { answerKind?: string };
      assert.equal(answer.answerKind, kind);
    } finally {
      await f.cleanup();
    }
  }
});
