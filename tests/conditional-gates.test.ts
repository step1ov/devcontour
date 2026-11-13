// Условные gates (`when.paths`, harness 0.1.0-alpha.45): конфигурация и
// политика, покрытие доски по объединённому diff, доказательства, receipt и
// показ. Модели не вызываются; сквозной сценарий — реальный Git demo-fixture.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionDigest, gateDigest, requirementProof } from 'devcontour-harness';
import { demoPool, testDemo } from './demo-pool.ts';
import { CANDIDATE, MERGED, config, fixture, input } from './helpers.ts';
import { configSchema, type Evidence } from '../src/core/model.ts';
import {
  BOARD_COVERAGE,
  DevContour,
  boardCoverageKey,
  boardCoverageWorks,
  digest,
  uncoveredGates,
  type BoardCoverage,
} from '../src/core/service.ts';
import { validateTaskContext, validateWorkflow } from '../src/core/workflow.ts';
import { approvalPolicyDigest, policyFromConfig } from '../src/harness/policy.ts';
import { executionOf } from '../src/harness/execution.ts';
import { receiptResult } from '../src/harness/receipt.ts';
import { completion, receiptHolds, validateReceipt } from '../src/core/sync-state.ts';
import { receiptSchema, type CompletionReceipt } from '../src/core/sync-model.ts';
import { needsRecheck } from '../src/core/proof.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import * as sync from './git-sync-fixture.ts';
import { taskEvidence } from '../src/core/proof.ts';
import { evidenceVerdict, notApplicableLine, verdictWord } from '../src/core/evidence-verdict.ts';
import { panelSummary } from '../src/application/panel.ts';
import { gateWhenChecks } from '../src/runner/doctor.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';

const gate = (id: string) => ({
  id,
  kind: 'test' as const,
  command: ['node', id + '.mjs'],
  timeoutMs: 60_000,
  report: { type: 'junit' as const, path: `.reports/${id}.xml` },
});
const conditional = (id: string, paths = ['web/**']) => ({ ...gate(id), when: { paths } });
const GREEN = 'a'.repeat(40);

test('when: политика несёт условие только когда оно объявлено; digest политики и согласования меняются вместе с ним', () => {
  const plain = config({ gates: [gate('unit'), gate('ui')] });
  const scoped = config({ gates: [gate('unit'), conditional('ui')] });
  const plainGate = policyFromConfig(plain).repositories[0].gates[1];
  assert.equal('when' in plainGate, false, 'gate без when — прежняя форма политики');
  assert.deepEqual(policyFromConfig(scoped).repositories[0].gates[1].when, {
    paths: ['web/**'],
  });
  assert.equal(
    approvalPolicyDigest(plain),
    approvalPolicyDigest(config({ gates: [gate('unit'), gate('ui')] })),
  );
  assert.notEqual(approvalPolicyDigest(plain), approvalPolicyDigest(scoped));
  const f = fixture();
  try {
    f.h.config.gates = [gate('unit'), gate('ui')];
    const before = f.h.policyDigest('main');
    f.h.config.gates = [gate('unit'), conditional('ui')];
    assert.notEqual(f.h.policyDigest('main'), before, 'when входит в договор компонента');
    f.h.config.gates = [gate('unit'), gate('ui')];
    assert.equal(f.h.policyDigest('main'), before);
  } finally {
    f.cleanup();
  }
});

