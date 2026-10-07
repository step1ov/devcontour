import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence } from '../src/core/model.ts';
import { git } from '../src/runner/process.ts';
import { corpusWitness, propertyCoverage, type PropertyReport } from '../src/core/property.ts';
import {
  check,
  checkProject,
  commit,
  fixture,
  knap,
  propertyGate,
  reach,
  removeRoot,
} from './check-fixture.ts';

// Проверка, которая лжёт кодом выхода и JUnit: зелёный testcase на каждое
// заявленное свойство и отчёт свойств, заданный аргументом.
const liar = `import { writeFileSync } from 'node:fs';
const variant = process.argv[2];
const id = 'knapsack-optimal';
const ok = (testId, cases, families) => ({ testId, status: 'passed', cases, ...(families ? { families } : {}) });
const full = { boundary: 30, adversarial: 30 };
const reports = {
  zero: [ok(id, 0)],
  empty: [],
  missing: [ok('reach-complete', 200, { boundary: 20 })],
  duplicate: [ok(id, 200, full), ok(id, 200, full)],
  foreign: [ok(id, 200, full)],
  family: [ok(id, 200, { boundary: 5, adversarial: 30 })],
  few: [ok(id, 7, full)],
  truncated: [ok(id, 200, full)],
  masked: [ok(id + '-' + (process.env.SECRET ?? ''), 200, full)],
};
const names = {
  foreign: ['knapsack-optimal-extra'],
  truncated: Array.from({ length: 2001 }, (_, i) => 'case-' + i).concat([id]),
  masked: [id + '-' + (process.env.SECRET ?? '')],
}[variant] ?? [id, 'reach-complete'];
writeFileSync(process.env.DEVCONTOUR_PROPERTY_REPORT, JSON.stringify({ version: 1, properties: reports[variant] }));
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,
  '<testsuite>' + names.map((n) => '<testcase name="' + n + '"/>').join('') + '</testsuite>');
console.log('LIED ' + variant);
`;

async function runTask(
  f: Awaited<ReturnType<typeof fixture>>,
  title: string,
  task: { properties?: string[]; contracts?: string[] } = {},
) {
  const board = f.h.createBoard(title);
  const t = f.h.addTask(board.id, {
    title,
    description: 'Реализовать решение по договору проверки.',
    role: f.contract ? 'backend' : 'qa',
    contracts: f.contract ? [f.contract.id] : [],
    acceptance: ['AC-optimal'],
    writePaths: ['src/'],
    ...task,
  });
  f.h.approve(board.id);
  f.h.pause(false);
  await f.scheduler.drain();
  const run = f.store.read().runs.findLast((r) => r.taskId === t.id)!;
  return {
    task: f.store.read().tasks.find((x) => x.id === t.id)!,
    run,
    gate: run.evidence.find((e) => e.gate === 'properties') as Evidence,
  };
}

