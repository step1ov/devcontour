import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACT_CONSOLIDATE_MIN,
  CONTRACT_CONTENT_CONSOLIDATE,
  CONTRACT_CONTENT_MAX,
  CONTRACT_CONTENT_WARN,
  type Contract,
} from '../src/core/model.ts';
import { contractSize } from '../src/runner/agent-control.ts';
import { contractForkChecks, contractSizeChecks, doctor } from '../src/runner/doctor.ts';
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
    contract('C-small', CONTRACT_CONTENT_CONSOLIDATE - 1),
    contract('C-mid', CONTRACT_CONTENT_CONSOLIDATE),
    contract('C-near', CONTRACT_CONTENT_WARN, { source: 'docs/contracts/api.md' }),
    contract('C-full', CONTRACT_CONTENT_MAX),
  ];
  const checks = contractSizeChecks(contracts);
  assert.deepEqual(
    checks.map((c) => [c.id, c.status]),
    [
      ['contract-size:C-mid', 'passed'],
      ['contract-size:C-near', 'degraded'],
      ['contract-size:C-full', 'degraded'],
    ],
  );
  // От 75 % предела — совет консолидировать, без продолжения.
  assert.match(checks[0].detail, /45 000 знаков из 60 000 допустимых, больше 75 % предела/);
  assert.match(checks[0].detail, /contract-change --consolidate/);
  assert.doesNotMatch(checks[0].detail, /файл-продолжение/);
  const near = checks[1];
  assert.match(near.detail, /^Контракт C-near \(Контракт C-near, docs\/contracts\/api\.md\): /);
  assert.match(near.detail, /54 000 знаков из 60 000 допустимых \(осталось 6 000\)/);
  // Сначала консолидация, затем продолжение.
  assert.match(near.detail, /--consolidate[\s\S]*файл-продолжение/);
  assert.match(checks[2].detail, /осталось 0/);
});

