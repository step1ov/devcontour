import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractEvals } from '../src/runner/contract-evals.ts';

test('The contract feasibility corpus scores false rejections and misses separately and says when judgement was not measured', async () => {
  // Без live модель не вызывается, и отчёт это говорит прямо.
  const protocol = await contractEvals();
  assert.equal(protocol.mode, 'contract-fixture');
  assert.equal(protocol.judgementMeasured, false);
  assert.equal(protocol.passed, true);
  assert.deepEqual(protocol.summary, {
    correct: 5,
    falseRejections: 0,
    missed: 0,
    recorded: 1,
    unverified: 0,
  });

  // Ревьюер, отклоняющий всё по выполнимости, — ложные отказы, а не успех.
  const strict = await contractEvals({}, () => ({ approved: false, feasibility: true }));
  assert.equal(strict.summary.falseRejections, 2);
  assert.equal(strict.summary.missed, 0);
  assert.equal(strict.passed, false);

  // Ревьюер, одобряющий всё, пропускает невыполнимые обязательства.
  const lenient = await contractEvals({}, () => ({ approved: true, feasibility: false }));
  assert.equal(lenient.summary.missed, 3);
  assert.equal(lenient.passed, false);

  // Отказ без находки класса feasibility — не обнаружение невыполнимости.
  const vague = await contractEvals({}, () => ({ approved: false, feasibility: false }));
  assert.equal(vague.summary.missed, 3);
  assert.equal(vague.summary.falseRejections, 0);

  await assert.rejects(contractEvals({ runtime: 'codex' }), /reviewer model/);
  await assert.rejects(contractEvals({ reviewerModel: 'm' }), /live runtime/);
});
