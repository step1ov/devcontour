// Предложение ответа ведущего (F37): на вопрос с минимумом отвечает только
// оператор, ведущий предлагает ответ (`input_propose`), оператор подтверждает
// его одним действием — в запросе появляется ответ оператора с этим
// содержимым. Агентский API ответа оператора не пишет. Модели не вызываются:
// demo-исполнитель и управляемый reviewer ответа.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlled,
  inputDemos,
  inputFixture,
  untilQuestion,
  type InputFixture,
} from './input-fixture.ts';
import { AgentService } from '../src/application/agent.ts';
import { AttentionService } from '../src/application/attention.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { executionOf } from '../src/harness/execution.ts';
import { byKey, dumpDatabase } from './attention-fixture.ts';
import { join } from 'node:path';
import { taskOwner } from '../src/core/sync-state.ts';
import { DomainError } from '../src/core/model.ts';

after(() => inputDemos.close());

const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return `${e.status ?? '-'}:${e.code ?? '-'}`;
  }
};

async function question(f: InputFixture) {
  const { taskId, boardId } = f.askingTask();
  await untilQuestion(f, boardId);
  const [request] = f.service.list({ taskId }).requests;
  return { taskId, boardId, requestId: request.requestId, version: request.version };
}

const engineRequest = (f: InputFixture, id: string) => executionOf(f.h).engine.inputRequest(id);

