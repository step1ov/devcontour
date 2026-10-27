import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { CLIP_SHORT } from 'devcontour-harness';
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
  scopeGapWarning,
  uncoveredGates,
  type BoardCoverage,
} from '../src/core/service.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard, reviewPlan } from '../src/runner/agent-control.ts';
import { journalError } from '../src/runner/board-coverage.ts';
import { AgentService } from '../src/application/agent.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { completion, receiptHolds, taskOwner } from '../src/core/sync-state.ts';
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
async function realBoard(
  broken: boolean,
  options: { marker?: string; emptyB?: boolean; install?: boolean } = {},
) {
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
      "!existsSync('SMOKE_BROKEN') && process.env.DEVCONTOUR_PHASE === 'integration' && process.env.DEVCONTOUR_RUN_ID.startsWith('BC-')" +
        (options.install ? " && existsSync('.deps/ok')" : ''),
    ),
  );
  await git(config.repository, 'add', '.');
  await git(config.repository, 'commit', '-m', 'Gates unit and smoke');
  await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
  config.gates = [
    // Профиль в режиме порядка массива: установка первой, без dependsOn.
    ...(options.install
      ? [
          {
            id: 'install',
            kind: 'check' as const,
            command: [
              process.execPath,
              '-e',
              "require('fs').mkdirSync('.deps',{recursive:true});require('fs').writeFileSync('.deps/ok','1')",
            ],
            timeoutMs: 60_000,
          },
        ]
      : []),
    { ...gate('unit'), command: [process.execPath, 'unit.mjs'] },
    { ...gate('smoke'), command: [process.execPath, 'smoke.mjs'] },
  ];
  // Второй непокрытый gate, исход которого задаётся вне дерева: провал и
  // проход на одном и том же итоговом SHA.
  if (options.marker)
    config.gates.push({
      ...gate('nightly'),
      command: [
        process.execPath,
        '-e',
        junit(`!existsSync(${JSON.stringify(options.marker)})`).replace(
          /^import .*\n/,
          "const { writeFileSync, mkdirSync, existsSync } = require('node:fs');\n",
        ),
      ],
    });
  config.protectedPaths = [...config.protectedPaths, 'unit.mjs', 'smoke.mjs'];
  const board = h.createBoard('Scoped release');
  const scope = options.install ? ['install', 'unit'] : ['unit'];
  const a = h.addTask(board.id, { ...input('Part A'), gates: scope });
  const b = h.addTask(board.id, { ...input('Part B', [a.id]), gates: scope });
  h.approve(board.id);
  const runtimes = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (r.review)
          return {
            data: {
              approved: true,
              summary: 'Looks fine',
              findings: [],
              ...(options.emptyB && r.task.id === b.id
                ? {
                    alreadySatisfied: {
                      gates: ['unit'],
                      evidence: 'Part A already delivered this part; unit is green on this SHA.',
                    },
                  }
                : {}),
            },
            log: 'fixture',
            command: ['fixture'],
          };
        if (options.emptyB && r.task.id === b.id)
          return {
            data: { completed: true, summary: 'Already delivered by Part A' },
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
  const marks = await mkdtemp(join(tmpdir(), 'devcontour-coverage-mark-'));
  const marker = join(marks, 'NIGHTLY_BROKEN');
  await writeFile(marker, 'x\n');
  const f = await realBoard(true, { marker });
  try {
    const state = f.store.read();
    assert.ok(state.tasks.every((t) => t.status === 'done'));
    const head = state.tasks.find((t) => t.id === f.tasks[1].id)!.resultSha!;
    // Оба провала — одним отказом: стадия не тратит попытку на каждый gate.
    await assert.rejects(
      acceptBoard(f.h, f.board.id, 'codex', false, undefined, { root: f.root }),
      (e: Error) => {
        assert.ok(e.message.includes(`main/smoke на ${head}`), e.message);
        assert.ok(e.message.includes(`main/nightly на ${head}`), e.message);
        return true;
      },
    );
    const events = f.store
      .events()
      .filter((e) => e.type.startsWith('board.coverage.'))
      .reverse()
      .map((e) => [
        e.type,
        (e.data as { gates: string[]; failures?: string[] }).gates,
        (e.data as { failures?: string[] }).failures,
      ]);
    assert.deepEqual(events, [
      ['board.coverage.started', ['smoke', 'nightly'], undefined],
      ['board.coverage.failed', ['smoke', 'nightly'], ['smoke', 'nightly']],
    ]);
    const record = f.store.localRecord<BoardCoverage>(
      BOARD_COVERAGE,
      'main',
      boardCoverageKey(f.board.id, 1),
    )!;
    assert.equal(record.failure?.gate, 'smoke');
    assert.deepEqual(
      record.evidence.map((e) => [e.gate, e.sha, e.passed]),
      [
        ['smoke', head, false],
        ['nightly', head, false],
      ],
    );
    assert.equal(f.store.read().boards[0].revisions.at(-1)!.status, 'active');
    // Без каталога состояния (HTTP accept без планировщика) проверки доски
    // нет — и приёмки тоже; отказ называет, чем принять доску.
    await assert.rejects(acceptBoard(f.h, f.board.id, 'codex'), (e: Error) => {
      assert.match(e.message, /Полный набор проверок не пройден: main: smoke/);
      assert.ok(e.message.includes(`devcontour accept --board ${f.board.id}`), e.message);
      assert.match(e.message, /стадией 2 workflow/);
      return true;
    });
    // Отказ самой проверки (здесь — prepare компонента) тоже закрывает
    // начатую проверку событием failed с причиной.
    f.h.config.prepare = [
      {
        id: 'broken-prepare',
        command: [process.execPath, '-e', 'process.exit(3)'],
        timeoutMs: 60_000,
      },
    ] as never;
    await assert.rejects(acceptBoard(f.h, f.board.id, 'codex', false, undefined, { root: f.root }));
    const last = f.store
      .events()
      .filter((e) => e.type.startsWith('board.coverage.'))
      .slice(0, 2)
      .reverse()
      .map((e) => [e.type, (e.data as { error?: string }).error !== undefined]);
    assert.deepEqual(last, [
      ['board.coverage.started', false],
      ['board.coverage.failed', true],
    ]);
    // В журнале — код и короткое сообщение без локальных путей.
    const failedEvent = f.store.events().find((e) => e.type === 'board.coverage.failed')!;
    const error = (failedEvent.data as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'CHECK_FAILED');
    assert.ok(error.message.length > 0 && error.message.length <= CLIP_SHORT + 1, error.message);
    for (const local of [f.root, f.config.repository, homedir()])
      assert.ok(!error.message.includes(local), error.message);
  } finally {
    await f.cleanup();
    await rm(marks, { recursive: true, force: true });
  }
});

