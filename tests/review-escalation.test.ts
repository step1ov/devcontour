// Эскалация находки ревью (harness 0.1.0-alpha.54, протокол ревью §8):
// блокирующая находка, открытая три раунда подряд, останавливает следующий
// раунд до вызова reviewer; DevContour называет команду владельца, а решение
// `review-decide` уходит движку следующим раундом и снимается после него.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { inputReviewSubject } from '../src/harness/input-host.ts';
import { executionOf } from '../src/harness/execution.ts';
import { pendingReviewDecisions, recordReviewDecision } from '../src/core/review-decisions.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { closePrevious, fixture } from './helpers.ts';
import type { AgentAdapter } from '../src/runner/adapters.ts';
import { AttentionService } from '../src/application/attention.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { decideReview } from '../src/application/review-escalations.ts';
import type { DomainError } from '../src/core/model.ts';

after(() => inputDemos.close());

test('three rounds with the same blocking finding stop the fourth before the reviewer; the owner decision survives a protocol-invalid round and is consumed by the next valid one', async () => {
  const prompts: string[] = [];
  const verdict = { approve: false };
  const runtimes = controlled({ verdict, prompts });
  const f = await inputFixture(runtimes);
  try {
    const { boardId, taskId } = f.askingTask('Asking task');
    await untilQuestion(f, boardId);
    const [request] = f.service.list({ taskId }).requests;
    const requestId = request.requestId;
    f.service.answer(
      {
        requestId,
        text: 'Use JSON as now.',
        optionId: 'json',
        reason: 'The checks read JSON today.',
        expectedVersion: request.version,
      },
      'lead',
    );
    const { contextDigest } = await f.service.context({ requestId });
    const review = () => f.service.review({ requestId, contextDigest, authorRuntime: 'codex' });
    const reviews = () => prompts.filter((p) => p.startsWith('review:')).length;
    const subject = inputReviewSubject(requestId);
    const last = () => executionOf(f.h).engine.reviews('plan', subject).at(-1);
    for (let i = 0; i < 3; i++) assert.equal((await review()).approved, false);
    assert.equal(reviews(), 3);
    const [finding] = last()!.findings.filter((x) => x.status === 'open');
    assert.ok(finding, 'the finding stays open');
    // Четвёртый раунд — отказ до вызова reviewer с командой владельца.
    await assert.rejects(review(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INPUT_REQUIRED');
      assert.match(error.message, /devcontour review-decide --kind plan/);
      assert.ok(error.message.includes(JSON.stringify(subject)), error.message);
      assert.ok(error.message.includes(finding.id), error.message);
      return true;
    });
    assert.equal(reviews(), 3, 'no paid round without the decision');
    // Карточка владельца: ответ исполнителю — раздел вопроса, ссылка на задачу.
    const card = (await new AttentionService(f.store, f.h).active()).items.find(
      (i) => i.source === 'review',
    );
    assert.ok(card, 'the escalation card of the answer review');
    assert.equal(card.actor, 'operator');
    assert.equal(card.section, 'development');
    assert.equal(card.subject.href, `/?view=boards&tab=list&task=${taskId}#input`);
    assert.match(card.title, /ответа на вопрос исполнителя по задаче «Asking task»/);
    // Шаг пакета ведущего — решение владельца, а не применение того же ответа.
    const next = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(next.code, 'review-escalated', JSON.stringify(next));
    assert.equal(next.input?.requestId, requestId);
    // Чужая или неизвестная находка, неизвестный предмет — отказ записи.
    const decision = {
      kind: 'plan' as const,
      subject,
      findings: [finding.id],
      decision: 'accepted-limitation' as const,
      reason: 'The owner accepts the acceptance wording as is.',
    };
    assert.throws(
      () => recordReviewDecision(f.store, { ...decision, findings: ['b'.repeat(64)] }, last()),
      /не найдена/,
    );
    assert.throws(
      () => recordReviewDecision(f.store, { ...decision, subject: 'input-IR-unknown' }, undefined),
      /раундов нет/,
    );
    recordReviewDecision(f.store, decision, last());
    assert.equal(pendingReviewDecisions(f.store, 'plan', subject, last()).length, 1);
    // Ответ reviewer вне протокола: раунд записан, решение не применено и
    // ждёт следующего раунда — владелец не решает заново.
    // Reviewer ответа — demo-адаптер фикстуры: подменяем его ответ ревью.
    const demo = runtimes.demo;
    const valid: typeof demo.execute = (r) => demo.execute(r);
    runtimes.demo = {
      ...runtimes.demo,
      execute: (r) =>
        r.review
          ? Promise.resolve({ data: { bogus: true }, log: 'Fixture only', command: ['fixture'] })
          : valid(r),
    };
    assert.equal((await review()).approved, false);
    assert.equal(reviews(), 3, 'the malformed fixture records no prompt');
    assert.equal(last()!.round, 4);
    assert.equal(last()!.findings.find((x) => x.id === finding.id)!.status, 'open');
    assert.equal(pendingReviewDecisions(f.store, 'plan', subject, last()).length, 1);
    // Следующий валидный раунд применяет решение и снимает его.
    runtimes.demo = demo;
    verdict.approve = true;
    assert.equal((await review()).approved, true);
    const decided = last()!.findings.find((x) => x.id === finding.id)!;
    assert.equal(decided.status, 'withdrawn');
    assert.equal(decided.disposition?.decision, 'accepted-limitation');
    assert.equal(decided.disposition?.by, 'operator');
    assert.equal(f.store.localEntries('review-decisions').length, 0);
    // Снятое решение не повторяется: на новом раунде его нет.
    assert.deepEqual(pendingReviewDecisions(f.store, 'plan', subject, last()), []);
  } finally {
    await f.cleanup();
  }
});

