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

test('a cancelled question drops the escalation card and the owner step: its answer is no longer reviewed', async () => {
  const prompts: string[] = [];
  const runtimes = controlled({ verdict: { approve: false }, prompts });
  const f = await inputFixture(runtimes);
  try {
    const { boardId, taskId } = f.askingTask('Cancelled asking task');
    await untilQuestion(f, boardId);
    const [request] = f.service.list({ taskId }).requests;
    f.service.answer(
      {
        requestId: request.requestId,
        text: 'Use JSON as now.',
        optionId: 'json',
        reason: 'The checks read JSON today.',
        expectedVersion: request.version,
      },
      'lead',
    );
    const { contextDigest } = await f.service.context({ requestId: request.requestId });
    for (let i = 0; i < 3; i++)
      await f.service.review({
        requestId: request.requestId,
        contextDigest,
        authorRuntime: 'codex',
      });
    const attention = new AttentionService(f.store, f.h);
    const cards = async () => (await attention.active()).items.filter((i) => i.source === 'review');
    assert.equal((await cards()).length, 1);
    assert.equal(devcontourHandoff(f.h, {}).host.next?.code, 'review-escalated');
    const [current] = f.service.list({ taskId }).requests;
    f.service.cancel(
      {
        requestId: request.requestId,
        reason: 'The owner dropped the question.',
        expectedVersion: current.version,
      },
      'operator',
    );
    assert.deepEqual(await cards(), []);
    assert.notEqual(devcontourHandoff(f.h, {}).host.next?.code, 'review-escalated');
  } finally {
    await f.cleanup();
  }
});

test('long findings: the card decides only the findings it shows in full, a stale card is refused, operator mode still names the owner step, and accept-limitation withdraws the findings', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    let calls = 0;
    const long = (n: number) => `Finding ${n}: ` + 'missing error state detail '.repeat(45);
    const make = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute(r) {
        calls++;
        const done = calls > 3;
        return Promise.resolve({
          data: {
            approved: done,
            summary: 'Explicit test fixture',
            findings: done ? [] : [1, 2].map((n) => ({ severity: 'blocking', message: long(n) })),
            previous: done ? closePrevious(r.prompt) : [],
          },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        });
      },
    });
    const runtimes = { codex: make('codex'), claude: make('claude') };
    const proposal = { title: 'Orders API v1', content: 'POST /orders creates an order.' };
    for (let i = 0; i < 3; i++)
      await assert.rejects(reviewContract(f.h, f.root, proposal, 'codex', runtimes));
    const attention = new AttentionService(f.store, f.h);
    const card = async () => (await attention.active()).items.find((i) => i.source === 'review');
    const first = (await card())!;
    const prompt = first.actions.find((a) => a.kind === 'domain' && a.prompt)!;
    assert.ok(prompt.kind === 'domain');
    // Вторая находка в предел текста не вошла: о ней — числом, решения по ней нет.
    assert.ok(prompt.prompt!.includes(long(1).trim()), 'the first finding is shown in full');
    assert.ok(!prompt.prompt!.includes('Finding 2:'), prompt.prompt);
    assert.match(prompt.prompt!, /ещё находок: 1 — решение по ним предложит следующая карточка/);
    assert.ok(prompt.prompt!.length <= 2000);
    // Режим operator: общий шаг не прячет решение владельца.
    f.h.config.approvalMode = 'operator';
    assert.equal(devcontourHandoff(f.h, {}).host.next?.code, 'review-escalated');
    f.h.config.approvalMode = 'agent';
    const act = (c: typeof first, action: string, text: string) =>
      attention.act({
        sourceKey: c.sourceKey,
        occurrenceId: c.occurrenceId,
        expectedVersion: c.sourceVersion,
        action,
        input: { text },
      });
    await act(first, 'accept-limitation', 'The owner accepts the first finding.');
    const subject = first.subject.id.split(':')[1];
    const last = () => executionOf(f.h).engine.reviews('contract', subject).at(-1)!;
    const [one, two] = last().findings;
    assert.deepEqual(
      pendingReviewDecisions(f.store, 'contract', subject, last()).map((d) => d.finding),
      [one.id],
    );
    // Вторая находка — следующее появление карточки; прежняя карточка устарела.
    const second = (await card())!;
    assert.notEqual(second.occurrenceId, first.occurrenceId);
    assert.ok(second.actions.some((a) => a.kind === 'domain' && a.prompt?.includes('Finding 2:')));
    await assert.rejects(
      act(first, 'accept-limitation', 'A stale decision.'),
      (e: DomainError) => e.status === 409,
    );
    assert.equal(
      pendingReviewDecisions(f.store, 'contract', subject, last()).length,
      1,
      'the stale card wrote nothing',
    );
    await act(second, 'accept-limitation', 'The owner accepts the second finding.');
    assert.equal(await card(), undefined);
    const r = await reviewContract(f.h, f.root, proposal, 'codex', runtimes);
    assert.equal(r.status, 'approved');
    for (const id of [one.id, two.id]) {
      const x = last().findings.find((y) => y.id === id)!;
      assert.equal(x.status, 'withdrawn');
      assert.equal(x.disposition?.decision, 'accepted-limitation');
      assert.equal(x.disposition?.by, 'operator');
    }
  } finally {
    f.cleanup();
  }
});

test('a finding longer than the card gets no panel decision: the card names the owner command instead of deciding unseen text', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const huge = 'Oversized finding: ' + 'the error states are undefined '.repeat(110);
    const make = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute: () =>
        Promise.resolve({
          data: {
            approved: false,
            summary: 'Explicit test fixture',
            findings: [{ severity: 'blocking', message: huge }],
            previous: [],
          },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        }),
    });
    const runtimes = { codex: make('codex'), claude: make('claude') };
    const proposal = { title: 'Huge API v1', content: 'GET /huge.' };
    for (let i = 0; i < 3; i++)
      await assert.rejects(reviewContract(f.h, f.root, proposal, 'codex', runtimes));
    const attention = new AttentionService(f.store, f.h);
    const card = (await attention.active()).items.find((i) => i.source === 'review')!;
    assert.ok(card);
    assert.ok(huge.length > 2000);
    assert.deepEqual(
      card.actions.filter((a) => a.kind === 'domain'),
      [],
      'no decision over text the card cannot show',
    );
    const command = card.actions.find((a) => a.kind === 'handoff');
    assert.ok(command?.kind === 'handoff');
    assert.match(command.command, /^devcontour review-decide --kind contract --subject "contract-/);
    assert.match(command.command, /review\.json$/);
    assert.match(card.reason, /не помещается в карточку/);
    await assert.rejects(
      attention.act({
        sourceKey: card.sourceKey,
        occurrenceId: card.occurrenceId,
        expectedVersion: card.sourceVersion,
        action: 'accept-limitation',
        input: { text: 'Trying anyway.' },
      }),
      (e: DomainError) => e.status === 400,
    );
    assert.equal(f.store.localEntries('review-decisions').length, 0);
  } finally {
    f.cleanup();
  }
});
