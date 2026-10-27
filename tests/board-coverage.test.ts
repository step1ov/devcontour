import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import {
  BOARD_COVERAGE,
  DevContour,
  boardCoverageKey,
  digest,
  scopeGaps,
  uncoveredGates,
  type BoardCoverage,
} from '../src/core/service.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard, reviewPlan } from '../src/runner/agent-control.ts';
import { AgentService } from '../src/application/agent.ts';
import { adapters, type AgentAdapter, type AgentRequest } from '../src/runner/adapters.ts';
import { CANDIDATE, closePrevious, fixture, input, MERGED } from './helpers.ts';

const gate = (id: string) => ({
  id,
  kind: 'test' as const,
  command: ['node', id + '.mjs'],
  timeoutMs: 60_000,
  report: { type: 'junit' as const, path: `.reports/${id}.xml` },
});

function reviewers(): Record<'codex' | 'claude', AgentAdapter> {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute: (r) =>
      Promise.resolve({
        data: {
          approved: true,
          summary: 'Fixture',
          findings: [],
          previous: closePrevious(r.prompt),
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      }),
  });
  return { codex: make('codex'), claude: make('claude') };
}

test('Пробел областей задач виден при ревью плана и регистрации workflow, до исполнения', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    f.h.config.approvalMode = 'operator';
    f.h.config.gates = [gate('unit'), gate('engine'), gate('nightly')];
    const b = f.h.createBoard('Scoped', '', 'main');
    const one = f.h.addTask(b.id, { ...input('Unit part'), gates: ['unit'] });
    const two = f.h.addTask(b.id, { ...input('Engine part'), gates: ['engine'] });
    // Отменённая задача ничего не покрывает, даже с полным профилем.
    const dropped = f.h.addTask(b.id, input('Dropped full-profile part'));
    f.h.cancel(dropped.id, 'Not part of this release');
    assert.deepEqual(scopeGaps(f.h, f.store.read().tasks), [
      { repositoryId: 'main', gates: ['nightly'] },
    ]);
    const plan = await reviewPlan(f.h, f.root, b.id, 'claude', reviewers());
    assert.deepEqual(plan.coverageGaps, [{ repositoryId: 'main', gates: ['nightly'] }]);
    assert.match(String(plan.warning), /не включают gates: main: nightly/);
    assert.match(String(plan.warning), /итоговом integration SHA доски/);
    f.h.approve(b.id);
    const started = new AgentService(f.h).execute({
      operation: 'workflow_start',
      input: { kind: 'board', id: b.id, authorRuntime: 'codex' },
    });
    assert.deepEqual(started.coverageGaps, [
      { boardId: b.id, repositoryId: 'main', gates: ['nightly'] },
    ]);
    assert.match(String(started.warning), /nightly/);
    assert.ok(started.key, 'регистрация не отклонена: приёмка выполнит пробел сама');
    // Задача без области — весь профиль: пробела нет, предупреждения нет.
    const full = f.h.createBoard('Full', '', 'main');
    f.h.addTask(full.id, input('Full profile part'));
    f.h.approve(full.id);
    const plain = new AgentService(f.h).execute({
      operation: 'workflow_start',
      input: { kind: 'board', id: full.id, authorRuntime: 'codex' },
    });
    assert.equal(plain.coverageGaps, undefined);
    assert.equal(plain.warning, undefined);
    void one;
    void two;
  } finally {
    f.cleanup();
  }
});