test('Повтор приёмки после частичного провала сохраняет прошедшие gates проверки доски: второй прогон исполняет только упавший', async () => {
  const marks = await mkdtemp(join(tmpdir(), 'devcontour-coverage-mark-'));
  const marker = join(marks, 'NIGHTLY_BROKEN');
  await writeFile(marker, 'x\n');
  const f = await realBoard(false, { marker });
  try {
    const head = f.store.read().tasks.find((t) => t.id === f.tasks[1].id)!.resultSha!;
    await assert.rejects(
      acceptBoard(f.h, f.board.id, 'codex', false, undefined, { root: f.root }),
      /main\/nightly/,
    );
    const key = boardCoverageKey(f.board.id, 1);
    const first = f.store.localRecord<BoardCoverage>(BOARD_COVERAGE, 'main', key)!;
    assert.deepEqual(
      first.evidence.map((e) => [e.gate, e.passed]),
      [
        ['smoke', true],
        ['nightly', false],
      ],
    );
    await rm(marker);
    const accepted = await acceptBoard(f.h, f.board.id, 'codex', false, undefined, {
      root: f.root,
    });
    assert.equal(accepted.status, 'accepted');
    const second = f.store.localRecord<BoardCoverage>(BOARD_COVERAGE, 'main', key)!;
    assert.deepEqual(
      second.evidence.map((e) => [e.gate, e.passed, e.sha]),
      [
        ['smoke', true, head],
        ['nightly', true, head],
      ],
      'прошедший smoke сохранён, повторён только nightly',
    );
    assert.equal(second.evidence[0].id, first.evidence[0].id);
  } finally {
    await f.cleanup();
    await rm(marks, { recursive: true, force: true });
  }
});