test('when: схема отклоняет недопустимые шаблоны и when у workspace gate; workflow требует безусловный test gate', () => {
  for (const paths of [[], ['../x'], ['/abs'], ['a/[bc]'], ['!web']])
    assert.equal(
      configSchema.safeParse({ ...config(), gates: [gate('unit'), conditional('ui', paths)] })
        .success,
      false,
      JSON.stringify(paths),
    );
  const workspace = configSchema.safeParse({
    ...config(),
    workspaceGates: [{ ...conditional('joint'), repositoryId: 'main' }],
  });
  assert.equal(workspace.success, false);
  assert.match(JSON.stringify(workspace.error?.issues), /только у gates компонента/);
  assert.throws(
    () => validateWorkflow(config({ gates: [conditional('unit'), conditional('ui')] })),
    /test gate без when/,
  );
  assert.throws(
    () =>
      validateWorkflow(config({ gates: [gate('unit'), { ...conditional('prop'), property: {} }] })),
    /генеративный gate prop не может быть условным/,
  );
  const c = config({ gates: [gate('unit'), conditional('ui')] });
  validateWorkflow(c);
  assert.throws(
    () =>
      validateTaskContext(c, {
        ...input('Only UI'),
        repositoryId: 'main',
        gates: ['ui'],
      } as Parameters<typeof validateTaskContext>[1]),
    /test gate без when/,
  );
  const text = 'The UI renders the list.';
  validateTaskContext(c, {
    ...input('UI with a requirement'),
    repositoryId: 'main',
    gates: ['ui'],
    requirements: [
      {
        source: 'docs/spec.md',
        id: 'R1',
        text,
        digest: createHash('sha256').update(text).digest('hex'),
        gate: 'ui',
      },
    ],
  } as Parameters<typeof validateTaskContext>[1]);
});

