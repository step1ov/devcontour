import { test } from 'node:test';
import assert from 'node:assert/strict';

test('A malformed reproduction is dropped without losing the review verdict', async () => {
  const { reviewResult } = await import('../src/runner/adapters.ts');
  const finding = (reproduction: unknown) => ({
    severity: 'blocking',
    message: 'Overflow is not representable',
    path: null,
    line: null,
    rule: 'feasibility',
    consequence: null,
    evidence: null,
    reproduction,
  });
  // Ревью контракта без run_check описывает свой запуск в run длинным текстом.
  const parsed = reviewResult.parse({
    approved: false,
    summary: 'Blocking feasibility',
    discoveries: [],
    findings: [
      finding({
        property: null,
        input: '{}',
        expected: null,
        actual: null,
        command: null,
        executed: true,
        run: 'Локальный Node-запуск через -e, exitCode 0: input accepted: true; output accepted: false; finite sum: false.',
      }),
      finding({ input: 'x'.repeat(9000), executed: 'yes' }),
    ],
  });
  assert.equal(parsed.approved, false);
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].rule, 'feasibility');
  assert.match(parsed.findings[0].reproduction?.run ?? '', /Локальный/);
  assert.equal(parsed.findings[1].reproduction, null, 'негодное воспроизведение отброшено');
});
