// Ответы ведущего на вопросы исполнителя (harness 0.1.0-alpha.55,
// `inputPolicy.leadAnswers`): в режиме agent ведущий решает технический
// вопрос сам с записанной причиной; вопрос для пользователя (или без
// `impact`) — только владелец в панели; в режиме operator — всё владельцу.
// Проверки идут и через DevContour, и прямо через движок: правило должно
// держаться в политике harness, а не только в проверке DevContour.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionService } from '../src/application/attention.ts';
import { executionOf } from '../src/harness/execution.ts';
import { policyFromConfig } from '../src/harness/policy.ts';
import { byKey } from './attention-fixture.ts';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';

after(() => inputDemos.close());

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return `${e.status ?? '-'}:${e.code ?? '-'}`;
  }
};

type Shown = {
  version: number;
  actor: string;
  question: { impact?: string; options: { id: string; forUser?: string }[] };
  answers: { actor: { kind: string }; basis?: string; reason?: string }[];
};

async function asked(
  impact: 'technical' | 'user-visible' | null | undefined,
  approvalMode: 'agent' | 'operator' = 'agent',
) {
  const f = await inputFixture(controlled(impact === undefined ? {} : { impact }), {
    approvalMode,
  });
  const { boardId, taskId } = f.askingTask('Asking task');
  await untilQuestion(f, boardId);
  const [request] = f.service.list({ taskId }).requests;
  assert.ok(request, 'demo writer asked');
  return { f, taskId, requestId: request.requestId };
}

const answer = { text: 'Use JSON as now.', optionId: 'json' };

test('agent mode: the lead decides a technical question only with a reason; the engine records basis and reason', async () => {
  const { f, requestId } = await asked(undefined);
  try {
    // Политика процесса несёт разрешение: без него движок отказал бы сам.
    assert.deepEqual(policyFromConfig(f.h.config).inputPolicy?.leadAnswers, {
      maxSeverity: 9,
      technical: true,
    });
    const shown = f.service.show({ requestId }) as unknown as Shown;
    assert.equal(shown.question.impact, 'technical');
    assert.equal(shown.actor, 'lead');
    // Без причины — отказ DevContour до движка, запрос не меняется.
    assert.equal(
      codeOf(() =>
        f.service.answer({ requestId, ...answer, expectedVersion: shown.version }, 'lead'),
      ),
      '400:INVALID_INPUT',
    );
    assert.equal(f.service.show({ requestId }).version, shown.version);
    const reason = 'The checks read JSON today; YAML would only add work.';
    f.service.answer({ requestId, ...answer, reason, expectedVersion: shown.version }, 'lead');
    const saved = f.service.show({ requestId }) as unknown as Shown;
    const last = saved.answers.at(-1)!;
    assert.deepEqual([last.actor.kind, last.basis, last.reason], ['lead', 'technical', reason]);
    // Запись движка — та же: причина хранится в запросе harness.
    const stored = executionOf(f.h).engine.inputRequest(requestId).answers.at(-1)!;
    assert.deepEqual([stored.basis, stored.reason], ['technical', reason]);
  } finally {
    await f.cleanup();
  }
});

