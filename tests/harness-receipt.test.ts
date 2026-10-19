import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Task } from '../src/core/model.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, digest } from '../src/core/service.ts';
import { effectiveChecks } from '../src/core/checks.ts';
import { receiptSchema, type CompletionReceipt } from '../src/core/sync-model.ts';
import { validateReceipt } from '../src/core/sync-state.ts';
import { receiptFields } from '../src/harness/receipt.ts';

// Правила формата receipt Git-синхронизации — продукт; приёмка по receipt —
// получатель harness. Компоненты: lib ← app ← web; задача app проверяется
// потребителем web.
const sha = (c: string) => c.repeat(40);
const gate = (id: string) => ({
  id,
  kind: 'test' as const,
  command: ['node', id + '.mjs'],
  report: { type: 'junit' as const, path: `.reports/${id}.xml` },
});
const repo = (id: string, dependsOn: string[] = []) => ({
  id,
  name: id,
  path: '/tmp/' + id,
  dependsOn,
  gates: [gate(id === 'web' ? 'e2e' : 'test')],
});

function domain(writer: 'codex' | 'claude' = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-receipt-'));
  const config = configSchema.parse({
    version: 1,
    name: 'Receipts',
    repository: '/tmp/app',
    mode: 'local',
    roles: { qa: { runtime: writer } },
    reviewer: { runtime: writer === 'codex' ? 'claude' : 'codex' },
    gates: [gate('test')],
    repositories: [repo('lib'), repo('app', ['lib']), repo('web', ['app'])],
  });
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  return {
    h,
    store,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function approvedTask(d: ReturnType<typeof domain>): Task {
  const board = d.h.createBoard('Receipts', '', 'app');
  const task = d.h.addTask(board.id, {
    title: 'Provider change',
    description: 'Наблюдаемый результат проверяется потребителем.',
    role: 'qa',
    repositoryId: 'app',
    dependsOn: [],
    acceptance: ['The consumer still works.'],
    consumers: [{ repositoryId: 'web', gates: ['e2e'] }],
  });
  d.h.approve(board.id, undefined, {
    actor: 'agent',
    authorRuntime: 'claude',
    reviewerRuntime: 'codex',
  });
  return d.store.read().tasks.find((t) => t.id === task.id)!;
}

/** Receipt нового формата: наблюдение входов, закрепление области, обе фазы и потребитель. */
function receiptOf(t: Task): CompletionReceipt {
  const policyDigest = digest('policy');
  const effective = effectiveChecks(t, policyDigest);
  const check = (
    kind: 'test' | 'review',
    phase: 'candidate' | 'integration',
    gateId: string,
    consumer?: string,
  ) => ({
    kind,
    phase,
    sha: phase === 'candidate' ? sha('c') : sha('b'),
    gate: gateId,
    ...(consumer ? { consumer } : {}),
    passed: true,
    exitCode: 0,
    digest: digest(gateId),
    checks: effective,
  });
  return receiptSchema.parse({
    id: 'R-receipt',
    taskId: t.id,
    repositoryId: 'app',
    specDigest: t.approvedDigest,
    scopeDigest: t.approvedScope,
    policyDigest,
    candidateSha: sha('c'),
    resultSha: sha('b'),
    finishedAt: '2026-01-01T00:00:00.000Z',
    runtime: 'codex',
    reviewer: 'claude',
    requiredGates: ['test'],
    checks: [
      check('test', 'candidate', 'test'),
      check('review', 'candidate', 'independent-review'),
      check('test', 'integration', 'test'),
      check('review', 'integration', 'independent-review'),
      check('test', 'integration', 'e2e', 'web'),
    ],
    consumers: [
      {
        repositoryId: 'web',
        gates: ['e2e'],
        sha: sha('d'),
        tree: sha('d'),
        dependencies: [
          { repositoryId: 'lib', sha: sha('1'), tree: sha('1'), artifacts: [] },
          { repositoryId: 'app', sha: sha('b'), tree: sha('2'), artifacts: [] },
        ],
        freshness: [
          { repositoryId: 'lib', snapshot: sha('1'), head: sha('1'), fresh: true },
          // Голова потребителя ушла вперёд: устарело, описано правдиво.
          { repositoryId: 'web', snapshot: sha('d'), head: sha('e'), fresh: false },
        ],
        observedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    dependencies: [
      { repositoryId: 'lib', sha: sha('1'), tree: sha('1'), head: sha('3'), artifacts: [] },
    ],
    checkVersion: { effective },
  });
}

/**
 * Receipt прежнего формата: закрепления области нет, свежесть потребителей не
 * наблюдалась (снимок своих зависимостей с головами уже записывался).
 */
function legacyOf(t: Task) {
  const r = structuredClone(receiptOf(t));
  delete r.scopeDigest;
  for (const c of r.consumers!) {
    delete c.freshness;
    delete c.observedAt;
  }
  return r;
}

/** Ещё более ранний receipt задачи без потребителей: снимка зависимостей нет. */
function earliestOf(d: ReturnType<typeof domain>) {
  const board = d.h.createBoard('Earliest', '', 'app');
  const added = d.h.addTask(board.id, {
    title: 'Earliest change',
    description: 'Результат прежней версии без снимка входов.',
    role: 'qa',
    repositoryId: 'app',
    dependsOn: [],
    acceptance: ['The result is checked.'],
  });
  d.h.approve(board.id, undefined, {
    actor: 'agent',
    authorRuntime: 'claude',
    reviewerRuntime: 'codex',
  });
  const t = { ...d.store.read().tasks.find((x) => x.id === added.id)!, approvedScope: undefined };
  const r = structuredClone(receiptOf(t));
  delete r.scopeDigest;
  delete r.dependencies;
  delete r.consumers;
  r.checks = r.checks.filter((c) => !c.consumer);
  return { t, r };
}

test('Receipt нового формата и прежнего (входы не наблюдались) принимаются получателем harness', () => {
  const d = domain();
  try {
    const t = approvedTask(d);
    const contracts = d.store.read().contracts;
    validateReceipt(d.h, receiptOf(t), t, contracts);
    // Задача утверждена до закрепления области: receipt прежнего формата.
    const legacyTask = { ...t, approvedScope: undefined };
    validateReceipt(d.h, legacyOf(t), legacyTask, contracts);
    const earliest = earliestOf(d);
    validateReceipt(d.h, earliest.r, earliest.t, contracts);
    // Записанные снимки сверяются и в прежнем формате.
    const partial = structuredClone(earliest.r);
    partial.dependencies = [];
    assert.throws(
      () => validateReceipt(d.h, partial, earliest.t, contracts),
      /снимки зависимостей \[\] — ожидались ровно \[lib\]/,
    );
  } finally {
    d.close();
  }
});

test('Правила формата receipt: неполное наблюдение, область без наблюдения, снимок без головы и пропуск снимка — отказ', () => {
  const d = domain();
  try {
    const t = approvedTask(d);
    const contracts = d.store.read().contracts;
    const legacyTask = { ...t, approvedScope: undefined };
    const variants: [string, Task, (r: CompletionReceipt) => void, RegExp][] = [
      [
        'свежесть без момента наблюдения',
        t,
        (r) => delete r.consumers![0].observedAt,
        /нового формата неполна/,
      ],
      [
        'закрепление области без наблюдения',
        t,
        (r) => {
          delete r.consumers![0].freshness;
          delete r.consumers![0].observedAt;
        },
        /нового формата неполна/,
      ],
      [
        'наблюдение записано пустым',
        t,
        (r) => (r.consumers![0].freshness = []),
        /потребитель web: свежесть \[\]/,
      ],
      ['новый формат без снимка зависимостей', t, (r) => delete r.dependencies, /нет снимка/],
      ['снимок без головы ветки', t, (r) => delete r.dependencies![0].head, /нет головы ветки/],
      [
        'область закреплена не та',
        t,
        (r) => (r.scopeDigest = digest('other')),
        /область проверок не соответствует/,
      ],
      [
        'другая постановка',
        t,
        (r) => (r.specDigest = digest('other')),
        /не соответствует постановке/,
      ],
      [
        'прежний формат: потребитель проверен не на результате',
        legacyTask,
        (r) => (r.consumers![0].dependencies[1].sha = sha('a')),
        /не против интегрированного результата/,
      ],
      [
        'прежний формат: снимок потребителя без зависимости lib',
        legacyTask,
        (r) => r.consumers![0].dependencies.shift(),
        /потребитель web: снимки зависимостей \[app\] — ожидались ровно \[lib, app\]/,
      ],
    ];
    for (const [name, task, change, pattern] of variants) {
      const r = structuredClone(task === t ? receiptOf(t) : legacyOf(t));
      change(r);
      assert.throws(() => validateReceipt(d.h, r, task, contracts), pattern, name);
    }
  } finally {
    d.close();
  }
});

test('Receipt подтверждает записанное назначение: смена writer роли после приёмки не отменяет его; вендор сверяется', () => {
  const before = domain('codex');
  const after = domain('claude');
  try {
    const t = approvedTask(before);
    const receipt = receiptOf(t);
    validateReceipt(before.h, receipt, t, []);
    // Тот же receipt в клоне, где роль теперь пишет claude, а ревьюирует codex.
    validateReceipt(after.h, receipt, t, []);
    const same = structuredClone(receipt);
    same.reviewer = 'codex';
    assert.throws(() => validateReceipt(after.h, same, t, []), /того же вендора/);
  } finally {
    before.close();
    after.close();
  }
});

test('Таблица полей receipt называет источник каждого поля переносимого результата', () => {
  for (const [field, [source, basis]] of Object.entries(receiptFields)) {
    assert.ok(['receipt', 'receiver', 'fixed'].includes(source), field);
    assert.ok(basis.length > 0, field);
  }
});
