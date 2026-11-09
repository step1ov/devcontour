import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_CONTENT_MAX, CONTRACT_CONTENT_WARN, type Contract } from '../src/core/model.ts';
import { contractSizeChecks } from '../src/runner/doctor.ts';

const contract = (id: string, chars: number, extra: Partial<Contract> = {}): Contract => ({
  id,
  title: `Контракт ${id}`,
  content: 'x'.repeat(chars),
  digest: `d-${id}`,
  ...extra,
});

test('doctor предупреждает о действующем контракте у предела размера, готовность не снимает', () => {
  const contracts = [
    contract('C-small', CONTRACT_CONTENT_WARN - 1),
    contract('C-near', CONTRACT_CONTENT_WARN, { source: 'docs/contracts/api.md' }),
    contract('C-full', CONTRACT_CONTENT_MAX),
  ];
  const checks = contractSizeChecks(contracts);
  assert.deepEqual(
    checks.map((c) => [c.id, c.status]),
    [
      ['contract-size:C-near', 'degraded'],
      ['contract-size:C-full', 'degraded'],
    ],
  );
  const near = checks[0]!;
  assert.match(near.detail, /^Контракт C-near \(Контракт C-near, docs\/contracts\/api\.md\): /);
  assert.match(near.detail, /54 000 знаков из 60 000 допустимых \(осталось 6 000\)/);
  assert.match(near.detail, /файл-продолжение/);
  assert.match(checks[1]!.detail, /осталось 0/);
});

test('doctor не предупреждает о заменённой редакции контракта', () => {
  // Более поздняя редакция того же файла заменяет прежнюю: предупреждение —
  // только по действующей.
  const source = 'docs/contracts/api.md';
  const old = contract('C-api-1', CONTRACT_CONTENT_WARN + 100, { source });
  const current = contract('C-api-2', 1000, { source });
  assert.deepEqual(contractSizeChecks([old, current]), []);
  assert.deepEqual(
    contractSizeChecks([current, old]).map((c) => c.id),
    ['contract-size:C-api-1'],
  );
});