test('doctor не предупреждает о заменённой редакции контракта', () => {
  // Более поздняя редакция того же файла заменяет прежнюю: предупреждение —
  // только по действующей.
  const source = 'docs/contracts/api.md';
  const old = contract('C-api-1', CONTRACT_CONTENT_WARN + 100, { source });
  // Порядок редакций — по ссылке previous, а не по позиции в реестре.
  const current = contract('C-api-2', 1000, { source, previous: old.id });
  assert.deepEqual(contractSizeChecks([old, current]), []);
  assert.deepEqual(contractSizeChecks([current, old]), []);
  // Записи без ссылок — по времени утверждения: более поздняя действует.
  const later = contract('C-api-0', CONTRACT_CONTENT_WARN + 100, {
    source,
    approvedAt: '2026-11-02T00:00:00.000Z',
  });
  assert.deepEqual(
    contractSizeChecks([later, contract('C-api-3', 1000, { source })]).map((c) => c.id),
    ['contract-size:C-api-0'],
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
  assert.match(check.detail, /--consolidate[\s\S]*файл-продолжение/);
});

test('F20: the size refusal of a proposal names consolidation first, continuation second; 75 % gives a hint', () => {
  const over = contractSize('x'.repeat(CONTRACT_CONTENT_MAX + 1));
  assert.match(
    over.refusal ?? '',
    /не будет зарегистрирован[\s\S]*--consolidate[\s\S]*файл-продолжение/,
  );
  const mid = contractSize('x'.repeat(CONTRACT_CONTENT_CONSOLIDATE));
  assert.equal(mid.warning, undefined);
  assert.match(mid.hint ?? '', /--consolidate/);
  assert.equal(contractSize('x'.repeat(CONTRACT_CONTENT_CONSOLIDATE - 1)).hint, undefined);
});

test('F20: doctor suggests a consolidation after six amendments of a large document since the first registration or the last consolidation', () => {
  const source = 'docs/contracts/api.md';
  const redactions = (n: number, prefix = 'C-', chars = CONTRACT_CONSOLIDATE_MIN) =>
    Array.from({ length: n }, (_, i) => contract(`${prefix}${i + 1}`, chars, { source }));
  const ids = (cs: Contract[]) => contractSizeChecks(cs).map((c) => c.id);
  // Первая регистрация — не поправка: шесть редакций — пять поправок.
  assert.deepEqual(ids(redactions(6)), []);
  const seven = redactions(7);
  const [check] = contractSizeChecks(seven);
  assert.equal(check?.id, 'contract-consolidate:C-7');
  assert.equal(check.status, 'degraded');
  assert.match(check.detail, /6 поправок документа с последней консолидации/);
  assert.match(check.detail, /contract-change --consolidate/);
  // Короткий документ с поправками на месте — без совета.
  assert.deepEqual(ids(redactions(7, 'S-', CONTRACT_CONSOLIDATE_MIN - 1)), []);
  // Консолидация обнуляет счёт; дальше считаются только смысловые редакции.
  const consolidated = contract('C-8', CONTRACT_CONSOLIDATE_MIN, {
    source,
    previous: 'C-7',
    consolidates: { from: 'C-7', review: 'R' },
  });
  assert.deepEqual(ids([...seven, consolidated]), []);
  assert.deepEqual(ids([...seven, consolidated, ...redactions(5, 'D-')]), []);
  assert.deepEqual(ids([...seven, consolidated, ...redactions(6, 'D-')]), [
    'contract-consolidate:D-6',
  ]);
  // Другой документ того же компонента не входит в счёт.
  const other = Array.from({ length: 4 }, (_, i) =>
    contract(`O-${i}`, CONTRACT_CONSOLIDATE_MIN, { source: 'docs/contracts/other.md' }),
  );
  assert.deepEqual(ids([...redactions(4), ...other]), []);
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

test('F20 R2-M1: doctor names a fork of a contract document with both amendments and the winner', () => {
  const source = 'docs/contracts/api.md';
  const p = contract('C-p', 1000, { source });
  const m1 = contract('C-m1', 1000, {
    source,
    previous: 'C-p',
    approvedAt: '2026-11-02T00:00:00.000Z',
  });
  const m2 = contract('C-m2', 1000, {
    source,
    previous: 'C-p',
    approvedAt: '2026-11-03T00:00:00.000Z',
  });
  assert.deepEqual(contractForkChecks([p, m1]), []);
  const [check] = contractForkChecks([p, m1, m2]);
  assert.equal(check?.id, 'contract-fork:main:docs/contracts/api.md');
  assert.equal(check.status, 'degraded');
  assert.match(
    check.detail,
    /редакции C-m1, C-m2 параллельно поправили одну редакцию C-p; действует C-m2/,
  );
});

test('F20 R3-M1: the merging redaction doctor asks for clears the fork warning', () => {
  const source = 'docs/contracts/api.md';
  const p = contract('C-p', 1000, { source });
  const m1 = contract('C-m1', 1000, {
    source,
    previous: 'C-p',
    approvedAt: '2026-11-02T00:00:00.000Z',
  });
  const m2 = contract('C-m2', 1000, {
    source,
    previous: 'C-p',
    approvedAt: '2026-11-03T00:00:00.000Z',
  });
  assert.equal(contractForkChecks([p, m1, m2]).length, 1);
  const merged = contract('C-merge', 1000, {
    source,
    previous: 'C-m2',
    approvedAt: '2026-11-04T00:00:00.000Z',
  });
  assert.deepEqual(contractForkChecks([p, m1, m2, merged]), []);
});

test('F50: size and consolidation advice only for a contract that open work is bound to', () => {
  const source = 'docs/contracts/journal.md';
  // Документ у предела, с шестью поправками: оба совета на действующей редакции.
  const chain = Array.from({ length: 7 }, (_, i) =>
    contract(`J-${i + 1}`, CONTRACT_CONTENT_WARN, { source }),
  );
  const task = (id: string, status: string, contracts: string[]) => ({ id, status, contracts });
  const ids = (tasks: ReturnType<typeof task>[]) =>
    contractSizeChecks(chain, tasks as never).map((c) => c.id);
  const both = ['contract-size:J-7', 'contract-consolidate:J-7'];
  // Все задачи по документу приняты или отменены: исторический журнал,
  // поправлять его некому — советы doctor не держат degraded.
  assert.deepEqual(ids([task('T-1', 'done', ['J-2']), task('T-2', 'cancelled', ['J-7'])]), []);
  // Открытая или черновая задача на любой редакции документа — советы есть.
  for (const status of ['draft', 'ready', 'running', 'failed'])
    assert.deepEqual(
      ids([task('T-1', 'done', ['J-7']), task('T-3', status, ['J-3'])]),
      both,
      status,
    );
  // Задачи на другом контракте не делают этот документ действующим.
  const other = contract('O-1', 1000, { source: 'docs/contracts/other.md' });
  assert.deepEqual(
    contractSizeChecks([...chain, other], [
      task('T-1', 'done', ['J-7']),
      task('T-4', 'ready', ['O-1']),
    ] as never).map((c) => c.id),
    [],
  );
  // Контракт без единой привязанной задачи — только что зарегистрирован под
  // следующий этап: консолидировать его до привязки дешевле всего.
  assert.deepEqual(ids([]), both);
});

test('F50: doctor() drops the advice of a contract whose bound tasks are all accepted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-contract-size-'));
  try {
    const c = config();
    const leader = { owner: 'server', leaseUntil: Date.now() + 60000 };
    const tasks = [{ id: 'T-1', status: 'done', contracts: ['C-near'] }];
    const report = await doctor(c, root, false, {
      leader,
      runs: [],
      tasks,
      contracts: [contract('C-near', CONTRACT_CONTENT_WARN)],
    } as never);
    assert.equal(
      report.checks.some((x) => x.id === 'contract-size:C-near'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F50 r1: a fresh redaction without its own tasks keeps the advice, a consolidation keeps the binding', () => {
  const source = 'docs/contracts/journal.md';
  const chain = Array.from({ length: 7 }, (_, i) =>
    contract(`J-${i + 1}`, CONTRACT_CONTENT_WARN, { source }),
  );
  const ids = (cs: Contract[], tasks: unknown[]) =>
    contractSizeChecks(cs, tasks as never).map((c) => c.id);
  // Принятые задачи — только на прежней редакции; J-7 зарегистрирована под
  // следующий этап и задач ещё не имеет: консолидировать её дешевле всего.
  assert.deepEqual(ids(chain, [{ id: 'T-1', status: 'done', contracts: ['J-2'] }]), [
    'contract-size:J-7',
    'contract-consolidate:J-7',
  ]);
  // Консолидация J-7 равносильна ей: принятая задача на J-7 закрывает и её.
  const consolidated = contract('J-8', CONTRACT_CONTENT_WARN, {
    source,
    previous: 'J-7',
    consolidates: { from: 'J-7', review: 'R' },
  });
  assert.deepEqual(
    ids([...chain, consolidated], [{ id: 'T-1', status: 'done', contracts: ['J-7'] }]),
    [],
  );
  // Без задач на J-7 консолидация по-прежнему получает совет о размере.
  assert.deepEqual(
    ids([...chain, consolidated], [{ id: 'T-1', status: 'done', contracts: ['J-2'] }]),
    ['contract-size:J-8'],
  );
});

test('F50 r1: bound tasks are counted per component; a missing repositoryId is main', () => {
  const source = 'docs/contracts/api.md';
  const main = contract('M-1', CONTRACT_CONTENT_WARN, { source });
  const mainExplicit = contract('M-1', CONTRACT_CONTENT_WARN, { source, repositoryId: 'main' });
  const lib = contract('L-1', CONTRACT_CONTENT_WARN, { source, repositoryId: 'lib' });
  const ids = (cs: Contract[], tasks: unknown[]) =>
    contractSizeChecks(cs, tasks as never).map((c) => c.id);
  // main закрыт принятой задачей, открытая задача — только у lib.
  const tasks = [
    { id: 'T-1', status: 'done', contracts: ['M-1'] },
    { id: 'T-2', status: 'ready', contracts: ['L-1'] },
  ];
  assert.deepEqual(ids([main, lib], tasks), ['contract-size:L-1']);
  assert.deepEqual(ids([mainExplicit, lib], tasks), ['contract-size:L-1']);
  // Наоборот: lib закрыт, main открыт.
  assert.deepEqual(
    ids(
      [main, lib],
      [
        { id: 'T-1', status: 'ready', contracts: ['M-1'] },
        { id: 'T-2', status: 'done', contracts: ['L-1'] },
      ],
    ),
    ['contract-size:M-1'],
  );
});

test('F50 r1: malformed task records do not break doctor; a bound task without status is open', () => {
  const c = contract('C-near', CONTRACT_CONTENT_WARN);
  const ids = (tasks: unknown[]) => contractSizeChecks([c], tasks as never).map((x) => x.id);
  const done = { id: 'T-1', status: 'done', contracts: ['C-near'] };
  assert.deepEqual(ids([done, { id: 'T-2', status: 'ready' }]), []);
  assert.deepEqual(ids([done, { id: 'T-3', status: 'ready', contracts: 'C-near' }]), []);
  assert.deepEqual(ids([done, { id: 'T-4', contracts: ['C-near'] }]), ['contract-size:C-near']);
  assert.deepEqual(ids([null, done]), []);
});
