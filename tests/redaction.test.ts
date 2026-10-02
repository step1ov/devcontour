import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactDeep, redactor } from '../src/runner/redaction.ts';

test('A redactor masks a secret in its raw, URL, JSON-escaped, double-escaped and XML forms', () => {
  const secret = 'pa"ss\\word\nline';
  const redact = redactor([secret]);
  const forms = [
    secret,
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1),
    secret.replace('"', '&quot;'),
  ];
  for (const form of forms)
    assert.equal(redact(`before ${form} after`), 'before [REDACTED] after', JSON.stringify(form));
  // Строка внутри JSON-документа — обычный путь утечки через отчёты.
  assert.equal(
    redact(JSON.stringify({ value: secret })).includes(JSON.stringify(secret).slice(1, -1)),
    false,
  );
});

test('redactDeep masks every string of a nested record and leaves other values intact', () => {
  const redact = redactor(['s3cr"t']);
  const masked = redactDeep(
    {
      command: ['node', 'check.mjs', 's3cr"t'],
      nested: { list: [{ message: 'got s3cr"t' }], count: 3, ok: true, none: null },
    },
    redact,
  );
  assert.deepEqual(masked, {
    command: ['node', 'check.mjs', '[REDACTED]'],
    nested: { list: [{ message: 'got [REDACTED]' }], count: 3, ok: true, none: null },
  });
  assert.equal(redactDeep('x', undefined), 'x');
});

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
