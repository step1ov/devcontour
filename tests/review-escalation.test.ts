// Эскалация находки ревью (harness 0.1.0-alpha.54, протокол ревью §8):
// блокирующая находка, открытая три раунда подряд, останавливает следующий
// раунд до вызова reviewer; DevContour называет команду владельца, а решение
// `review-decide` уходит движку следующим раундом и снимается после него.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { inputReviewRounds, inputReviewSubject } from '../src/harness/input-host.ts';
import { executionOf } from '../src/harness/execution.ts';
import {
  clearReviewDecisions,
  pendingReviewDecisions,
  recordReviewDecision,
} from '../src/core/review-decisions.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { closePrevious, fixture } from './helpers.ts';
import type { AgentAdapter } from '../src/runner/adapters.ts';

after(() => inputDemos.close());

test('three rounds with the same blocking finding stop the fourth before the reviewer; the owner decision lets the next round run', async () => {
  const prompts: string[] = [];
  const verdict = { approve: false };
  const f = await inputFixture(controlled({ verdict, prompts }));
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
    for (let i = 0; i < 3; i++) assert.equal((await review()).approved, false);
    assert.equal(reviews(), 3);
    const subject = inputReviewSubject(requestId);
    const [finding] = executionOf(f.h)
      .engine.read((v) => inputReviewRounds(v, requestId))
      .at(-1)!
      .findings.filter((x) => x.status === 'open');
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
    const lastFindings = () =>
      executionOf(f.h)
        .engine.read((v) => inputReviewRounds(v, requestId))
        .at(-1)!.findings;
    // Чужая или неизвестная находка — отказ записи, а не отравленный раунд.
    assert.throws(
      () =>
        recordReviewDecision(
          f.store,
          {
            kind: 'plan',
            subject,
            findings: ['b'.repeat(64)],
            decision: 'continue',
            reason: 'wrong id',
          },
          lastFindings(),
        ),
      /не найдена/,
    );
    assert.throws(
      () =>
        recordReviewDecision(
          f.store,
          {
            kind: 'plan',
            subject: 'input-IR-unknown',
            findings: [finding.id],
            decision: 'continue',
            reason: 'wrong subject',
          },
          undefined,
        ),
      /раундов нет/,
    );
    // Решение владельца: принять ограничением; следующий раунд проходит.
    const decision = {
      kind: 'plan' as const,
      subject,
      findings: [finding.id],
      decision: 'accepted-limitation' as const,
      reason: 'The owner accepts the acceptance wording as is.',
    };
    recordReviewDecision(f.store, decision, lastFindings());
    assert.equal(pendingReviewDecisions(f.store, 'plan', subject, lastFindings()).length, 1);
    // Раунд, не применивший решение (ответ вне протокола), его не снимает;
    // решение с другим содержанием (правка во время раунда) — тоже.
    const [used] = pendingReviewDecisions(f.store, 'plan', subject, lastFindings());
    clearReviewDecisions(f.store, 'plan', subject, [used], { round: 9, findings: lastFindings() });
    assert.equal(pendingReviewDecisions(f.store, 'plan', subject, lastFindings()).length, 1);
    const decidedRound = {
      round: 9,
      findings: lastFindings().map((x) =>
        x.id === finding.id
          ? {
              ...x,
              disposition: {
                decision: used.decision,
                by: 'operator' as const,
                reason: used.reason,
                round: 9,
                rounds: 3,
              },
            }
          : x,
      ),
    };
    clearReviewDecisions(
      f.store,
      'plan',
      subject,
      [{ ...used, reason: 'older reason' }],
      decidedRound,
    );
    assert.equal(pendingReviewDecisions(f.store, 'plan', subject, lastFindings()).length, 1);
    verdict.approve = true;
    assert.equal((await review()).approved, true);
    assert.equal(reviews(), 4);
    const last = executionOf(f.h)
      .engine.read((v) => inputReviewRounds(v, requestId))
      .at(-1)!;
    const decided = last.findings.find((x) => x.id === finding.id)!;
    assert.equal(decided.status, 'withdrawn');
    assert.equal(decided.disposition?.decision, 'accepted-limitation');
    assert.equal(decided.disposition?.by, 'operator');
    // Записанный раунд снимает решение.
    assert.deepEqual(pendingReviewDecisions(f.store, 'plan', subject, decidedRound.findings), []);
    assert.equal(
      f.store.localEntries('review-decisions').length,
      0,
      'the stored decision is removed, not only filtered',
    );
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
    const engine = executionOf(f.h).engine;
    const last = engine.reviews('contract', subject).at(-1)!.findings;
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