test('AC01: green JUnit and exit 0 with zero cases or an empty property list fail the gate before any review', async () => {
  const p = await checkProject({ 'liar.mjs': liar });
  const f = await fixture(p, {
    declaration: false,
    config: { gates: [propertyGate(['node', 'liar.mjs', 'zero'])], maxAttempts: 1 },
  });
  try {
    f.write('src/knap.mjs', knap.correct);
    const zero = await runTask(f, 'Zero cases');
    assert.equal(zero.gate.exitCode, 0);
    assert.equal(zero.gate.passed, false);
    assert.match(zero.gate.summary, /passed без единого проверенного входа/);
    assert.equal(zero.gate.property?.level, 'legacy');
    assert.deepEqual(zero.gate.property?.coverage, [
      'свойство knapsack-optimal: passed без единого проверенного входа',
    ]);
    // Отрицательное evidence сохранено вместе с логом и отчётом.
    assert.match(await readFile(zero.gate.log, 'utf8'), /LIED zero/);
    assert.equal(zero.gate.property?.report?.properties[0].cases, 0);

    f.h.config.gates = [propertyGate(['node', 'liar.mjs', 'empty'])];
    const empty = await runTask(f, 'Empty report');
    assert.equal(empty.gate.exitCode, 0);
    assert.equal(empty.gate.passed, false);
    assert.match(empty.gate.summary, /отчёт свойств пуст/);
    assert.equal(f.calls.review, 0, 'ревьюер не вызывался ни разу');
    assert.equal(f.calls.implementation, 2);
    assert.equal(zero.run.failureKind, 'gate');

    // Штатный harness с нулём входов сам отказывает: генератор не вызывается.
    await writeFile(join(p.repo, 'check.mjs'), check(0).replace(/cases: (30|20),/g, 'cases: 0,'));
    await commit(p.repo, 'zero cases');
    await git(p.repo, 'update-ref', 'refs/heads/devcontour/accepted', 'HEAD');
    f.h.config.gates = [propertyGate()];
    const stock = await runTask(f, 'Stock harness zero');
    assert.equal(stock.gate.passed, false);
    assert.notEqual(stock.gate.exitCode, 0);
    const entry = stock.gate.property?.report?.properties[0];
    assert.equal(entry?.status, 'failed');
    assert.match(entry?.error ?? '', /выборка пуста/);
    assert.equal(f.calls.review, 0);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC02: with a pinned manifest a missing, duplicate, foreign, short, truncated or masked property is never full coverage', async () => {
  const secret = 'coverage-secret-4471';
  process.env.DEVCONTOUR_TEST_COVERAGE_SECRET = secret;
  const p = await checkProject({ 'liar.mjs': liar });
  const f = await fixture(p, {
    config: {
      gates: [propertyGate(['node', 'liar.mjs', 'missing'])],
      maxAttempts: 1,
      environment: {
        inherit: ['PATH', 'HOME'],
        values: {},
        secrets: { SECRET: 'DEVCONTOUR_TEST_COVERAGE_SECRET' },
      },
    },
  });
  try {
    f.write('src/knap.mjs', knap.correct);
    const expected: Record<string, RegExp> = {
      missing: /обязательное свойство knapsack-optimal отсутствует в отчёте/,
      duplicate: /свойство knapsack-optimal указано в отчёте 2 раза/,
      foreign: /testcase knapsack-optimal отсутствует в JUnit/,
      family: /семейство boundary: проверено 5 входов из обязательных 30/,
      few: /проверено 7 входов из обязательных 100/,
      truncated: /список testcases обрезан/,
      masked: /обязательное свойство knapsack-optimal отсутствует в отчёте/,
    };
    for (const [variant, problem] of Object.entries(expected)) {
      f.h.config.gates = [propertyGate(['node', 'liar.mjs', variant])];
      const r = await runTask(f, 'Lie ' + variant, { properties: ['knapsack-optimal'] });
      assert.equal(r.gate.exitCode, 0, variant);
      assert.equal(r.gate.passed, false, `${variant}: ${r.gate.summary}`);
      assert.match(r.gate.summary, problem, variant);
      assert.equal(r.gate.property?.level, 'manifest');
      assert.deepEqual(r.gate.property?.manifest?.properties, ['knapsack-optimal']);
      assert.equal(JSON.stringify(r.gate).includes(secret), false, 'секрет замаскирован');
    }
    assert.equal(f.calls.review, 0);

    // Штатный harness и верная реализация: покрытие подтверждено.
    f.h.config.gates = [propertyGate()];
    const good = await runTask(f, 'Correct', { properties: ['knapsack-optimal'] });
    assert.equal(good.gate.passed, true, good.gate.summary);
    assert.equal(good.gate.property?.level, 'manifest');
    assert.equal(good.gate.property?.coverage, undefined);
    const entry = good.gate.property?.report?.properties;
    // Селектор области: проверено только свойство задачи, reach-complete не
    // запускался, хотя его реализация — заглушка.
    assert.deepEqual(
      entry?.map((x) => x.testId),
      ['knapsack-optimal'],
    );
    assert.deepEqual(entry?.[0].families, { boundary: 30, adversarial: 30 });
    assert.equal(entry?.[0].cases, 180);
  } finally {
    delete process.env.DEVCONTOUR_TEST_COVERAGE_SECRET;
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC03: failed and running reports keep negative diagnostics; legacy tasks keep their level and earlier runs stay unchanged', async () => {
  const p = await checkProject({
    'src/knap.mjs': knap.stub,
    // Зависает на первом же входе: ноль завершённых случаев.
    'hang.mjs': check().replace(
      "import { solve } from './src/knap.mjs';",
      'const solve = () => { for (;;) {} };',
    ),
  });
  const f = await fixture(p, {
    config: { gates: [propertyGate(['node', 'hang.mjs'], 3000)], maxAttempts: 1 },
  });
  try {
    f.write('src/knap.mjs', knap.correct);
    f.write('src/reach.mjs', reach.correct);
    const hung = await runTask(f, 'Hang', { properties: ['knapsack-optimal'] });
    assert.equal(hung.gate.passed, false);
    const entry = hung.gate.property?.report?.properties[0];
    assert.equal(entry?.status, 'running');
    assert.equal(entry?.cases, 0);
    assert.ok(entry?.current, 'вход, на котором шла проверка, сохранён');
    assert.equal(typeof hung.gate.property?.seed, 'number');
    assert.match(hung.gate.summary, /timeout/);
    const before = JSON.stringify(hung.run);

    // Отказ свойства с контрпримером — отрицательная диагностика, не недобор.
    f.h.config.gates = [propertyGate()];
    f.write('src/knap.mjs', knap.zeroWeight);
    const failed = await runTask(f, 'Zero weight', { properties: ['knapsack-optimal'] });
    assert.equal(failed.gate.passed, false);
    assert.match(failed.gate.summary, /свойство knapsack-optimal нарушено/);
    assert.equal(failed.gate.property?.coverage, undefined);

    // Задача без объявленных свойств — прежний уровень, названный явно.
    f.write('src/knap.mjs', knap.correct);
    const legacy = await runTask(f, 'Legacy');
    assert.equal(legacy.gate.passed, true, legacy.gate.summary);
    assert.equal(legacy.gate.property?.level, 'legacy');
    assert.equal(legacy.gate.property?.manifest, undefined);

    // Прежние завершённые записи не переписаны последующими прогонами.
    const after = f.store.read().runs.find((r) => r.id === hung.run.id)!;
    assert.equal(JSON.stringify(after), before);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('Coverage of a corpus is proven by its witness, not by a count', () => {
  const report = (corpus?: PropertyReport['corpus']): PropertyReport => ({
    version: 1,
    properties: [{ testId: 'p', status: 'passed', cases: 10 }],
    ...(corpus ? { corpus } : {}),
  });
  const manifest = {
    properties: [{ id: 'p', minCases: 1, families: [] }],
    corpus: {
      digest: 'a'.repeat(64),
      cases: [
        { id: 'c1', property: 'p' },
        { id: 'c2', property: 'p' },
      ],
    },
  };
  const all = corpusWitness([
    { id: 'c1', passed: true },
    { id: 'c2', passed: true },
  ]);
  assert.deepEqual(
    propertyCoverage(
      report({ digest: 'a'.repeat(64), executed: 2, passed: 2, witness: all, failed: [] }),
      manifest,
      undefined,
    ),
    [],
  );
  // Тот же счёт, но другой список случаев.
  const other = corpusWitness([
    { id: 'c1', passed: true },
    { id: 'c3', passed: true },
  ]);
  assert.match(
    propertyCoverage(
      report({ digest: 'a'.repeat(64), executed: 2, passed: 2, witness: other, failed: [] }),
      manifest,
      undefined,
    ).join(),
    /не все обязательные случаи корпуса/,
  );
  assert.match(propertyCoverage(report(), manifest, undefined).join(), /не выполнялся/);
  assert.match(
    propertyCoverage(
      report({ digest: 'b'.repeat(64), executed: 2, passed: 2, witness: all, failed: [] }),
      manifest,
      undefined,
    ).join(),
    /другой версии/,
  );
});