test('agent mode: a user-visible question goes to the owner; the lead is refused by DevContour and by the engine', async () => {
  for (const impact of ['user-visible', null] as const) {
    const { f, taskId, requestId } = await asked(impact);
    try {
      const shown = f.service.show({ requestId }) as unknown as Shown;
      assert.equal(shown.question.impact, impact ?? undefined);
      assert.equal(shown.actor, 'operator', `${impact}: the owner answers`);
      const input = {
        requestId,
        ...answer,
        reason: 'I think so',
        expectedVersion: shown.version,
      };
      assert.equal(
        codeOf(() => f.service.answer(input, 'lead')),
        '403:OPERATOR_ANSWERS',
      );
      assert.equal(
        codeOf(() => f.service.answer(input, 'host')),
        '403:OPERATOR_ANSWERS',
      );
      // Движок держит то же правило по политике DevContour.
      assert.equal(
        codeOf(() =>
          executionOf(f.h).engine.answerInput(
            requestId,
            { ...answer, actor: { kind: 'lead' }, reason: 'bypass' },
            shown.version,
          ),
        ),
        '-:OPERATOR_ANSWER_REQUIRED',
      );
      // Снять вопрос или отменить задачу ведущий тоже не может.
      assert.equal(
        codeOf(() =>
          f.service.cancel(
            { requestId, expectedVersion: shown.version, reason: 'not needed' },
            'lead',
          ),
        ),
        '403:OPERATOR_ANSWERS',
      );
      assert.equal(
        codeOf(() => f.h.cancel(taskId, 'not needed', 'host')),
        '403:OPERATOR_ANSWERS',
      );
      // Карточка владельца: user-visible — раздел «Продукт», без impact — «Разработка».
      const items = (await new AttentionService(f.store, f.h, { root: f.root }).active()).items;
      const card = byKey(items, `input:${requestId}`)!;
      assert.equal(card.actor, 'operator');
      assert.equal(card.section, impact === 'user-visible' ? 'product' : 'development');
      if (impact === 'user-visible') assert.match(card.reason, /меняет результат для пользователя/);
      // Ответ оператора — без причины.
      f.service.answer({ requestId, ...answer, expectedVersion: shown.version }, 'operator');
      const last = (f.service.show({ requestId }) as unknown as Shown).answers.at(-1)!;
      assert.deepEqual(
        [last.actor.kind, last.basis, last.reason],
        ['operator', undefined, undefined],
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('operator mode: no lead rule in the policy; even a technical question is the owner one', async () => {
  const { f, requestId } = await asked('technical', 'operator');
  try {
    assert.equal(policyFromConfig(f.h.config).inputPolicy, undefined);
    const shown = f.service.show({ requestId }) as unknown as Shown;
    assert.equal(shown.actor, 'operator');
    const input = { requestId, ...answer, reason: 'technical', expectedVersion: shown.version };
    assert.equal(
      codeOf(() => f.service.answer(input, 'lead')),
      '403:OPERATOR_ANSWERS',
    );
    assert.equal(
      codeOf(() =>
        executionOf(f.h).engine.answerInput(
          requestId,
          { ...answer, actor: { kind: 'lead' }, reason: 'bypass' },
          shown.version,
        ),
      ),
      '-:OPERATOR_ANSWER_REQUIRED',
    );
  } finally {
    await f.cleanup();
  }
});

test('the product demo question carries forUser lines; the owner card shows them instead of the technical consequence', async () => {
  const f = await inputFixture(controlled(), { approvalMode: 'agent' });
  try {
    const { boardId, taskId } = f.askingTask('Asking task', { marker: '[demo:ask-product]' });
    await untilQuestion(f, boardId);
    const [request] = f.service.list({ taskId }).requests;
    const shown = f.service.show({ requestId: request.requestId }) as unknown as Shown;
    assert.equal(shown.question.impact, 'user-visible');
    assert.equal(shown.actor, 'operator');
    const items = (await new AttentionService(f.store, f.h, { root: f.root }).active()).items;
    const card = byKey(items, `input:${request.requestId}`)!;
    assert.equal(card.section, 'product');
    const action = card.actions.find((a) => a.id === 'answer') as {
      choices: { id: string; hint?: string }[];
    };
    assert.deepEqual(
      action.choices.map((c) => c.hint),
      shown.question.options.map((o) => o.forUser),
    );
    assert.ok(action.choices.every((c) => c.hint && /Пользователь/.test(c.hint)));
  } finally {
    await f.cleanup();
  }
});

test('the CLI lead (--by host) answers a technical question by the same engine rule: actor lead, basis technical', async () => {
  const { f, requestId } = await asked(undefined);
  try {
    const shown = f.service.show({ requestId }) as unknown as Shown;
    const reason = 'The checks read JSON today.';
    f.service.answer({ requestId, ...answer, reason, expectedVersion: shown.version }, 'host');
    const stored = executionOf(f.h).engine.inputRequest(requestId).answers.at(-1)!;
    assert.deepEqual(
      [stored.actor.kind, stored.basis, stored.reason],
      ['lead', 'technical', reason],
    );
  } finally {
    await f.cleanup();
  }
});

test('a lead answer saved before the rule on a question the owner decides is not applied; the owner answers again', async () => {
  const { f, taskId, requestId } = await asked(null);
  try {
    const shown = f.service.show({ requestId }) as unknown as Shown;
    // Запись прежней версии: ответ хоста движок не проверяет — так выглядит
    // ответ ведущего, сохранённый до обновления.
    executionOf(f.h).engine.answerInput(
      requestId,
      { ...answer, actor: { kind: 'host' } },
      shown.version,
    );
    const [held] = f.service.list({ taskId }).requests;
    assert.equal(held.state, 'answer-saved');
    assert.equal(held.actor, 'operator');
    assert.match(held.next, /the operator answers in the panel/);
    const digest = 'a'.repeat(64);
    assert.equal(
      codeOf(() =>
        f.service.apply(
          {
            requestId,
            answerDigest: digest,
            expectedVersion: held.version,
            contextDigest: digest,
            targetDigest: digest,
          },
          'lead',
        ),
      ),
      '403:OPERATOR_ANSWERS',
    );
    // Карточка владельца с формой ответа.
    const items = (await new AttentionService(f.store, f.h, { root: f.root }).active()).items;
    const card = byKey(items, `input:${requestId}`)!;
    assert.equal(card.actor, 'operator');
    assert.ok(card.actions.some((a) => a.id === 'answer'));
    // Ответ владельца снимает удержание: дальше цепочку ведёт ведущий.
    f.service.answer({ requestId, ...answer, expectedVersion: held.version }, 'operator');
    const [after] = f.service.list({ taskId }).requests;
    assert.equal(after.actor, 'lead');
  } finally {
    await f.cleanup();
  }
});