test('Покрытие доски засчитывает проверку доски только на её итоговом SHA, под действующим договором и для той же ревизии', () => {
  const f = fixture();
  try {
    f.h.config.gates = [gate('unit'), gate('nightly')];
    const b = f.h.createBoard('Binding', '', 'main');
    const t = f.h.addTask(b.id, { ...input('Unit part'), gates: ['unit'] });
    f.h.approve(b.id);
    // PASS ровно по требуемым gates задачи на обеих фазах.
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    f.h.phase(run.id, run.token, 'integrating', {
      candidateSha: CANDIDATE,
      integrationSha: MERGED,
    });
    for (const phase of ['candidate', 'integration'] as const)
      for (const id of [...run.requiredGates!, 'independent-review'])
        f.h.evidence(run.id, run.token, {
          kind: id === 'independent-review' ? 'review' : 'test',
          phase,
          sha: phase === 'candidate' ? CANDIDATE : MERGED,
          gate: id,
          passed: true,
          command: ['fixture'],
          exitCode: 0,
          log: 'fixture',
          digest: 'e'.repeat(64),
          summary: 'Scoped fixture',
        });
    f.h.finish(run.id, run.token, MERGED);
    const revision = f.store.read().boards[0].revisions.at(-1)!;
    const save = (patch: Partial<BoardCoverage>) =>
      f.store.atomic(() =>
        f.store.saveLocal(BOARD_COVERAGE, 'main', boardCoverageKey(b.id, revision.number), {
          boardId: b.id,
          revision: revision.number,
          repositoryId: 'main',
          sha: MERGED,
          policyDigest: f.h.policyDigest('main'),
          revisionDigest: digest(revision),
          runId: 'BC-fixture',
          gates: ['nightly'],
          evidence: [
            {
              id: 'e1',
              runId: 'BC-fixture',
              kind: 'test',
              phase: 'integration',
              sha: MERGED,
              gate: 'nightly',
              passed: true,
              createdAt: new Date().toISOString(),
              command: ['node', 'nightly.mjs'],
              exitCode: 0,
              log: 'fixture',
              digest: 'e'.repeat(64),
              summary: 'ok',
            },
          ],
          at: new Date().toISOString(),
          ...patch,
        } satisfies BoardCoverage),
      );
    const refused = /Полный набор проверок не пройден: main: nightly/;
    save({ sha: 'd'.repeat(40) });
    assert.throws(() => f.h.accept(b.id, MERGED, undefined, undefined, { main: MERGED }), refused);
    save({ policyDigest: 'f'.repeat(64) });
    assert.throws(() => f.h.accept(b.id, MERGED, undefined, undefined, { main: MERGED }), refused);
    save({ revisionDigest: 'f'.repeat(64) });
    assert.throws(() => f.h.accept(b.id, MERGED, undefined, undefined, { main: MERGED }), refused);
    save({});
    f.h.accept(b.id, MERGED, undefined, undefined, { main: MERGED });
    assert.equal(f.store.read().boards[0].revisions.at(-1)!.status, 'accepted');
  } finally {
    f.cleanup();
  }
});

/**
 * Настоящий Git: две задачи доказывают себя только `unit`, а профиль требует
 * ещё `smoke`. Smoke проходит только в окружении проверки доски (фаза
 * integration, runId проверки доски) и падает, если в дереве итогового SHA
 * есть SMOKE_BROKEN.
 */