test('contract review: the same escalation stops the agent-control round; the owner continue decision lets it run again', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    let calls = 0;
    let blocking = true;
    const make = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute(r) {
        calls++;
        return Promise.resolve({
          data: {
            approved: !blocking,
            summary: 'Explicit test fixture',
            findings: blocking ? [{ severity: 'blocking', message: 'Missing behavior' }] : [],
            previous: blocking ? [] : closePrevious(r.prompt),
          },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        });
      },
    });
    const runtimes = { codex: make('codex'), claude: make('claude') };
    const proposal = { title: 'Catalog API v1', content: 'GET /products returns a list.' };
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        reviewContract(f.h, f.root, proposal, 'codex', runtimes),
        /Независимое ревью отклонено/,
      );
    assert.equal(calls, 3);
    let subject = '';
    let findingId = '';
    await assert.rejects(
      reviewContract(f.h, f.root, proposal, 'codex', runtimes),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'INPUT_REQUIRED');
        const m = /--subject ("(?:[^"\\]|\\.)*")/.exec(error.message);
        assert.ok(m, error.message);
        subject = JSON.parse(m[1]) as string;
        findingId = /Находки: ([a-f0-9]{64})/.exec(error.message)![1];
        return true;
      },
    );
    assert.equal(calls, 3, 'no paid round without the decision');
    const last = executionOf(f.h).engine.reviews('contract', subject).at(-1);
    recordReviewDecision(
      f.store,
      {
        kind: 'contract',
        subject,
        findings: [findingId],
        decision: 'continue',
        reason: 'The owner allows more rounds.',
      },
      last,
    );
    blocking = false;
    const r = await reviewContract(f.h, f.root, proposal, 'codex', runtimes);
    assert.equal(r.status, 'approved');
    assert.equal(calls, 4);
    assert.equal(f.store.localEntries('review-decisions').length, 0);
  } finally {
    f.cleanup();
  }
});