// Digest конфигурации без when, вычисленные на master 8182c36 (0.4.0-alpha.35,
// harness 0.1.0-alpha.44): смена порядка полей или умолчаний в схеме gate
// изменила бы их, и согласования прежних планов перестали бы совпадать.
test('Без when digest политики, исполнения и договора компонента — прежние (закреплены на master)', () => {
  const pinned = configSchema.parse({
    version: 1,
    name: 'Pinned',
    repository: '/nonexistent/devcontour-pin/repo',
    checkoutRoot: '/nonexistent/devcontour-pin/checkouts',
    mode: 'demo',
    roles: { qa: { runtime: 'demo' } },
    reviewer: { runtime: 'demo' },
    gates: [
      { id: 'types', kind: 'check', command: ['npm', 'run', 'typecheck'] },
      {
        id: 'unit',
        kind: 'test',
        dependsOn: ['types'],
        command: ['node', 'unit.mjs'],
        report: { type: 'junit', path: '.reports/unit.xml' },
      },
      {
        id: 'ui',
        kind: 'test',
        command: ['node', 'ui.mjs'],
        timeoutMs: 60000,
        report: { type: 'junit', path: '.reports/ui.xml' },
        artifacts: ['shots'],
      },
    ],
  });
  assert.equal(
    approvalPolicyDigest(pinned),
    '21d87aab542141a4c8dc212c928be2cef9d42f2134b0cd436c5ee3cc2a0e0817',
  );
  assert.equal(
    executionDigest(policyFromConfig(pinned)),
    '80445ea685f523063fb9f16aa05c3751699b3fdb908535604c1b57e37f86a08b',
  );
  const dir = mkdtempSync(join(tmpdir(), 'devcontour-pin-'));
  const store = new Store(join(dir, 'state.sqlite'));
  try {
    assert.equal(
      new DevContour(store, pinned).policyDigest('main'),
      'b12f2d4d48a6108f18c5413b2cd619977e0d88de6e67e92bcb332ba5d2c4ee8c',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Задача, принятая с PASS `unit` и `not-applicable` условного `ui` на обеих фазах. */
function skippedTask() {
  const f = fixture();
  f.h.config.gates = [gate('unit'), conditional('ui')];
  const b = f.h.createBoard('Conditional', '', 'main');
  const t = f.h.addTask(b.id, input('Docs part'));
  f.h.approve(b.id);
  f.h.pause(false);
  const run = f.h.claim('test')!;
  assert.equal(run.taskId, t.id);
  assert.deepEqual(run.requiredGates, ['unit', 'ui']);
  f.h.phase(run.id, run.token, 'integrating', {
    candidateSha: CANDIDATE,
    integrationSha: MERGED,
  });
  const policyGate = executionOf(f.h).engine.policy.repositories[0].gates.find(
    (g) => g.id === 'ui',
  )!;
  for (const phase of ['candidate', 'integration'] as const) {
    const sha = phase === 'candidate' ? CANDIDATE : MERGED;
    const common = { phase, sha, digest: 'e'.repeat(64), summary: 'fixture' };
    f.h.evidence(run.id, run.token, {
      ...common,
      kind: 'test',
      gate: 'unit',
      passed: true,
      command: ['fixture'],
      exitCode: 0,
      log: 'fixture',
    });
    f.h.evidence(run.id, run.token, {
      ...common,
      kind: 'not-applicable',
      gate: 'ui',
      passed: false,
      command: [],
      exitCode: -1,
      log: '',
      summary: 'not applicable',
      notApplicable: {
        gateDigest: gateDigest(policyGate),
        patterns: ['web/**'],
        ranges: [{ from: GREEN, to: sha }],
        count: 1,
        files: ['README.md'],
        pathsDigest: 'f'.repeat(64),
      },
    });
    f.h.evidence(run.id, run.token, {
      ...common,
      kind: 'review',
      gate: 'independent-review',
      passed: true,
      command: ['fixture'],
      exitCode: 0,
      log: 'fixture',
    });
  }
  f.h.finish(run.id, run.token, MERGED);
  return { f, board: b, task: f.store.read().tasks.find((x) => x.id === t.id)! };
}

test('Покрытие доски: пропущенный условный gate непокрыт без diff, покрыт diff мимо его путей и PASS проверки доски на итоговом SHA', () => {
  const { f, board, task } = skippedTask();
  try {
    assert.equal(task.status, 'done');
    const s = f.store.read();
    const changes = (files: string[], to = MERGED) => ({
      changes: { main: { ranges: [{ from: GREEN, to }], files, complete: true } },
      finalShas: { main: MERGED },
    });
    // Без объединённого diff неприменимость к набору не доказана.
    assert.deepEqual(uncoveredGates(f.h, s, [task]), [{ repositoryId: 'main', gates: ['ui'] }]);
    assert.deepEqual(uncoveredGates(f.h, s, [task], [], changes(['README.md'])), []);
    assert.deepEqual(uncoveredGates(f.h, s, [task], [], changes(['web/app.ts'])), [
      { repositoryId: 'main', gates: ['ui'] },
    ]);
    // Diff, кончающийся не на итоговом SHA, ничего не доказывает.
    assert.deepEqual(uncoveredGates(f.h, s, [task], [], changes(['README.md'], CANDIDATE)), [
      { repositoryId: 'main', gates: ['ui'] },
    ]);
    // Неявный вход (lockfile) задевает и условный gate.
    assert.deepEqual(uncoveredGates(f.h, s, [task], [], changes(['package-lock.json'])), [
      { repositoryId: 'main', gates: ['ui'] },
    ]);
    // Проверка доски исполнила gate на итоговом SHA — он покрыт.
    const pass: Evidence = {
      id: 'BC-1/ui',
      runId: 'BC-1',
      kind: 'test',
      phase: 'integration',
      sha: MERGED,
      gate: 'ui',
      passed: true,
      createdAt: new Date().toISOString(),
      command: ['fixture'],
      exitCode: 0,
      log: 'fixture',
      digest: 'e'.repeat(64),
      summary: 'fixture',
    };
    assert.deepEqual(
      uncoveredGates(
        f.h,
        s,
        [task],
        [{ repositoryId: 'main', resultSha: MERGED, evidence: [pass] }],
        changes(['web/app.ts']),
      ),
      [],
    );
    // Покрывает только собственный PASS фазы интеграции на итоговом SHA:
    // другой SHA, проверка потребителя, фаза кандидата, запись не test.
    const gap = [{ repositoryId: 'main', gates: ['ui'] }];
    for (const [label, evidence, resultSha] of [
      ['другой SHA записи', { ...pass, sha: CANDIDATE }, MERGED],
      ['запись не на SHA работы', pass, CANDIDATE],
      ['проверка потребителя', { ...pass, consumer: 'web' }, MERGED],
      ['фаза кандидата', { ...pass, phase: 'candidate' }, MERGED],
      ['провал', { ...pass, passed: false, exitCode: 1 }, MERGED],
      ['неприменимость', { ...pass, kind: 'not-applicable', passed: false }, MERGED],
      ['ревью', { ...pass, kind: 'review' }, MERGED],
    ] as [string, Evidence, string][])
      assert.deepEqual(
        uncoveredGates(
          f.h,
          s,
          [task],
          [{ repositoryId: 'main', resultSha, evidence: [evidence] }],
          changes(['web/app.ts']),
        ),
        gap,
        label,
      );
    // Неполный diff или diff не от зелёного SHA записи — как отсутствующий.
    assert.deepEqual(
      uncoveredGates(f.h, s, [task], [], {
        changes: {
          main: { ranges: [{ from: GREEN, to: MERGED }], files: [], complete: false },
        },
        finalShas: { main: MERGED },
      }),
      gap,
    );
    assert.deepEqual(
      uncoveredGates(f.h, s, [task], [], {
        changes: {
          main: { ranges: [{ from: CANDIDATE, to: MERGED }], files: ['README.md'], complete: true },
        },
        finalShas: { main: MERGED },
      }),
      gap,
    );
    // Запись проверки доски под другим договором компонента не покрывает.
    const revision = s.boards[0].revisions.at(-1)!;
    const record = (policyDigest: string): BoardCoverage => ({
      boardId: board.id,
      revision: revision.number,
      repositoryId: 'main',
      sha: MERGED,
      policyDigest,
      revisionDigest: digest(revision),
      runId: 'BC-1',
      gates: ['ui'],
      evidence: [pass],
      at: new Date().toISOString(),
    });
    const key = boardCoverageKey(board.id, revision.number);
    f.store.atomic(() => f.store.saveLocal(BOARD_COVERAGE, 'main', key, record('0'.repeat(64))));
    assert.deepEqual(boardCoverageWorks(f.h, board.id, revision, { main: MERGED }), []);
    assert.deepEqual(
      uncoveredGates(
        f.h,
        s,
        [task],
        boardCoverageWorks(f.h, board.id, revision, { main: MERGED }),
        changes(['web/app.ts']),
      ),
      gap,
    );
    f.store.atomic(() =>
      f.store.saveLocal(BOARD_COVERAGE, 'main', key, record(f.h.policyDigest('main'))),
    );
    assert.deepEqual(
      uncoveredGates(
        f.h,
        s,
        [task],
        boardCoverageWorks(f.h, board.id, revision, { main: MERGED }),
        changes(['web/app.ts']),
      ),
      [],
    );
    f.store.atomic(() => f.store.deleteLocal(BOARD_COVERAGE, 'main', key));
    // Приёмка доски без diff отказывает и называет gate.
    assert.throws(
      () => f.h.accept(board.id, MERGED, undefined, undefined, { main: MERGED }),
      /Полный набор проверок не пройден: main: ui/,
    );
    void BOARD_COVERAGE;
  } finally {
    f.cleanup();
  }
});

test('Неприменимость — не доказательство и не провал: требование не подтверждено, панель и отчёты показывают её отдельно', () => {
  const { f, task } = skippedTask();
  try {
    const s = f.store.read();
    const evidence = taskEvidence(s, task, f.h);
    const skip = evidence.find((e) => e.kind === 'not-applicable' && e.phase === 'integration')!;
    assert.equal(
      requirementProof({ id: 'R1', gate: 'ui' }, evidence, task.resultSha).level,
      'none',
    );
    assert.equal(evidenceVerdict(skip), 'not-applicable');
    assert.equal(verdictWord(skip), 'НЕ ПРИМЕНИМ (пути)');
    assert.match(
      notApplicableLine(skip.notApplicable),
      /не применим \(пути\): шаблоны web\/\*\*; изменено путей 1: README\.md/,
    );
    const summary = panelSummary(f.h, f.root, {}) as unknown as {
      runs: { evidence: { gate: string; kind: string; notApplicable?: unknown }[] }[];
    };
    const ui = summary.runs.flatMap((r) => r.evidence).filter((e) => e.gate === 'ui');
    assert.ok(ui.length);
    for (const e of ui) {
      assert.equal(e.kind, 'not-applicable');
      assert.deepEqual(e.notApplicable, {
        patterns: ['web/**'],
        count: 1,
        files: ['README.md'],
      });
    }
    // Receipt переносит запись с её основанием; получатель видит вид и поле.
    const receipt = completion(f.h, s, task);
    const carried = receipt.checks.filter((c) => c.kind === 'not-applicable');
    assert.equal(carried.length, 2);
    assert.equal(carried[0].notApplicable?.patterns[0], 'web/**');
    const result = receiptResult(receipt, {
      order: { source: { connector: 'devcontour', ref: task.id, revision: '1' } },
      policy: policyFromConfig(f.h.config),
    } as unknown as Parameters<typeof receiptResult>[1]);
    const refs = result.evidence.filter((e) => e.kind === 'not-applicable');
    assert.equal(refs.length, 2);
    assert.ok(refs.every((e) => e.notApplicable?.gateDigest && !e.passed));
  } finally {
    f.cleanup();
  }
});

test('Получатель receipt засчитывает неприменимость только под тем же when; PASS-неприменимость — подлог', () => {
  const { f, task } = skippedTask();
  try {
    const s = f.store.read();
    const receipt = completion(f.h, s, task);
    // То же определение gate у получателя — receipt подтверждает задачу.
    validateReceipt(f.h, receipt, task, []);
    // У получателя ui без when или с другими путями — неприменимость не засчитана.
    for (const ui of [gate('ui'), conditional('ui', ['app/**'])]) {
      f.h.config.gates = [gate('unit'), ui];
      assert.throws(() => validateReceipt(f.h, receipt, task, []), /ui/, JSON.stringify(ui));
    }
    f.h.config.gates = [gate('unit'), conditional('ui')];
    validateReceipt(f.h, receipt, task, []);
    // Неприменимость, выданная за PASS, отклоняется схемой receipt и получателем harness.
    const forged = structuredClone(receipt);
    for (const c of forged.checks) if (c.kind === 'not-applicable') c.passed = true;
    assert.equal(receiptSchema.safeParse(forged).success, false);
    assert.throws(() => validateReceipt(f.h, forged, task, []));
    // Основание неприменимости у записи другого вида — несогласованный receipt.
    const mixed = structuredClone(receipt);
    const unit = mixed.checks.find((c) => c.kind === 'test')!;
    unit.notApplicable = receipt.checks.find((c) => c.kind === 'not-applicable')!.notApplicable;
    assert.equal(receiptSchema.safeParse(mixed).success, false);
  } finally {
    f.cleanup();
  }
});

test('doctor называет условные gates и предупреждает о шаблоне без совпадений', async () => {
  const f = fixture();
  try {
    // Свой репозиторий внутри каталога теста: общий репозиторий fixture не трогаем.
    const repo = join(f.root, 'repo');
    await mkdir(repo, { recursive: true });
    await git(repo, 'init', '-q');
    await mkdir(join(repo, 'web'), { recursive: true });
    await writeFile(join(repo, 'web', 'app.ts'), 'export {};\n');
    await git(repo, 'add', 'web/app.ts');
    const good = config({ repository: repo, gates: [gate('unit'), conditional('ui')] });
    const [passed] = await gateWhenChecks(good);
    assert.equal(passed.status, 'passed', passed.detail);
    assert.match(passed.detail, /ui \(web\/\*\*\)/);
    const typo = config({
      repository: repo,
      gates: [gate('unit'), conditional('ui', ['web/**', 'wbe/**'])],
    });
    const [degraded] = await gateWhenChecks(typo);
    assert.equal(degraded.status, 'degraded');
    assert.match(degraded.detail, /ui: wbe\/\*\*/);
    assert.deepEqual(await gateWhenChecks(config({ repository: repo })), []);
  } finally {
    f.cleanup();
  }
});

/** Задача clone принята: PASS `unit`, условный `ui` неприменим на обеих фазах. */
function completeWithSkip(p: sync.Peer, id: string) {
  p.h.approve(p.store.read().boards[0].id);
  p.h.pause(false);
  const r = p.h.claim('worker')!;
  assert.equal(r.taskId, id);
  const sha = sync.git(p.repo, 'rev-parse', 'HEAD');
  p.h.phase(r.id, r.token, 'integrating', { candidateSha: sha, integrationSha: sha });
  const ui = executionOf(p.h).engine.policy.repositories[0].gates.find((g) => g.id === 'ui')!;
  for (const phase of ['candidate', 'integration'] as const) {
    const base = {
      phase,
      sha,
      exitCode: 0,
      command: ['fixture'],
      log: '/private/local/log',
      digest: digest('verified fixture'),
      summary: 'fixture',
    };
    p.h.evidence(r.id, r.token, { ...base, kind: 'test', gate: 'unit', passed: true });
    p.h.evidence(r.id, r.token, {
      ...base,
      kind: 'not-applicable',
      gate: 'ui',
      passed: false,
      exitCode: -1,
      command: [],
      log: '',
      notApplicable: {
        gateDigest: gateDigest(ui),
        patterns: ['web/**'],
        ranges: [{ from: sha, to: sha }],
        count: 1,
        files: ['README.md'],
        pathsDigest: 'f'.repeat(64),
      },
    });
    p.h.evidence(r.id, r.token, {
      ...base,
      kind: 'review',
      gate: 'independent-review',
      passed: true,
    });
  }
  p.h.finish(r.id, r.token, sha);
  p.h.pause(true);
  return sha;
}
const scopedGates = () => [gate('unit'), conditional('ui')];

test('Git sync: принятая задача, область которой — gate, ставший условным, по-прежнему импортируется', () => {
  const f = sync.fixture();
  try {
    const a = f.create('alice');
    a.h.config.gates = [gate('unit'), gate('ui')];
    const board = a.h.createBoard('History', '', 'main');
    const t = a.h.addTask(board.id, { ...input('UI only'), gates: ['ui'] });
    a.h.approve(board.id);
    a.h.pause(false);
    const r = a.h.claim('worker')!;
    const sha = sync.git(a.repo, 'rev-parse', 'HEAD');
    a.h.phase(r.id, r.token, 'integrating', { candidateSha: sha, integrationSha: sha });
    for (const phase of ['candidate', 'integration'] as const)
      for (const [kind, id] of [
        ['test', 'ui'],
        ['review', 'independent-review'],
      ] as const)
        a.h.evidence(r.id, r.token, {
          kind,
          phase,
          sha,
          gate: id,
          passed: true,
          exitCode: 0,
          command: ['fixture'],
          log: '/private/local/log',
          digest: digest('verified fixture'),
          summary: 'fixture',
        });
    a.h.finish(r.id, r.token, sha);
    a.h.pause(true);
    // Доска не принимается: unit вне области задачи; импорт решает по задаче.
    syncGit(a.h, { member: 'alice' });
    a.commit();
    // Команда делает ui условным: прежняя принятая задача остаётся в истории.
    a.h.config.gates = scopedGates();
    syncGit(a.h, { member: 'alice' });
    const b = f.create('bob', a);
    b.h.config.gates = scopedGates();
    syncGit(b.h, { member: 'bob' });
    assert.equal(b.store.read().tasks.find((x) => x.id === t.id)?.status, 'done');
    // Новая задача с той же областью не ставится.
    assert.throws(
      () => b.h.addTask(board.id, { ...input('UI only again'), gates: ['ui'] }),
      /test gate без when/,
    );
  } finally {
    f.cleanup();
  }
});

test('Git sync: receipt с неприменимостью принимается под тем же when, иначе отклоняется или требует перепроверки; PASS-подлог отклонён', () => {
  const f = sync.fixture();
  try {
    const a = f.create('alice');
    a.h.config.gates = scopedGates();
    const board = a.h.createBoard('Skips', '', 'main');
    const t = a.h.addTask(board.id, input('Docs only'));
    const sha = completeWithSkip(a, t.id);
    a.h.accept(
      board.id,
      sha,
      undefined,
      undefined,
      { main: sha },
      {
        main: { ranges: [{ from: sha, to: sha }], files: ['README.md'], complete: true },
      },
    );
    syncGit(a.h, { member: 'alice' });
    a.commit();
    // Получатель с тем же when принимает результат участника.
    const b = f.create('bob', a);
    b.h.config.gates = scopedGates();
    syncGit(b.h, { member: 'bob' });
    const received = b.store.read().tasks.find((x) => x.id === t.id)!;
    assert.equal(received.status, 'done');
    assert.ok(received.sharedCompletion);
    assert.equal(
      received.sharedCompletion.receipt.checks.filter((c) => c.kind === 'not-applicable').length,
      2,
    );
    assert.equal(receiptHolds(b.h, b.store.read(), received), true);
    // Получатель изменил when — результат требует перепроверки.
    b.h.config.gates = [gate('unit'), conditional('ui', ['app/**'])];
    assert.equal(receiptHolds(b.h, b.store.read(), received), false);
    assert.equal(needsRecheck(b.store.read(), received, b.h), true);
    // Получатель без when: импорт отклонён целиком.
    const c = f.create('carol', a);
    c.h.config.gates = [gate('unit'), gate('ui')];
    assert.throws(() => syncGit(c.h, { member: 'carol' }), /ui/);
    assert.equal(c.store.read().tasks.length, 0, 'импорт откатан');
    // Неприменимость, выданная за PASS в Git, отклонена.
    const receipts = join(a.repo, '.devcontour', 'receipts');
    for (const name of readdirSync(receipts))
      sync.rewrite(
        join(receipts, name),
        (value: { data: { checks: CompletionReceipt['checks'] } }) => {
          for (const check of value.data.checks)
            if (check.kind === 'not-applicable') check.passed = true;
        },
      );
    a.commit();
    const d = f.create('dave', a);
    d.h.config.gates = scopedGates();
    assert.throws(() => syncGit(d.h, { member: 'dave' }));
    assert.equal(d.store.read().tasks.length, 0, 'импорт откатан');
  } finally {
    f.cleanup();
  }
});

const demos = demoPool(testDemo);
after(() => demos.close());

/**
 * Три задачи на реальном Git: A и B — область `unit` + условный `ui`
 * (`web/**`), правят корень; C — только `unit`, правит `web/` (`webC`) или
 * корень. A исполняет `ui` (зелёного SHA ещё нет), B его пропускает по пути.
 */
async function realBoard(webC: boolean) {
  const seed = await demos.acquire();
  const { root } = seed;
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  store.change('fixture.reset', (s) => {
    s.tasks = [];
    s.boards = [];
    s.runs = [];
  });
  const junit = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="case"></testcase></testsuite>');
`;
  await writeFile(join(config.repository, 'unit.mjs'), junit);
  await writeFile(join(config.repository, 'ui.mjs'), junit);
  await git(config.repository, 'add', '.');
  await git(config.repository, 'commit', '-m', 'Gates unit and ui');
  await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
  config.gates = [
    { ...gate('unit'), command: [process.execPath, 'unit.mjs'] },
    { ...conditional('ui'), command: [process.execPath, 'ui.mjs'] },
  ];
  config.protectedPaths = [...config.protectedPaths, 'unit.mjs', 'ui.mjs'];
  const board = h.createBoard('Conditional release');
  const a = h.addTask(board.id, { ...input('Part A'), gates: ['unit', 'ui'] });
  const b = h.addTask(board.id, { ...input('Part B', [a.id]), gates: ['unit', 'ui'] });
  const c = h.addTask(board.id, { ...input('Part C', [b.id]), gates: ['unit'] });
  h.approve(board.id);
  const runtimes = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (r.review)
          return {
            data: { approved: true, summary: 'Looks fine', findings: [] },
            log: 'fixture',
            command: ['fixture'],
          };
        const file =
          webC && r.task.id === c.id
            ? join('web', `part-${r.task.id}.ts`)
            : `part-${r.task.id}.txt`;
        await mkdir(join(r.cwd, 'web'), { recursive: true });
        await writeFile(join(r.cwd, file), r.task.title + '\n');
        return {
          data: { completed: true, summary: 'Implemented ' + r.task.title },
          log: 'fixture',
          command: ['fixture'],
        };
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  await scheduler.init();
  await updateBase(config, root);
  h.pause(false);
  await scheduler.drain();
  await scheduler.stop();
  return {
    root,
    store,
    h,
    board,
    tasks: [a, b, c],
    cleanup: () => {
      store.close();
      seed.release();
    },
  };
}

const kinds = (e: readonly Evidence[], gate: string) =>
  e.filter((x) => x.gate === gate && x.phase === 'integration').map((x) => x.kind);

for (const webC of [true, false])
  test(`Реальный Git: задача пропускает условный gate по пути; приёмка доски ${webC ? 'исполняет его один раз на итоговом SHA, когда объединённый diff задевает web/' : 'не исполняет его, когда объединённый diff мимо его путей'}`, async () => {
    const f = await realBoard(webC);
    try {
      const state = f.store.read();
      assert.ok(
        state.tasks.every((t) => t.status === 'done'),
        JSON.stringify(state.tasks.map((t) => [t.id, t.status, t.failure])),
      );
      const [a, b, c] = f.tasks.map((t) => state.tasks.find((x) => x.id === t.id)!);
      assert.deepEqual(kinds(taskEvidence(state, a, f.h), 'ui'), ['test'], 'нет зелёного SHA');
      const skipped = taskEvidence(state, b, f.h).filter(
        (e) => e.gate === 'ui' && e.kind === 'not-applicable',
      );
      assert.deepEqual(
        skipped.map((e) => e.phase),
        ['candidate', 'integration'],
      );
      for (const e of skipped) {
        assert.equal(e.passed, false);
        assert.deepEqual(e.notApplicable?.patterns, ['web/**']);
        assert.equal(e.notApplicable?.ranges[0].from, a.resultSha, 'от зелёного SHA задачи A');
        assert.ok(e.notApplicable?.files.every((p) => !p.startsWith('web/')));
      }
      assert.deepEqual(kinds(taskEvidence(state, c, f.h), 'ui'), []);
      const accepted = await acceptBoard(f.h, f.board.id, 'codex', false, undefined, {
        root: f.root,
      });
      assert.equal(accepted.status, 'accepted');
      const coverage = (accepted as { coverage?: { gates: string[]; sha: string }[] }).coverage;
      const record = f.store.localRecord<BoardCoverage>(
        BOARD_COVERAGE,
        'main',
        boardCoverageKey(f.board.id, 1),
      );
      if (webC) {
        assert.deepEqual(
          coverage?.map((x) => [x.gates, x.sha]),
          [[['ui'], c.resultSha]],
        );
        assert.deepEqual(
          record?.evidence.map((e) => [e.gate, e.kind, e.sha, e.passed]),
          [['ui', 'test', c.resultSha, true]],
          'gate исполнен один раз на итоговом SHA',
        );
      } else {
        assert.equal(coverage, undefined, 'diff мимо web/ — gate неприменим к доске');
        assert.equal(record, undefined);
      }
      assert.equal(f.store.read().boards[0].revisions.at(-1)!.status, 'accepted');
    } finally {
      f.cleanup();
    }
  });

for (const broken of ['replace', 'anchor'] as const)
  test(`Реальный Git: ${broken === 'replace' ? 'неполный diff (объект замены)' : 'зелёный SHA пропуска, которого нет в репозитории'} — приёмка исполняет пропущенный gate на итоговом SHA`, async () => {
    // Объединённый diff мимо web/ — без порчи gate был бы неприменим к доске.
    const f = await realBoard(false);
    try {
      const state = f.store.read();
      const [a, b, c] = f.tasks.map((t) => state.tasks.find((x) => x.id === t.id)!);
      assert.ok([a, b, c].every((t) => t.status === 'done'));
      const repo = f.h.config.repository;
      if (broken === 'replace')
        await git(repo, 'update-ref', `refs/replace/${c.resultSha}`, b.resultSha!);
      else
        f.store.change('fixture.anchor', (s) => {
          for (const run of s.runs)
            for (const e of run.evidence)
              if (e.kind === 'not-applicable' && e.notApplicable)
                e.notApplicable.ranges[0].from = 'd'.repeat(40);
        });
      const accepted = await acceptBoard(f.h, f.board.id, 'codex', false, undefined, {
        root: f.root,
      });
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual(
        (accepted as { coverage?: { gates: string[]; sha: string }[] }).coverage?.map((x) => [
          x.gates,
          x.sha,
        ]),
        [[['ui'], c.resultSha]],
      );
    } finally {
      // Слот demo восстанавливается из снимка целиком: ссылка замены не переживёт тест.
      f.cleanup();
    }
  });