test('A critical question: the lead proposes an answer, handoff names input_propose, the operator confirms it as the operator answer', async () => {
  const f = await inputFixture(controlled({ critical: true }));
  try {
    const { taskId, requestId, version } = await question(f);
    const agent = new AgentService(f.h, f.root);
    const run = (input: unknown) => agent.execute({ operation: 'input_propose', input });
    assert.deepEqual(f.service.show({ requestId }).floors, ['declared']);

    // Шаг передачи: не «ждите», а предложение ответа с версией запроса.
    const before = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(before.action, 'answer-input');
    assert.equal(before.code, 'answer-operator');
    assert.deepEqual(before.params, { floors: ['declared'], version, proposed: false });
    assert.match(
      before.detail,
      /input_propose \{"requestId": "IR-[a-f0-9]+", "expectedVersion": \d+/,
    );
    assert.doesNotMatch(before.detail, /Wait:/);
    assert.match(f.service.list({ taskId }).requests[0].next, /input_propose/);

    const proposal = {
      requestId,
      text: 'Keep the registered contract: return JSON as now.',
      optionId: 'json',
      reasoning: 'The registered API contract fixes JSON and the accepted file already returns it.',
      expectedVersion: version,
    };
    // Проверки входа и права — до записи.
    assert.equal(await codeOf(() => run({ ...proposal, reasoning: 'short' })), '400:-');
    assert.equal(await codeOf(() => run({ ...proposal, optionId: 'nope' })), '400:-');
    assert.equal(await codeOf(() => run({ ...proposal, optionId: '' })), '400:-');
    assert.equal(
      await codeOf(() => run({ ...proposal, expectedVersion: version + 1 })),
      '409:REVISION_CONFLICT',
    );
    // Актёр задаёт транспорт: поле actor во входе не принимается.
    assert.equal(await codeOf(() => run({ ...proposal, actor: 'operator' })), '400:-');
    assert.equal(
      await codeOf(() => f.service.propose(proposal, 'operator')),
      '403:OPERATOR_ANSWERS',
    );
    assert.equal(f.service.show({ requestId }).proposal, undefined);

    const saved = run(proposal) as { proposalDigest: string; changed: boolean; nextStep: string };
    assert.equal(saved.changed, true);
    assert.match(saved.nextStep, /never answer this question yourself/);
    // Повтор того же содержимого — без новой записи.
    assert.equal((run(proposal) as { changed: boolean }).changed, false);
    // Предложение — не ответ: запрос harness без ответов, ждёт оператора.
    assert.equal(engineRequest(f, requestId).answers.length, 0);
    const listed = f.service.list({ taskId }).requests[0];
    assert.equal(listed.state, 'awaiting-answer');
    assert.equal(listed.actor, 'operator');
    assert.equal(listed.proposal?.digest, saved.proposalDigest);
    assert.match(listed.next, /confirms the lead's proposed answer/);
    const shown = f.service.show({ requestId });
    assert.equal(shown.proposal?.current, true);
    assert.equal(shown.proposal?.text, proposal.text);
    assert.equal(shown.proposal?.reasoning, proposal.reasoning);
    assert.equal(shown.proposal?.by, 'lead');

    const waiting = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(waiting.code, 'answer-operator');
    assert.equal((waiting.params as { proposed: boolean }).proposed, true);
    assert.match(waiting.detail, /proposed answer waits for the operator/);

    // Агентский API подтверждения не имеет; ответ и снятие — по-прежнему 403.
    assert.equal(
      await codeOf(() =>
        agent.execute({
          operation: 'input_confirm_proposal' as never,
          input: { requestId, proposalDigest: saved.proposalDigest, expectedVersion: version },
        }),
      ),
      '400:-',
    );
    assert.equal(
      await codeOf(() =>
        agent.execute({
          operation: 'input_answer',
          input: { requestId, text: proposal.text, expectedVersion: version },
        }),
      ),
      '403:OPERATOR_ANSWERS',
    );

    // Новое предложение заменяет прежнее: подтверждение прежнего — 409.
    const replaced = run({ ...proposal, optionId: undefined, kind: 'clarification' }) as {
      proposalDigest: string;
    };
    assert.notEqual(replaced.proposalDigest, saved.proposalDigest);
    assert.equal(
      await codeOf(() =>
        f.service.confirmProposalInTask(taskId, requestId, {
          proposalDigest: saved.proposalDigest,
          expectedVersion: version,
        }),
      ),
      '409:PROPOSAL_CHANGED',
    );
    const final = run(proposal) as { proposalDigest: string };
    assert.equal(final.proposalDigest, saved.proposalDigest);

    // Подтверждение оператора — ответ оператора с содержимым предложения.
    const confirmed = f.service.confirmProposalInTask(taskId, requestId, {
      proposalDigest: final.proposalDigest,
      expectedVersion: version,
    });
    assert.equal(confirmed.proposalDigest, final.proposalDigest);
    const answers = engineRequest(f, requestId).answers;
    assert.equal(answers.length, 1);
    assert.equal(answers[0].actor.kind, 'operator');
    assert.equal(answers[0].text, proposal.text);
    assert.equal(answers[0].optionId, 'json');
    assert.equal(answers[0].kind, 'clarification');
    assert.ok(answers[0].messageRef, 'ответ записан сообщением обсуждения оператора');
    const after = f.service.show({ requestId });
    assert.equal(after.state, 'answer-saved');
    assert.equal(after.actor, 'lead');
    assert.equal(after.proposal, undefined, 'запись предложения снята');
    // Происхождение ответа — в журнале: подтверждено предложение ведущего.
    const events = f.store
      .allEvents()
      .filter((e) => e.type === 'input.proposal-confirmed') as unknown as {
      data: { requestId: string; proposalDigest: string; proposedBy: string; messageId: string };
    }[];
    assert.equal(events.length, 1);
    assert.deepEqual(
      [events[0].data.requestId, events[0].data.proposalDigest, events[0].data.proposedBy],
      [requestId, final.proposalDigest, 'lead'],
    );
    assert.equal(events[0].data.messageId, answers[0].messageRef);
    // Повторное нажатие — тот же ответ (replayed), второго ответа и события нет.
    const again = f.service.confirmProposalInTask(taskId, requestId, {
      proposalDigest: final.proposalDigest,
      expectedVersion: after.version,
    }) as { replayed?: boolean; messageId: string };
    assert.equal(again.replayed, true);
    assert.equal(again.messageId, answers[0].messageRef);
    assert.equal(engineRequest(f, requestId).answers.length, 1);
    assert.equal(
      f.store.allEvents().filter((e) => e.type === 'input.proposal-confirmed').length,
      1,
    );
    // Ответ сохранён: предложение больше не принимается.
    assert.equal(
      await codeOf(() => run({ ...proposal, expectedVersion: after.version })),
      '409:NOT_READY',
    );
  } finally {
    await f.cleanup();
  }
});

test('A question the lead may answer itself is refused with LEAD_ANSWERS; an operator answer makes a proposal stale', async () => {
  const f = await inputFixture(controlled());
  try {
    const { requestId, version } = await question(f);
    const proposal = {
      requestId,
      text: 'Use JSON.',
      reasoning: 'The contract decides the format of the response.',
      expectedVersion: version,
    };
    assert.equal(await codeOf(() => f.service.propose(proposal, 'lead')), '409:LEAD_ANSWERS');
    assert.equal(await codeOf(() => f.service.propose(proposal, 'host')), '409:LEAD_ANSWERS');
  } finally {
    await f.cleanup();
  }
  const g = await inputFixture(controlled({ critical: true }));
  try {
    const { taskId, requestId, version } = await question(g);
    const saved = g.service.propose(
      {
        requestId,
        text: 'Use JSON.',
        reasoning: 'The contract decides the format of the response.',
        expectedVersion: version,
      },
      'host',
    );
    assert.equal(g.service.show({ requestId }).proposal?.by, 'host');
    // Оператор ответил иначе: предложение устарело, подтвердить его нельзя.
    g.service.answerInTask(taskId, requestId, { text: 'Use YAML.', expectedVersion: version });
    const shown = g.service.show({ requestId });
    assert.equal(shown.proposal?.current, false);
    assert.equal(g.service.list({ taskId }).requests[0].proposal, undefined);
    assert.equal(
      await codeOf(() =>
        g.service.confirmProposalInTask(taskId, requestId, {
          proposalDigest: saved.proposalDigest,
          expectedVersion: shown.version,
        }),
      ),
      '409:REVISION_CONFLICT',
    );
    assert.equal(engineRequest(g, requestId).answers.at(-1)?.text, 'Use YAML.');
  } finally {
    await g.cleanup();
  }
});

test('Attention card: «Подтвердить ответ ведущего» first, the proposal in the prompt; the action saves the operator answer', async () => {
  // Режим operator: на вопрос без минимумов тоже отвечает оператор.
  const f = await inputFixture(controlled(), { approvalMode: 'operator' });
  try {
    const { requestId, version } = await question(f);
    const items = async () =>
      (await new AttentionService(f.store, f.h, { root: f.root }).active()).items;
    const key = `input:${requestId}`;
    const plain = byKey(await items(), key)!;
    assert.deepEqual(
      plain.actions.filter((a) => a.kind === 'domain').map((a) => a.id),
      ['answer'],
    );
    const text = 'Return JSON as the contract fixes.';
    const reasoning = 'The registered contract and the accepted file both return JSON.';
    f.service.propose(
      { requestId, text, optionId: 'json', reasoning, expectedVersion: version },
      'lead',
    );
    const card = byKey(await items(), key)!;
    assert.equal(card.actor, 'operator');
    assert.notEqual(card.sourceVersion, plain.sourceVersion, 'предложение — новая версия карточки');
    assert.deepEqual(
      card.actions.filter((a) => a.kind === 'domain').map((a) => a.id),
      ['confirm-proposal', 'answer'],
    );
    const confirm = card.actions[0] as { label: string; input?: string; prompt?: string };
    assert.equal(confirm.label, 'Подтвердить ответ ведущего');
    assert.equal(confirm.input, 'confirm');
    assert.ok(confirm.prompt?.includes(text), confirm.prompt);
    assert.ok(confirm.prompt?.includes(reasoning), confirm.prompt);
    assert.match(card.reason, /Ведущий предлагает ответ/);
    await new AttentionService(f.store, f.h, { root: f.root }).act({
      sourceKey: card.sourceKey,
      occurrenceId: card.occurrenceId,
      expectedVersion: card.sourceVersion,
      action: 'confirm-proposal',
      input: {},
    });
    const answers = engineRequest(f, requestId).answers;
    assert.equal(answers.length, 1);
    assert.equal(answers[0].actor.kind, 'operator');
    assert.equal(answers[0].text, text);
    assert.equal(answers[0].optionId, 'json');
    const answered = byKey(await items(), key)!;
    assert.equal(answered.actor, 'lead');
    assert.equal(
      answered.actions.some((a) => a.id === 'confirm-proposal'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

const reasoning = 'The registered contract and the accepted file both decide this answer.';

test('Confirm guards: a wrong expectedVersion alone is refused; a failed write keeps the proposal and writes no answer', async () => {
  const f = await inputFixture(controlled({ critical: true }));
  try {
    const { taskId, requestId, version } = await question(f);
    const saved = f.service.propose(
      { requestId, text: 'Use JSON.', optionId: 'json', reasoning, expectedVersion: version },
      'lead',
    );
    // Digest верный, предложение текущее — отказ только по версии.
    assert.equal(
      await codeOf(() =>
        f.service.confirmProposalInTask(taskId, requestId, {
          proposalDigest: saved.proposalDigest,
          expectedVersion: version + 1,
        }),
      ),
      '409:REVISION_CONFLICT',
    );
    // Сбой внутри транзакции после ответа и снятия записи: всё откатывается.
    const original = f.store.appendEvent.bind(f.store);
    f.store.appendEvent = ((type: string, ...rest: unknown[]) => {
      if (type === 'input.proposal-confirmed') throw new Error('fixture: journal unavailable');
      return (original as (...a: unknown[]) => unknown)(type, ...rest);
    }) as typeof f.store.appendEvent;
    try {
      assert.throws(
        () =>
          f.service.confirmProposalInTask(taskId, requestId, {
            proposalDigest: saved.proposalDigest,
            expectedVersion: version,
          }),
        /journal unavailable/,
      );
    } finally {
      f.store.appendEvent = original;
    }
    assert.equal(engineRequest(f, requestId).answers.length, 0);
    const kept = f.service.show({ requestId });
    assert.equal(kept.proposal?.current, true);
    assert.equal(kept.proposal?.digest, saved.proposalDigest);
    // После сбоя подтверждение проходит.
    f.service.confirmProposalInTask(taskId, requestId, {
      proposalDigest: saved.proposalDigest,
      expectedVersion: version,
    });
    assert.equal(engineRequest(f, requestId).answers.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('A requirement-change proposal is confirmed as a requirement-change operator answer', async () => {
  const f = await inputFixture(controlled({ critical: true }));
  try {
    const { taskId, requestId, version } = await question(f);
    const saved = f.service.propose(
      {
        requestId,
        text: 'Switch the artifact to YAML; the spec changes.',
        optionId: 'yaml',
        kind: 'requirement-change',
        reasoning,
        expectedVersion: version,
      },
      'lead',
    );
    f.service.confirmProposalInTask(taskId, requestId, {
      proposalDigest: saved.proposalDigest,
      expectedVersion: version,
    });
    const [answer] = engineRequest(f, requestId).answers;
    assert.equal(answer.kind, 'requirement-change');
    assert.equal(answer.actor.kind, 'operator');
    assert.equal(answer.optionId, 'yaml');
    assert.equal(f.service.show({ requestId }).state, 'answer-saved');
  } finally {
    await f.cleanup();
  }
});

test('Review rejected: the lead proposes a correction; confirming it supersedes the operator answer message', async () => {
  const f = await inputFixture(controlled({ critical: true, verdict: { approve: false } }));
  try {
    const { taskId, requestId, version } = await question(f);
    const first = f.service.answerInTask(taskId, requestId, {
      text: 'Use YAML.',
      expectedVersion: version,
    });
    const context = await f.service.context({ requestId });
    const review = await f.service.review({
      requestId,
      contextDigest: context.contextDigest,
      authorRuntime: 'codex',
    });
    assert.equal(review.approved, false);
    const rejected = f.service.show({ requestId });
    assert.equal(rejected.state, 'review-rejected');
    assert.equal(rejected.actor, 'operator');
    assert.match(rejected.next, /input_propose/);
    const handoff = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(handoff.code, 'apply-rejected');
    assert.deepEqual(
      [
        (handoff.params as { operatorAnswers?: boolean }).operatorAnswers,
        (handoff.params as { proposed?: boolean }).proposed,
      ],
      [true, false],
    );
    assert.match(handoff.detail, /input_propose/);
    const saved = f.service.propose(
      {
        requestId,
        text: 'Use JSON as the contract fixes.',
        optionId: 'json',
        reasoning,
        expectedVersion: rejected.version,
      },
      'lead',
    );
    assert.match(f.service.show({ requestId }).next, /confirms the lead's proposed correction/);
    assert.equal(
      (devcontourHandoff(f.h, {}).host.next!.params as { proposed?: boolean }).proposed,
      true,
    );
    const confirmed = f.service.confirmProposalInTask(taskId, requestId, {
      proposalDigest: saved.proposalDigest,
      expectedVersion: rejected.version,
    }) as { messageId: string };
    const answers = engineRequest(f, requestId).answers;
    assert.equal(answers.length, 2);
    assert.deepEqual(
      answers.map((a) => a.actor.kind),
      ['operator', 'operator'],
    );
    assert.equal(answers[1].text, 'Use JSON as the contract fixes.');
    const task = f.store.read().tasks.find((t) => t.id === taskId)!;
    const message = f.store.discussionById(taskOwner(task), confirmed.messageId) as {
      supersedes?: string;
    };
    assert.equal(message.supersedes, first.messageId);
    assert.equal(f.service.show({ requestId }).state, 'answer-saved');
  } finally {
    await f.cleanup();
  }
});

test('Attention card: a long or masked proposal is not confirmable from the card; a stale card writes nothing', async () => {
  const f = await inputFixture(controlled({ critical: true }));
  try {
    const { requestId, version } = await question(f);
    const service = () => new AttentionService(f.store, f.h, { root: f.root });
    const key = `input:${requestId}`;
    const domain = async () => {
      const card = byKey((await service().active()).items, key)!;
      return { card, ids: card.actions.filter((a) => a.kind === 'domain').map((a) => a.id) };
    };
    const propose = (text: string, kind?: 'requirement-change') =>
      f.service.propose(
        { requestId, text, reasoning, expectedVersion: version, ...(kind ? { kind } : {}) },
        'lead',
      );
    // 2500 знаков: карточка показала бы усечённый текст — подтверждения нет.
    propose('J'.repeat(2500));
    const long = await domain();
    assert.deepEqual(long.ids, ['answer']);
    assert.match(long.card.reason, /подтвердите его в карточке задачи/);
    // Маскируемый секрет: показан под маской — подтверждения нет.
    propose('Clone https://deploy:s3cr3t-fixture@example.invalid/repo.git and keep JSON.');
    const masked = await domain();
    assert.deepEqual(masked.ids, ['answer']);
    assert.doesNotMatch(JSON.stringify(masked.card), /s3cr3t-fixture/);
    // Изменение требований видно в строке причины.
    propose('Switch to YAML.', 'requirement-change');
    const change = await domain();
    assert.deepEqual(change.ids, ['confirm-proposal', 'answer']);
    assert.match(change.card.reason, /^Ведущий предлагает ответ \(изменение требований\)/);
    // Карточка, показанная до замены предложения, устарела: ничего не пишется.
    propose('Keep JSON.');
    const before = dumpDatabase(join(f.root, 'state.sqlite'));
    await assert.rejects(
      service().act({
        sourceKey: change.card.sourceKey,
        occurrenceId: change.card.occurrenceId,
        expectedVersion: change.card.sourceVersion,
        action: 'confirm-proposal',
        input: {},
      }),
      (e: unknown) =>
        e instanceof DomainError && e.status === 409 && e.details?.code === 'attention-stale',
    );
    assert.equal(dumpDatabase(join(f.root, 'state.sqlite')), before);
    assert.equal(engineRequest(f, requestId).answers.length, 0);
  } finally {
    await f.cleanup();
  }
});