test('escalated contract review: an operator card in the architecture section, a read-only lead list, the owner step in host.next, and the card decision uses the review-decide rule', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    let calls = 0;
    const make = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute() {
        calls++;
        return Promise.resolve({
          data: {
            approved: false,
            summary: 'Explicit test fixture',
            findings: [{ severity: 'blocking', message: 'Missing error states' }],
            previous: [],
          },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        });
      },
    });
    const runtimes = { codex: make('codex'), claude: make('claude') };
    const proposal = { title: 'Catalog API v1', content: 'GET /products returns a list.' };
    const attention = new AttentionService(f.store, f.h);
    const cards = async () => (await attention.active()).items.filter((i) => i.source === 'review');
    for (let i = 0; i < 2; i++)
      await assert.rejects(reviewContract(f.h, f.root, proposal, 'codex', runtimes));
    // Два раунда — ещё не эскалация: карточки и шага нет.
    assert.deepEqual(await cards(), []);
    await assert.rejects(reviewContract(f.h, f.root, proposal, 'codex', runtimes));
    const [card] = await cards();
    assert.ok(card, 'the escalation card after the third round');
    assert.equal(card.actor, 'operator');
    assert.equal(card.category, 'decision');
    assert.equal(card.section, 'architecture');
    assert.match(card.title, /контракта «Catalog API v1»/);
    assert.match(card.reason, /три раунда подряд/);
    assert.match(card.reason, /Ведущий агент это решение не принимает/);
    const domain = card.actions.filter((a) => a.kind === 'domain');
    assert.deepEqual(
      domain.map((a) => [a.id, a.label, a.input]),
      [
        ['accept-limitation', 'Принять как ограничение', 'text'],
        ['continue', 'Продолжить исправлять', 'text'],
      ],
    );
    assert.match(domain[0].prompt ?? '', /1\. Missing error states \(открыта раундов: 3\)/);
    // Раздел «Архитектура»: фильтр раздела видит карточку, «Разработка» — нет.
    assert.equal((await attention.active({ section: 'architecture' })).items.length, 1);
    assert.ok(
      !(await attention.active({ section: 'development' })).items.some(
        (i) => i.source === 'review',
      ),
    );
    // Ведущий (attention_list, только чтение) видит карточку без действия.
    const lead = attention.agentList({ actor: 'operator' });
    const seen = lead.items.find((i) => i.source === 'review');
    assert.ok(seen);
    assert.ok(!seen.actions.some((a) => a.kind === 'domain'), JSON.stringify(seen.actions));
    // Шаг владельца в пакете ведущего называет карточку.
    const next = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(next.action, 'operator', JSON.stringify(next));
    assert.equal(next.code, 'review-escalated');
    const subject = (card.subject.id.split(':')[1] ?? '').trim();
    assert.deepEqual(next.params, { kind: 'contract', subject, findings: 1, round: 3 });
    assert.match(next.detail, /attention center card of this review/);
    // Ведущий решение не записывает — то же правило, что у review-decide.
    const findingId = executionOf(f.h).engine.reviews('contract', subject).at(-1)!.findings[0].id;
    assert.throws(
      () =>
        decideReview(
          f.h,
          {
            kind: 'contract',
            subject,
            findings: [findingId],
            decision: 'continue',
            reason: 'The lead wants more rounds.',
          },
          'lead',
        ),
      (e: DomainError) => e.status === 403,
    );
    const act = (action: string, text?: string) =>
      attention.act({
        sourceKey: card.sourceKey,
        occurrenceId: card.occurrenceId,
        expectedVersion: card.sourceVersion,
        action,
        ...(text !== undefined ? { input: { text } } : {}),
      });
    // Основание обязательно.
    await assert.rejects(act('continue', '  '), (e: DomainError) => e.status === 400);
    assert.equal(f.store.localEntries('review-decisions').length, 0);
    const done = await act('continue', 'The owner allows two more rounds.');
    assert.equal(done.resolved, true);
    const pending = pendingReviewDecisions(
      f.store,
      'contract',
      subject,
      executionOf(f.h).engine.reviews('contract', subject).at(-1),
    );
    assert.deepEqual(
      pending.map((d) => [d.finding, d.decision, d.by, d.reason]),
      [[findingId, 'continue', 'operator', 'The owner allows two more rounds.']],
    );
    // Решение записано: карточки и шага владельца нет, следующий раунд идёт.
    assert.deepEqual(await cards(), []);
    assert.notEqual(devcontourHandoff(f.h, {}).host.next?.code, 'review-escalated');
    assert.equal(calls, 3);
    await assert.rejects(reviewContract(f.h, f.root, proposal, 'codex', runtimes));
    assert.equal(calls, 4, 'the next paid round ran with the owner decision');
  } finally {
    f.cleanup();
  }
});
