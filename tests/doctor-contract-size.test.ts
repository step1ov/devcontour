import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTRACT_CONTENT_MAX, CONTRACT_CONTENT_WARN, type Contract } from '../src/core/model.ts';
import { contractSizeChecks, doctor } from '../src/runner/doctor.ts';
import { config } from './helpers.ts';

const contract = (id: string, chars: number, extra: Partial<Contract> = {}): Contract => ({
  id,
  title: `Контракт ${id}`,
  content: 'x'.repeat(chars),
  digest: `d-${id}`,
  approvedAt: '2026-11-01T00:00:00.000Z',
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
  const near = checks[0];
  assert.match(near.detail, /^Контракт C-near \(Контракт C-near, docs\/contracts\/api\.md\): /);
  assert.match(near.detail, /54 000 знаков из 60 000 допустимых \(осталось 6 000\)/);
  assert.match(near.detail, /файл-продолжение/);
  assert.match(checks[1].detail, /осталось 0/);
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

test('уже зарегистрированный контракт сверх предела: doctor не пишет «не будет зарегистрирован»', () => {
  const [check] = contractSizeChecks([contract('C-over', CONTRACT_CONTENT_MAX + 100)]);
  assert.equal(check?.status, 'degraded');
  assert.match(check.detail, /60 100 знаков при пределе 60 000, длиннее на 100/);
  assert.match(
    check.detail,
    /зарегистрирован и действует, но следующая его редакция будет отклонена до ревью/,
  );
  assert.doesNotMatch(check.detail, /не будет зарегистрирован|ревью не начато/);
});

test('doctor() показывает contract-size по состоянию и готовность не снимает', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-contract-size-'));
  try {
    // Роли demo: остальные проверки doctor не зовут внешних runtime.
    const c = config();
    const leader = { owner: 'server', leaseUntil: Date.now() + 60000 };
    const run = async (contracts: Contract[]) =>
      doctor(c, root, false, { leader, runs: [], contracts });
    const without = await run([]);
    const near = await run([contract('C-near', CONTRACT_CONTENT_WARN)]);
    assert.equal(
      without.checks.some((x) => x.id.startsWith('contract-size:')),
      false,
    );
    const check = near.checks.find((x) => x.id === 'contract-size:C-near');
    assert.equal(check?.status, 'degraded', JSON.stringify(near.checks.map((x) => x.id)));
    assert.equal(near.ready, without.ready);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