async function realBoard(broken: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-coverage-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  store.change('fixture.reset', (s) => {
    s.tasks = [];
    s.boards = [];
    s.runs = [];
  });
  const junit = (ok: string) => `import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
const ok = ${ok};
mkdirSync('.reports', { recursive: true });
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="case">' + (ok ? '' : '<failure message="no"/>') + '</testcase></testsuite>');
process.exit(ok ? 0 : 1);
`;
  await writeFile(join(config.repository, 'unit.mjs'), junit('true'));
  await writeFile(
    join(config.repository, 'smoke.mjs'),
    junit(
      "!existsSync('SMOKE_BROKEN') && process.env.DEVCONTOUR_PHASE === 'integration' && process.env.DEVCONTOUR_RUN_ID.startsWith('BC-')",
    ),
  );
  await git(config.repository, 'add', '.');
  await git(config.repository, 'commit', '-m', 'Gates unit and smoke');
  await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
  config.gates = [
    { ...gate('unit'), command: [process.execPath, 'unit.mjs'] },
    { ...gate('smoke'), command: [process.execPath, 'smoke.mjs'] },
  ];
  config.protectedPaths = [...config.protectedPaths, 'unit.mjs', 'smoke.mjs'];
  const board = h.createBoard('Scoped release');
  const a = h.addTask(board.id, { ...input('Part A'), gates: ['unit'] });
  const b = h.addTask(board.id, { ...input('Part B', [a.id]), gates: ['unit'] });
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
        await writeFile(join(r.cwd, `part-${r.task.id}.txt`), r.task.title + '\n');
        if (broken && r.task.id === b.id) await writeFile(join(r.cwd, 'SMOKE_BROKEN'), 'x\n');
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
    config,
    store,
    h,
    board,
    tasks: [a, b],
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Приёмка доски выполняет непокрытые gates один раз на итоговом SHA и принимает доску, только когда они прошли', async () => {
  const f = await realBoard(false);
  try {
    const state = f.store.read();
    assert.ok(
      state.tasks.every((t) => t.status === 'done'),
      JSON.stringify(state.tasks.map((t) => [t.id, t.status, t.failure])),
    );
    const head = state.tasks.find((t) => t.id === f.tasks[1].id)!.resultSha!;
    assert.deepEqual(uncoveredGates(f.h, state, state.tasks), [
      { repositoryId: 'main', gates: ['smoke'] },
    ]);
    // Без проверки доски приёмка по-прежнему невозможна.
    assert.throws(
      () => f.h.accept(f.board.id, head, undefined, undefined, { main: head }),
      /Полный набор проверок не пройден: main: smoke/,
    );
    const accepted = await acceptBoard(f.h, f.board.id, 'codex', false, undefined, {
      root: f.root,
    });
    assert.equal(accepted.status, 'accepted');
    assert.deepEqual(
      (accepted as { coverage?: { gates: string[]; sha: string }[] }).coverage?.map((c) => [
        c.gates,
        c.sha,
      ]),
      [[['smoke'], head]],
    );
    const record = f.store.localRecord<BoardCoverage>(
      BOARD_COVERAGE,
      'main',
      boardCoverageKey(f.board.id, 1),
    )!;
    assert.equal(record.sha, head, 'evidence привязано к итоговому SHA доски');
    assert.equal(record.policyDigest, f.h.policyDigest('main'));
    assert.deepEqual(
      record.evidence.map((e) => [e.gate, e.kind, e.phase, e.sha, e.passed]),
      [['smoke', 'test', 'integration', head, true]],
    );
    const revision = f.store.read().boards[0].revisions.at(-1)!;
    assert.equal(revision.status, 'accepted');
    assert.equal(revision.snapshot?.sha, head);
  } finally {
    await f.cleanup();
  }
});

test('Провал непокрытого gate на итоговом SHA доски — отказ приёмки с названным gate; evidence провала записано', async () => {
  const f = await realBoard(true);
  try {
    const state = f.store.read();
    assert.ok(state.tasks.every((t) => t.status === 'done'));
    const head = state.tasks.find((t) => t.id === f.tasks[1].id)!.resultSha!;
    await assert.rejects(
      acceptBoard(f.h, f.board.id, 'codex', false, undefined, { root: f.root }),
      new RegExp(`Проверка доски на итоговом SHA ${head} не пройдена: main/smoke`),
    );
    const record = f.store.localRecord<BoardCoverage>(
      BOARD_COVERAGE,
      'main',
      boardCoverageKey(f.board.id, 1),
    )!;
    assert.equal(record.failure?.gate, 'smoke');
    assert.deepEqual(
      record.evidence.map((e) => [e.gate, e.sha, e.passed]),
      [['smoke', head, false]],
    );
    assert.equal(f.store.read().boards[0].revisions.at(-1)!.status, 'active');
    // Без каталога состояния проверки доски нет — и приёмки тоже.
    await assert.rejects(
      acceptBoard(f.h, f.board.id, 'codex'),
      /Полный набор проверок не пройден: main: smoke/,
    );
  } finally {
    await f.cleanup();
  }
});
