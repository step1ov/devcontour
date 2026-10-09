import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input } from './helpers.ts';
import { declaration, propertyGate } from './check-fixture.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import {
  CheckCorpus,
  canonicalJson,
  localSuite,
  mergeSuites,
  configuredSpellings,
  localRoots,
  portableSuite,
  scrubLocalPaths,
  sha256,
} from '../src/core/check-store.ts';
import {
  corpusWitness,
  propertyCoverage,
  propertyFailure,
  propertyReport,
} from '../src/core/property.ts';
import { AgentService } from '../src/application/agent.ts';
import { completion, validateReceipt } from '../src/core/sync-state.ts';
import { receiptSchema } from '../src/core/sync-model.ts';

/**
 * Регрессии по находкам независимой приёмки: каждый тест воспроизводит
 * обход через настоящие Store и доменные операции и требует отказа.
 */
function domain() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-findings-'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config({ gates: [propertyGate()], maxAttempts: 8 }));
  const corpus = new CheckCorpus(h);
  const c = h.contract(
    'Check contract',
    'Pinned independent check fixture.',
    undefined,
    undefined,
    undefined,
    undefined,
    declaration(),
  );
  const add = (title: string, contract = c.id) => {
    const b = h.createBoard(title);
    const t = h.addTask(b.id, {
      ...input(title),
      contracts: [contract],
      properties: ['knapsack-optimal'],
    });
    h.approve(b.id);
    return { id: t.id, board: b.id };
  };
  const get = (id: string) => store.read().tasks.find((t) => t.id === id)!;
  const seed = (id: string, n: number, tasks: string[] = []) => {
    const ref = corpus.suiteFor(get(id), 'knapsack-optimal');
    const key = `finding-case-${n}-${Math.random().toString(36).slice(2)}`;
    const begun = corpus.begin(ref, key);
    const text = canonicalJson({ items: [{ w: 0, v: n }], cap: 0 });
    const result = corpus.record(
      corpus.get(ref.suite.id),
      key,
      begun.token!,
      {
        property: 'knapsack-optimal',
        input: text,
        inputHash: sha256(text),
        outcome: 'confirmed',
        reason: 'Deterministic confirmed fixture',
        source: { sha: 'a'.repeat(40), taskId: id },
        observed: {
          expected: String(n),
          actual: '0',
          equal: false,
          repeats: 2,
          durationsMs: [1, 1],
        },
        origin: { kind: 'agent' },
      },
      () => 'b'.repeat(40),
      { tasks, actor: 'agent' },
    );
    const recorded = result;
    if (recorded.pending) corpus.adopt(recorded.suite.id, recorded.pending.id);
    return { ...recorded, suite: corpus.get(recorded.suite.id) };
  };
  return {
    root,
    store,
    h,
    corpus,
    c,
    add,
    get,
    seed,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('F01: a failed or missing corpus case never passes, even with green properties and JUnit', () => {
  const digest = 'a'.repeat(64);
  const manifest = {
    properties: [{ id: 'p', minCases: 100, families: [] }],
    corpus: { digest, cases: [{ id: 'required', property: 'p' }] },
  };
  const junit = { cases: [{ id: 'p', status: 'passed' as const }], truncated: false };
  const contradicting = propertyReport.parse({
    version: 1,
    properties: [{ testId: 'p', status: 'passed', cases: 100 }],
    corpus: {
      digest,
      executed: 0,
      passed: 0,
      witness: '0'.repeat(64),
      failed: [{ id: 'unrelated', property: 'p' }],
    },
  });
  const coverage = propertyCoverage(contradicting, manifest, junit);
  assert.ok(
    coverage.some((p) => /не все обязательные случаи корпуса/.test(p)),
    coverage.join(),
  );
  assert.match(coverage.join(), /чужие случаи: unrelated/);
  assert.match(propertyFailure(contradicting), /случай корпуса unrelated свойства p провален/);
  // Настоящий провал обязательного случая при зелёном статусе свойства.
  const failedRequired = propertyReport.parse({
    version: 1,
    properties: [{ testId: 'p', status: 'passed', cases: 100 }],
    corpus: {
      digest,
      executed: 1,
      passed: 0,
      witness: corpusWitness([{ id: 'required', passed: false }]),
      failed: [{ id: 'required', property: 'p', expected: 5, actual: 0 }],
    },
  });
  assert.match(
    propertyCoverage(failedRequired, manifest, junit).join(),
    /случаи корпуса провалены: 1/,
  );
  assert.match(propertyFailure(failedRequired), /случай корпуса required/);
  // Полный корпус без провалов проходит.
  const ok = propertyReport.parse({
    version: 1,
    properties: [{ testId: 'p', status: 'passed', cases: 100 }],
    corpus: {
      digest,
      executed: 1,
      passed: 1,
      witness: corpusWitness([{ id: 'required', passed: true }]),
      failed: [],
    },
  });
  assert.deepEqual(propertyCoverage(ok, manifest, junit), []);
  assert.equal(propertyFailure(ok), '');
});

test('F02: a receipt with mixed check versions or without property manifests is refused', () => {
  const d = domain();
  try {
    const rt = d.add('Receipt manifest');
    d.h.pause(false);
    const run = d.h.claim('probe')!;
    d.h.phase(run.id, run.token, 'integrating', {
      candidateSha: 'a'.repeat(40),
      integrationSha: 'b'.repeat(40),
    });
    for (const phase of ['candidate', 'integration'] as const)
      for (const kind of ['test', 'review'] as const)
        d.h.evidence(run.id, run.token, {
          kind,
          phase,
          sha: (phase === 'candidate' ? 'a' : 'b').repeat(40),
          gate: kind === 'test' ? 'properties' : 'independent-review',
          passed: true,
          command: [],
          exitCode: 0,
          log: '',
          digest: 'c'.repeat(64),
          summary: 'fixture',
          ...(kind === 'test'
            ? {
                property: {
                  level: 'manifest' as const,
                  seed: 1,
                  reproduce: '',
                  contracts: {},
                  artifacts: [],
                  manifest: { digest: 'd'.repeat(64), properties: ['knapsack-optimal'] },
                },
              }
            : {}),
        });
    d.h.finish(run.id, run.token, 'b'.repeat(40));
    const done = d.get(rt.id);
    const receipt = completion(d.h, d.store.read(), done);
    receipt.runtime = 'codex';
    receipt.reviewer = 'claude';
    const contracts = d.store.read().contracts;
    validateReceipt(receiptSchema.parse(receipt), done, false, undefined, contracts);
    // Манифесты свойств удалены при сохранённой версии.
    const stripped = structuredClone(receipt);
    for (const check of stripped.checks) delete check.property;
    assert.throws(
      () => validateReceipt(receiptSchema.parse(stripped), done, false, undefined, contracts),
      /без манифеста свойств задачи/,
    );
    // Тесты под чужой версией, рядом — записи ревью с нужной версией.
    const mixed = structuredClone(receipt);
    for (const e of [...mixed.checks])
      if (e.kind === 'test') {
        e.checks = 'f'.repeat(64);
        mixed.checks.push({ ...e, kind: 'review', checks: mixed.checkVersion!.effective });
      }
    assert.throws(
      () => validateReceipt(receiptSchema.parse(mixed), done, false, undefined, contracts),
      /вид проверки не соответствует гейту|другой версией проверок/,
    );
    const versionOnly = structuredClone(receipt);
    for (const e of versionOnly.checks) if (e.kind === 'test') e.checks = 'f'.repeat(64);
    assert.throws(
      () => validateReceipt(receiptSchema.parse(versionOnly), done, false, undefined, contracts),
      /другой версией проверок/,
    );
  } finally {
    d.close();
  }
});

test('F03: after merging clones an adoption is addressed by digest; an ambiguous number is refused', () => {
  const d = domain();
  try {
    const t = d.add('Merged versions');
    const first = d.seed(t.id, 5);
    const a = portableSuite(d.corpus.get(first.suite.id));
    const reset = d.corpus.get(first.suite.id);
    reset.cases = {};
    reset.versions = [];
    reset.decisions = [];
    reset.operations = {};
    reset.pending = [];
    reset.adoptions = [];
    d.store.atomic(() => d.corpus.save(reset));
    const second = d.seed(t.id, 6);
    const merged = localSuite(mergeSuites(undefined, a, portableSuite(second.suite))!);
    d.store.atomic(() => d.corpus.save(merged));
    assert.deepEqual(
      merged.versions.map((v) => v.number),
      [1, 1],
    );
    const other = d.add('Adopt merged head');
    assert.throws(
      () =>
        d.corpus.request(
          merged.id,
          { number: 1 },
          [other.id],
          'agent',
          'Принять неоднозначный номер.',
        ),
      /неоднозначен после объединения клонов: укажите digest/,
    );
    const wanted = merged.versions.find(
      (v) => v.digest === portableSuite(second.suite).versions[0].digest,
    )!;
    const adopted = d.corpus.request(
      merged.id,
      { digest: wanted.digest },
      [other.id],
      'agent',
      'Принять по digest.',
    );
    assert.equal(adopted.pending.results[other.id], 'принята');
    assert.equal(d.get(other.id).checkVersion?.digest, wanted.digest);
    // Журнал событий несёт id и итоги принятия, а не тела случаев корпуса.
    const events = JSON.stringify(d.store.allEvents());
    assert.ok(events.includes('checks.adopted'));
    assert.equal(events.includes('\\"v\\":6'), false);
    assert.equal(events.includes('"cases"'), false);
  } finally {
    d.close();
  }
});

test('F04: in operator mode the agent API only requests adoption; issuance is held until the operator confirms', async () => {
  const d = domain();
  try {
    const t = d.add('Operator adoption');
    const seeded = d.seed(t.id, 5);
    d.h.config.approvalMode = 'operator';
    const api = new AgentService(d.h, d.root);
    const requested = await api.run({
      operation: 'checks_adopt',
      input: {
        suiteId: seeded.suite.id,
        digest: seeded.suite.versions[0].digest,
        tasks: [t.id],
        reason: 'Агент запрашивает принятие в operator mode.',
      },
    });
    assert.equal(requested.awaitingOperator, true);
    assert.equal(requested.status, 'waiting');
    assert.equal(d.get(t.id).checkVersion, undefined, 'агент не принял версию сам');
    assert.match(d.get(t.id).hold?.operation ?? '', /^checks:AD-/);
    d.h.pause(false);
    assert.equal(d.h.claim('probe'), undefined, 'выдача удержана до подтверждения');
    // Автоматическое возобновление подтверждение не обходит.
    d.corpus.resume();
    assert.equal(d.get(t.id).checkVersion, undefined);
    assert.throws(
      () => d.corpus.adopt(seeded.suite.id, String(requested.pendingId)),
      /ждёт ручного технического подтверждения/,
    );
    // Подтверждение оператора (CLI/панель) принимает и снимает удержание.
    const approved = d.corpus.approveAdoption(seeded.suite.id, String(requested.pendingId));
    assert.equal(approved.pending.results[t.id], 'принята');
    assert.equal(d.get(t.id).checkVersion?.digest, seeded.suite.versions[0].digest);
    assert.equal(d.get(t.id).hold, undefined);
  } finally {
    d.close();
  }
});

test('F05: an expired confirmation token is neither revived by heartbeat nor able to record', () => {
  const d = domain();
  try {
    const t = d.add('Expired owner');
    const ref = d.corpus.suiteFor(d.get(t.id), 'knapsack-optimal');
    const begun = d.corpus.begin(ref, 'finding-expired');
    const suite = d.corpus.get(ref.suite.id);
    suite.operations['finding-expired'].leaseUntil = Date.now() - 1000;
    d.store.atomic(() => d.corpus.save(suite));
    d.corpus.heartbeat(ref.suite.id, 'finding-expired', begun.token!);
    assert.ok(d.corpus.get(ref.suite.id).operations['finding-expired'].leaseUntil! <= Date.now());
    assert.throws(
      () =>
        d.corpus.record(
          d.corpus.get(ref.suite.id),
          'finding-expired',
          begun.token!,
          {
            property: 'knapsack-optimal',
            input: '{}',
            inputHash: sha256('{}'),
            outcome: 'refuted',
            reason: 'expired owner',
            source: { sha: 'a'.repeat(40) },
            origin: { kind: 'agent' },
          },
          () => '',
          { tasks: [], actor: 'agent' },
        ),
      /Владение операцией подтверждения утрачено/,
    );
    // Новый владелец с тем же ключом продолжает операцию.
    const again = d.corpus.begin(ref, 'finding-expired');
    assert.ok(again.token && again.token !== begun.token);
  } finally {
    d.close();
  }
});

test('F06: an infrastructure failure that kept a passing report as negative evidence does not reset the property streak', () => {
  const d = domain();
  try {
    const infra = d.add('Neutral error with negative gate evidence');
    d.h.pause(false);
    for (let i = 0; i < 3; i++) {
      const r = d.h.claim('probe')!;
      if (i === 1)
        d.h.evidence(r.id, r.token, {
          kind: 'test',
          phase: 'candidate',
          sha: 'a'.repeat(40),
          gate: 'properties',
          passed: false,
          command: [],
          exitCode: -1,
          log: '',
          digest: 'c'.repeat(64),
          summary: 'Environment failed; report retained as negative diagnostics',
          property: {
            level: 'manifest',
            seed: 1,
            reproduce: '',
            contracts: {},
            artifacts: [],
            report: {
              version: 1,
              properties: [{ testId: 'knapsack-optimal', cases: 100, status: 'passed' }],
            },
          },
        });
      d.h.fail(
        r.id,
        r.token,
        i === 1 ? 'environment cleanup failed' : 'property failed',
        false,
        i === 1 ? 'environment' : 'review',
        undefined,
        i === 1 ? undefined : { bound: ['knapsack-optimal'], unbound: [] },
      );
      if (i < 2) d.h.retry(infra.id);
    }
    const recovery = d.get(infra.id).recovery;
    assert.equal(recovery?.status, 'awaiting-lead');
    d.h.retry(infra.id);
    assert.equal(d.h.claim('probe'), undefined, 'третья выдача запрещена');
  } finally {
    d.close();
  }
});

test('F07: an approved change of the task basis closes the old episode and lets the task run', () => {
  const d = domain();
  try {
    const rec = d.add('Recovery basis change');
    d.h.pause(false);
    for (let i = 0; i < 2; i++) {
      const r = d.h.claim('probe')!;
      d.h.fail(r.id, r.token, 'property failed', false, 'review', undefined, {
        bound: ['knapsack-optimal'],
        unbound: [],
      });
      if (i === 0) d.h.retry(rec.id);
    }
    assert.equal(d.get(rec.id).recovery?.status, 'awaiting-lead');
    d.h.reopen(rec.id, 'Approved new approach changes the semantic task basis');
    const before = d.get(rec.id);
    d.h.editTask(
      rec.id,
      {
        ...input('Recovery basis changed'),
        contracts: before.contracts,
        properties: before.properties,
      },
      specDigest(before),
    );
    d.h.approve(rec.board);
    const after = d.get(rec.id);
    assert.equal(after.recovery, undefined);
    assert.equal(after.recoveryHistory?.at(-1)?.reason, 'утверждено новое основание задачи');
    const run = d.h.claim('probe');
    assert.equal(run?.taskId, rec.id, 'задача снова выдаётся');
  } finally {
    d.close();
  }
});

test('F08: a rebind to a new contract releases the old corpus binding so the new corpus can be adopted', () => {
  const d = domain();
  try {
    const t = d.add('Rebind corpus');
    d.seed(t.id, 5, [t.id]);
    assert.ok(d.get(t.id).checkVersion);
    const newer = d.h.contract(
      'New check contract',
      'New independently reviewed check basis.',
      undefined,
      undefined,
      undefined,
      undefined,
      declaration(),
    );
    d.h.rebind([t.id], [d.c.id], newer.id);
    assert.equal(d.get(t.id).checkVersion, undefined);
    d.h.approve(t.board);
    const fresh = d.seed(t.id, 7, [t.id]);
    assert.equal(fresh.suite.contractId, newer.id);
    assert.equal(d.get(t.id).checkVersion?.suite, 'KS-' + newer.id);
    // Принятия прежнего корпуса остались его историей.
    assert.equal(d.corpus.get('KS-' + d.c.id).adoptions.length, 1);
  } finally {
    d.close();
  }
});

test('F09: local paths from an implementation exception never reach the portable corpus record', () => {
  const d = domain();
  try {
    copyFileSync(
      new URL('../packs/property/harness.mjs', import.meta.url),
      join(d.root, 'harness.mjs'),
    );
    writeFileSync(
      join(d.root, 'checker.mjs'),
      `import {properties} from './harness.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
await properties([{testId:'knapsack-optimal', valid:()=>true, oracle:()=>9, subject:()=>readFileSync(join(process.cwd(),'missing-local-input.json'))}]);`,
    );
    const text = canonicalJson({ items: [{ w: 0, v: 9 }], cap: 0 });
    writeFileSync(
      join(d.root, 'case.json'),
      JSON.stringify({ property: 'knapsack-optimal', input: JSON.parse(text) }),
    );
    execFileSync(process.execPath, [join(d.root, 'checker.mjs')], {
      cwd: d.root,
      env: {
        ...process.env,
        DEVCONTOUR_CASE: join(d.root, 'case.json'),
        DEVCONTOUR_CASE_RESULT: join(d.root, 'result.json'),
      },
    });
    const observed = JSON.parse(readFileSync(join(d.root, 'result.json'), 'utf8')) as {
      actual: unknown;
    };
    assert.ok(
      JSON.stringify(observed.actual).includes(d.root),
      'исключение действительно называет локальный путь',
    );
    // Запись прежнего формата без очистки при записи: экспорт всё равно чистит.
    const t = d.add('Local path');
    const ref = d.corpus.suiteFor(d.get(t.id), 'knapsack-optimal');
    const begun = d.corpus.begin(ref, 'finding-path');
    const leaked = d.corpus.record(
      d.corpus.get(ref.suite.id),
      'finding-path',
      begun.token!,
      {
        property: 'knapsack-optimal',
        input: text,
        inputHash: sha256(text),
        outcome: 'confirmed',
        reason: 'эталон дал 9, реализация — ' + canonicalJson(observed.actual),
        source: { sha: 'a'.repeat(40) },
        observed: {
          expected: '9',
          actual: canonicalJson(observed.actual),
          equal: false,
          repeats: 2,
          durationsMs: [1, 1],
        },
        claimed: { expected: null, actual: d.root + '/x.json' },
        origin: { kind: 'agent' },
      },
      () => 'a'.repeat(40),
      { tasks: [], actor: 'agent' },
    );
    const portable = JSON.stringify(portableSuite(leaked.suite, localRoots(d.h)));
    assert.equal(portable.includes(d.root), false);
    assert.equal(portable.includes(tmpdir()), false);
    assert.match(portable, /<local-path>/);
  } finally {
    d.close();
  }
});

test('F10: every operator request holds issuance; confirming one of two, or releasing a foreign hold, does not release the task', () => {
  const d = domain();
  try {
    const t = d.add('Two operator requests');
    const v1 = d.seed(t.id, 5).suite.versions.at(-1)!;
    const v2 = d.seed(t.id, 6).suite.versions.at(-1)!;
    d.h.config.approvalMode = 'operator';
    // Чужое удержание: собственное удержание оператора не ставится.
    d.h.hold([t.id], 'other:op', 'Другая операция');
    const a = d.corpus.request('KS-' + d.c.id, { digest: v1.digest }, [t.id], 'agent', 'A', true);
    const b = d.corpus.request('KS-' + d.c.id, { digest: v2.digest }, [t.id], 'agent', 'B', true);
    d.h.release('other:op');
    d.h.pause(false);
    assert.equal(d.get(t.id).hold, undefined, 'своего удержания у запросов нет');
    assert.equal(d.h.claim('probe'), undefined, 'два запроса ждут оператора');
    d.corpus.approveAdoption('KS-' + d.c.id, a.pending.id);
    assert.equal(d.get(t.id).checkVersion?.digest, v1.digest);
    assert.equal(d.h.claim('probe'), undefined, 'второй запрос всё ещё ждёт оператора');
    d.corpus.approveAdoption('KS-' + d.c.id, b.pending.id);
    const run = d.h.claim('probe')!;
    assert.equal(run.checks?.corpus?.digest, v2.digest);
  } finally {
    d.close();
  }
});

test('F11: a rebind of another contract keeps the corpus of the unchanged check contract', () => {
  const d = domain();
  try {
    const plain = (title: string) => d.h.contract(title, 'Plain API contract ' + title);
    const a1 = plain('API v1');
    const b = d.h.createBoard('Two contracts');
    const t = d.h.addTask(b.id, {
      ...input('Two contracts'),
      contracts: [d.c.id, a1.id],
      properties: ['knapsack-optimal'],
    });
    d.h.approve(b.id);
    const seeded = d.seed(t.id, 5, [t.id]);
    const before = d.get(t.id).checkVersion!;
    assert.equal(before.digest, seeded.suite.versions[0].digest);
    const a2 = plain('API v2');
    assert.deepEqual(d.h.rebind([t.id], [a1.id], a2.id), [t.id]);
    assert.deepEqual(d.get(t.id).checkVersion, before, 'корпус C не снят');
    d.h.approve(b.id);
    d.h.pause(false);
    const run = d.h.claim('probe')!;
    assert.equal(run.checks?.corpus?.digest, before.digest);
  } finally {
    d.close();
  }
});

/** Завершённая задача с корпусом и корректный receipt для неё. */
function receiptWithCorpus(d: ReturnType<typeof domain>) {
  const rt = d.add('Receipt corpus');
  const seeded = d.seed(rt.id, 5, [rt.id]);
  const corpusDigest = seeded.suite.versions[0].digest;
  d.h.pause(false);
  const run = d.h.claim('probe')!;
  d.h.phase(run.id, run.token, 'integrating', {
    candidateSha: 'a'.repeat(40),
    integrationSha: 'b'.repeat(40),
  });
  for (const phase of ['candidate', 'integration'] as const)
    for (const kind of ['test', 'review'] as const)
      d.h.evidence(run.id, run.token, {
        kind,
        phase,
        sha: (phase === 'candidate' ? 'a' : 'b').repeat(40),
        gate: kind === 'test' ? 'properties' : 'independent-review',
        passed: true,
        command: [],
        exitCode: 0,
        log: '',
        digest: 'c'.repeat(64),
        summary: 'fixture',
        ...(kind === 'test'
          ? {
              property: {
                level: 'manifest' as const,
                seed: 1,
                reproduce: '',
                contracts: {},
                artifacts: [],
                manifest: {
                  digest: 'd'.repeat(64),
                  properties: ['knapsack-optimal'],
                  corpus: { digest: corpusDigest, cases: 1 },
                },
              },
            }
          : {}),
      });
  d.h.finish(run.id, run.token, 'b'.repeat(40));
  const done = d.get(rt.id);
  const receipt = completion(d.h, d.store.read(), done);
  receipt.runtime = 'codex';
  receipt.reviewer = 'claude';
  const contracts = d.store.read().contracts;
  const suites = (id: string) => portableSuite(d.corpus.get(id));
  const validate = (r: typeof receipt) =>
    validateReceipt(receiptSchema.parse(r), done, false, suites, contracts);
  return { receipt, validate };
}

test('F12: a declared property gate cannot be excluded from required gates and replaced by another PASS', () => {
  const d = domain();
  try {
    const { receipt, validate } = receiptWithCorpus(d);
    validate(receipt);
    const swapped = structuredClone(receipt);
    swapped.requiredGates = ['lint'];
    for (const e of [...swapped.checks])
      if (e.gate === 'properties') {
        swapped.checks.push({ ...e, gate: 'lint', property: undefined });
        e.passed = false;
        e.exitCode = 1;
        e.checks = 'f'.repeat(64);
      }
    assert.throws(() => validate(swapped), /Нет PASS в receipt .*: candidate\/properties/);
  } finally {
    d.close();
  }
});

test('F13: the mandatory corpus cannot be stripped from the manifests of a receipt or understated', () => {
  const d = domain();
  try {
    const { receipt, validate } = receiptWithCorpus(d);
    validate(receipt);
    const stripped = structuredClone(receipt);
    for (const e of stripped.checks) delete e.property?.manifest?.corpus;
    assert.throws(() => validate(stripped), /не исполнял обязательный корпус/);
    const zero = structuredClone(receipt);
    for (const e of zero.checks)
      if (e.property?.manifest?.corpus) e.property.manifest.corpus.cases = 0;
    assert.throws(() => validate(zero), /не исполнял обязательный корпус/);
  } finally {
    d.close();
  }
});

test('F14: a local path in an adoption reason given through the agent API never reaches the portable record', async () => {
  const d = domain();
  try {
    const t = d.add('Adoption reason');
    const seeded = d.seed(t.id, 5);
    const api = new AgentService(d.h, d.root);
    await api.run({
      operation: 'checks_adopt',
      input: {
        suiteId: seeded.suite.id,
        digest: seeded.suite.versions[0].digest,
        tasks: [t.id],
        reason: `подтверждена ошибка в ${d.root}/private-input.json`,
      },
    });
    assert.equal(d.get(t.id).checkVersion?.digest, seeded.suite.versions[0].digest);
    const suite = d.corpus.get(seeded.suite.id);
    assert.equal(JSON.stringify(suite.adoptions).includes(d.root), false, 'запись очищена');
    // Запись прежнего формата с путём: экспорт всё равно очищает.
    suite.adoptions[0].reason = `ошибка в ${d.root}/old.json`;
    d.store.atomic(() => d.corpus.save(suite));
    const portable = JSON.stringify(portableSuite(d.corpus.get(seeded.suite.id), localRoots(d.h)));
    assert.equal(portable.includes(d.root), false);
    assert.match(portable, /<local-path>/);
  } finally {
    d.close();
  }
});

test('F16: every local root of the installation is scrubbed through the agent API: single repository, configured spelling, spaces, escaped Windows paths', async () => {
  const d = domain();
  try {
    // Корень с пробелом внутри — workspace; одиночный репозиторий вне других
    // корней; исходное написание до realpath.
    const spaced = join(d.root, 'My Project');
    mkdirSync(spaced);
    d.h.config.workspaceRoot = spaced;
    d.h.config.repository = '/srv/synthetic-single-repo';
    configuredSpellings.set(d.h.config, ['/opt/synthetic-configured/workspace']);
    const paths = [
      join(spaced, 'private.json'),
      join(d.root, 'state.sqlite'),
      '/srv/synthetic-single-repo/private file.json',
      '/opt/synthetic-configured/workspace/a.json',
      'C:/Users/synthetic/private.json',
      'C:\\Users\\synthetic\\private.json',
      'C:\\\\Users\\\\synthetic\\\\escaped.json',
      'file://fileserver/share/synthetic/private.json',
      '/home/synthetic/private.json',
    ];
    const t = d.add('Any path');
    const seeded = d.seed(t.id, 5);
    const api = new AgentService(d.h, d.root);
    await api.run({
      operation: 'checks_adopt',
      input: {
        suiteId: seeded.suite.id,
        digest: seeded.suite.versions[0].digest,
        tasks: [t.id],
        reason: 'Verified inputs at ' + paths.join(' and ') + ' after review',
      },
    });
    const portable = JSON.stringify(portableSuite(d.corpus.get(seeded.suite.id), localRoots(d.h)));
    for (const p of [d.root, 'synthetic', 'fileserver', 'My Project'])
      assert.equal(portable.includes(p), false, p);
    assert.match(portable, /Verified inputs at <local-path>.* after review/);
    // macOS-псевдонимы: оба написания временного каталога.
    const roots = localRoots(d.h);
    for (const r of roots.filter((x) => x.startsWith('/private/var/')))
      assert.ok(roots.includes(r.slice('/private'.length)), r);
  } finally {
    d.close();
  }
});

test('F17: scrubbing keeps legitimate text: routes, URLs with queries, other schemes, Unicode relative paths, dates and fractions', () => {
  const roots = ['/data/Synthetic Space/project', '/tmp'];
  for (const text of [
    'route /api/users and /api/v1/tasks/7 answered 404',
    'see https://example.com/~/api/v1 and https://example.com/home/page',
    'redirect https://example.test/?next=/tmp/file.json kept',
    'profile://example.test/a and git+ssh://host/x stay',
    'relative src/модуль/файл.mjs, пример/tmp/file and tests/a b.mjs',
    'on 2026/10/08 the ratio was 1/2; /tmpfoo, /tmp-file and /tmp2 are not roots',
    'paths outside known roots stay: /data/input.json and /secret.json',
  ])
    assert.equal(scrubLocalPaths(text, roots), text);
  assert.equal(scrubLocalPaths('at /tmp/x.json', roots), 'at <local-path>/x.json');
  assert.equal(scrubLocalPaths('file:///tmp/x.json', roots), '<local-path>');
});

test('F18: different facts stay different after scrubbing, and normative differences conflict in the merge', () => {
  const roots = [tmpdir()];
  const one = scrubLocalPaths('Read /data/input.json actual=1 expected=/work/output.json', roots);
  const two = scrubLocalPaths('Read /data/input.json actual=2 expected=/work/output.json', roots);
  assert.notEqual(one, two);
  const d = domain();
  try {
    const t = d.add('Different facts');
    d.seed(t.id, 5, [t.id]);
    const base = portableSuite(d.corpus.get('KS-' + d.c.id));
    const local = structuredClone(base);
    const remote = structuredClone(base);
    remote.adoptions[0].to = { number: 9, digest: 'f'.repeat(64) };
    assert.throws(() => mergeSuites(base, local, remote), /принятие .* различается/);
    const expected = structuredClone(base);
    expected.cases[0].expected = '999';
    assert.throws(() => mergeSuites(base, local, expected), /случай .* различается/);
  } finally {
    d.close();
  }
});

test('F19: scrubbing is idempotent, including doubled separators and a root repeated inside a path', () => {
  const roots = ['/data/project', '/data/Synthetic Space/project', tmpdir(), '/tmp'];
  for (const text of [
    'historic /data//cache//nested/private.json',
    'Error at /data/project/data/project/data/project/input.json',
    'at /data/Synthetic Space/project//nested//x.json and /Users/a//b.json',
    'file:////host//share and C:\\\\Users\\\\x and <local-path>/x',
    `${tmpdir()}${tmpdir()}${tmpdir()}/a and ${tmpdir()}//b`,
  ]) {
    const once = scrubLocalPaths(text, roots);
    assert.equal(scrubLocalPaths(once, roots), once, text);
  }
});

test('F20: facts that differ only in diagnostic text merge to the Git value on every installation', () => {
  const d = domain();
  try {
    const t = d.add('Installation diagnostics');
    d.seed(t.id, 5, [t.id]);
    const git = portableSuite(d.corpus.get('KS-' + d.c.id));
    git.adoptions[0].reason = 'Error at <local-path>/session/A/workspace/input.json';
    git.decisions[0].reason = 'Historic /Users/someone/input.json';
    const a = structuredClone(git);
    a.adoptions[0].reason = 'Error at <local-path>/input.json';
    const b = structuredClone(git);
    b.decisions[0].reason = 'Historic <local-path>';
    for (const local of [a, b]) {
      const merged = mergeSuites(git, local, git)!;
      assert.equal(merged.adoptions[0].reason, git.adoptions[0].reason);
      assert.equal(merged.decisions[0].reason, git.decisions[0].reason);
    }
    // Новый факт клона — его очищенное значение.
    const added = structuredClone(git);
    added.adoptions.push({ ...git.adoptions[0], id: 'AA-new', reason: 'Fresh <local-path>' });
    assert.equal(mergeSuites(git, added, git)!.adoptions.at(-1)!.reason, 'Fresh <local-path>');
  } finally {
    d.close();
  }
});

test('F09/F16 residue: a path after an escaped newline or a colon is scrubbed; F17 residue: combining marks and link framing survive', () => {
  const ws = '/srv/synthetic-ws';
  const roots = [ws, '/tmp'];
  const actual = canonicalJson({
    error: `Error:\n${ws}/private.json\n\tC:\\Users\\Synthetic\\private.json`,
  });
  const out = scrubLocalPaths(actual, roots);
  assert.equal(out.includes('synthetic'), false, out);
  assert.equal(out.includes('Synthetic'), false, out);
  assert.equal(scrubLocalPaths('ENOENT:/tmp/x.json', roots), 'ENOENT:<local-path>/x.json');
  const combining = 'café/tmp/file';
  assert.equal(scrubLocalPaths(combining, roots), combining);
  assert.equal(
    scrubLocalPaths('see [input](file:///tmp/input.json), then', roots),
    'see [input](<local-path>), then',
  );
  for (const text of [out, 'see [input](<local-path>), then'])
    assert.equal(scrubLocalPaths(text, roots), text);
});

test('F21: after a Git edit of only diagnostic text the local projection shows the Git value', () => {
  const d = domain();
  try {
    const t = d.add('Diagnostic edit');
    d.seed(t.id, 5, [t.id]);
    const local = d.corpus.get('KS-' + d.c.id);
    const git = portableSuite(local);
    git.decisions[0].reason = 'Edited in Git';
    git.adoptions[0].reason = 'Edited adoption in Git';
    const merged = mergeSuites(portableSuite(local), portableSuite(local), git)!;
    const next = localSuite(merged, local);
    assert.equal(next.decisions[0].reason, 'Edited in Git');
    assert.equal(next.adoptions[0].reason, 'Edited adoption in Git');
    // Повторный экспорт совпадает с Git: следующий sync ничего не обещает.
    assert.equal(canonicalJson(portableSuite(next)), canonicalJson(git));
  } finally {
    d.close();
  }
});

test('F22: a file:// URL after a JSON-escaped newline, carriage return or tab is scrubbed, not read as another scheme', () => {
  for (const escape of ['n', 'r', 't']) {
    const actual = canonicalJson({ error: `Error:\\${escape}file:///srv/synthetic/private.json` });
    const raw = JSON.stringify({
      error: `Error:${escape === 'n' ? '\n' : escape === 'r' ? '\r' : '\t'}file:///srv/synthetic/private.json`,
    });
    for (const text of [actual, raw]) {
      const out = scrubLocalPaths(text, []);
      assert.equal(out.includes('synthetic'), false, out);
      assert.equal(scrubLocalPaths(out, []), out);
    }
  }
  // Обычный URL после перевода строки остаётся как есть.
  const kept = JSON.stringify({ see: 'line\nhttps://example.com/a?b=1' });
  assert.equal(scrubLocalPaths(kept, []), kept);
});
