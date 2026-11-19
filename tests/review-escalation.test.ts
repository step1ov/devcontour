// Эскалация находки ревью (harness 0.1.0-alpha.54, протокол ревью §8):
// блокирующая находка, открытая три раунда подряд, останавливает следующий
// раунд до вызова reviewer; DevContour называет команду владельца, а решение
// `review-decide` уходит движку следующим раундом и снимается после него.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { inputReviewRounds, inputReviewSubject } from '../src/harness/input-host.ts';
import { executionOf } from '../src/harness/execution.ts';
import { pendingReviewDecisions, recordReviewDecision } from '../src/core/review-decisions.ts';

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
    // Решение владельца: принять ограничением; следующий раунд проходит.
    recordReviewDecision(f.store, {
      kind: 'plan',
      subject,
      findings: [finding.id],
      decision: 'accepted-limitation',
      reason: 'The owner accepts the acceptance wording as is.',
    });
    assert.equal(pendingReviewDecisions(f.store, 'plan', subject).length, 1);
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
    assert.deepEqual(pendingReviewDecisions(f.store, 'plan', subject), []);
  } finally {
    await f.cleanup();
  }
});