test('Задача, работу которой сделала зависимость, — done без коммита и проходит receipt, принятую историю и метрики', async () => {
  const f = await realBoard(false, { emptyB: true });
  try {
    const state = f.store.read();
    const [a, b] = f.tasks.map((t) => state.tasks.find((x) => x.id === t.id)!);
    assert.equal(b.status, 'done', b.failure);
    assert.equal(b.resultSha, a.resultSha, 'нового коммита нет');
    const run = state.runs.find((r) => r.taskId === b.id && r.status === 'succeeded')!;
    assert.equal(run.candidateSha, run.baseSha);
    // Receipt строится и подтверждается текущей конфигурацией у получателя.
    const receipt = completion(f.h, state, b);
    assert.equal(receipt.resultSha, b.resultSha);
    const received = { ...b, sharedCompletion: { receipt, sourceCommit: b.resultSha! } };
    assert.ok(
      receiptHolds(
        f.h,
        { ...state, tasks: state.tasks.map((t) => (t.id === b.id ? received : t)) },
        received,
      ),
    );
    const accepted = await acceptBoard(f.h, f.board.id, 'codex', false, undefined, {
      root: f.root,
    });
    assert.equal(accepted.status, 'accepted');
    const revision = f.store.read().boards[0].revisions.at(-1)!;
    assert.deepEqual(
      revision.snapshot?.tasks.map((t) => [t.id, t.resultSha]),
      [
        [a.id, a.resultSha],
        [b.id, a.resultSha],
      ],
    );
    const metrics = workflowMetrics(f.h, taskOwner(b));
    assert.ok(
      metrics.attempts.some((m) => m.taskId === b.id && m.status === 'succeeded'),
      'метрики видят попытку без коммита',
    );
  } finally {
    await f.cleanup();
  }
});

test('Профиль в порядке массива: проверка доски исполняет непокрытый gate после более ранних check gates (установки), как их исполняли задачи', async () => {
  const f = await realBoard(false, { install: true });
  try {
    const state = f.store.read();
    assert.ok(
      state.tasks.every((t) => t.status === 'done'),
      JSON.stringify(state.tasks.map((t) => [t.id, t.status, t.failure])),
    );
    const head = state.tasks.find((t) => t.id === f.tasks[1].id)!.resultSha!;
    const accepted = await acceptBoard(f.h, f.board.id, 'codex', false, undefined, {
      root: f.root,
    });
    assert.equal(accepted.status, 'accepted');
    const record = f.store.localRecord<BoardCoverage>(
      BOARD_COVERAGE,
      'main',
      boardCoverageKey(f.board.id, 1),
    )!;
    assert.deepEqual(
      record.evidence.map((e) => [e.gate, e.passed, e.sha]),
      [
        ['install', true, head],
        ['smoke', true, head],
      ],
      'установка исполнена перед smoke, ранний unit не повторён',
    );
    assert.deepEqual(
      f.store
        .events()
        .filter((e) => e.type.startsWith('board.coverage.'))
        .map((e) => e.type)
        .reverse(),
      ['board.coverage.started', 'board.coverage.passed'],
    );
  } finally {
    await f.cleanup();
  }
});

test('Прогноз пробела называет предпосылки проверки доски и gates, которым проверка доски не даст подготовки', () => {
  const f = fixture();
  try {
    const check = (id: string) => ({
      id,
      kind: 'check' as const,
      command: ['node', id + '.mjs'],
      timeoutMs: 60_000,
    });
    f.h.config.gates = [gate('nightly'), check('install'), gate('unit'), gate('engine')];
    const b = f.h.createBoard('Array order', '', 'main');
    f.h.addTask(b.id, { ...input('Unit part'), gates: ['install', 'unit'] });
    const gaps = scopeGaps(f.h, f.store.read().tasks);
    assert.deepEqual(gaps, [
      {
        repositoryId: 'main',
        gates: ['nightly', 'engine'],
        prerequisites: ['install'],
        withoutSetup: ['nightly'],
      },
    ]);
    const warning = scopeGapWarning(gaps)!;
    assert.match(warning, /с предпосылками install/);
    assert.match(warning, /Без подготовки окружения: main: nightly/);
    // Prepare компонента — подготовка есть: предупреждения нет.
    f.h.config.prepare = [{ command: ['node', 'setup.mjs'], timeoutMs: 60_000 }] as never;
    assert.equal(scopeGaps(f.h, f.store.read().tasks)[0].withoutSetup, undefined);
  } finally {
    f.cleanup();
  }
});

test('Ошибка проверки доски в журнале — код и короткое сообщение без локальных путей', () => {
  const root = join(tmpdir(), 'devcontour-root-fixture');
  const error = journalError(
    new Error(
      `spawn failed in ${root}/gates-at/BC-1/worktree and ${homedir()}/.cache: ` + 'x'.repeat(3000),
    ),
    [root],
  );
  assert.equal(error.code, 'CHECK_FAILED');
  assert.ok(error.message.length <= CLIP_SHORT + 1, String(error.message.length));
  assert.ok(!error.message.includes(root), error.message);
  assert.ok(!error.message.includes(homedir()), error.message);
  assert.match(error.message, /^spawn failed in /);
});
