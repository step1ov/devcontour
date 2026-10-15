import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, fixture, input } from './helpers.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { repositorySchema } from '../src/core/model.ts';
import { assertDependencies, dependencyFreshness } from '../src/runner/dependencies.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { receiptSchema } from '../src/core/sync-model.ts';
import { completion, validateReceipt } from '../src/core/sync-state.ts';
import { requirementProof } from '../src/core/proof.ts';
import { uncoveredGates } from '../src/core/service.ts';
import { expandGates, repository } from '../src/core/repositories.ts';
import type { Evidence } from '../src/core/model.ts';

/**
 * Композиция и выбор регрессионных gates: свежесть зависимостей (G03) и
 * снимок зависимостей в квитанции.
 */
test('G03: dependency freshness at finish is recorded against the branch head, and the receipt carries the snapshot and the head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-dependency-fresh-'));
  try {
    const lib = join(root, 'library');
    const sh = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd })
        .toString()
        .trim();
    execFileSync('mkdir', ['-p', lib]);
    sh(lib, 'init', '-q', '-b', 'main');
    await writeFile(join(lib, 'index.mjs'), 'export const v = 1;\n');
    sh(lib, 'add', '.');
    sh(lib, 'commit', '-qm', 'v1');
    sh(lib, 'branch', 'devcontour/accepted');
    const snapshotSha = sh(lib, 'rev-parse', 'devcontour/accepted');
    const worktree = join(root, 'snapshot');
    sh(lib, 'worktree', 'add', '--detach', worktree, snapshotSha);
    const base = config();
    const c = {
      ...base,
      repositories: [
        repositorySchema.parse({ id: 'library', name: 'Library', path: lib, gates: base.gates }),
      ],
    };
    const snapshots = [
      {
        repositoryId: 'library',
        sha: snapshotSha,
        tree: sh(worktree, 'rev-parse', 'HEAD^{tree}'),
        path: worktree,
        artifacts: [],
      },
    ];
    // Ветка на месте — снимок свежий.
    await assertDependencies(snapshots);
    assert.deepEqual(await dependencyFreshness(snapshots, c), [
      { repositoryId: 'library', snapshot: snapshotSha, head: snapshotSha, fresh: true },
    ]);
    // Зависимость продвинулась параллельной работой: снимок устарел, и это
    // зафиксировано, а не скрыто.
    await writeFile(join(lib, 'index.mjs'), 'export const v = 2;\n');
    sh(lib, 'commit', '-qam', 'v2');
    sh(lib, 'branch', '-f', 'devcontour/accepted', 'HEAD');
    const head = sh(lib, 'rev-parse', 'HEAD');
    assert.deepEqual(await dependencyFreshness(snapshots, c), [
      { repositoryId: 'library', snapshot: snapshotSha, head, fresh: false },
    ]);
    // Квитанция переносит снимок зависимостей.
    const hash = 'a'.repeat(64);
    const receipt = receiptSchema.parse({
      id: 'R-1',
      taskId: 'T-1',
      repositoryId: 'product',
      specDigest: hash,
      policyDigest: hash,
      candidateSha: snapshotSha,
      resultSha: snapshotSha,
      finishedAt: new Date().toISOString(),
      runtime: 'codex',
      reviewer: 'claude',
      requiredGates: ['unit'],
      checks: ['candidate', 'integration'].flatMap((phase) =>
        ['test', 'review'].map((kind) => ({
          kind,
          phase,
          sha: snapshotSha,
          gate: kind === 'test' ? 'unit' : 'independent-review',
          passed: true,
          exitCode: 0,
          digest: hash,
        })),
      ),
      dependencies: [
        { repositoryId: 'library', sha: snapshotSha, tree: snapshots[0].tree, head, artifacts: [] },
      ],
    });
    assert.equal(receipt.dependencies?.[0].sha, snapshotSha);
    assert.equal(receipt.dependencies?.[0].head, head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('G05: metrics measure the selected scope against the full profile, workspace gate time and board coverage', () => {
  const f = fixture();
  try {
    const gate = (id: string) => ({
      id,
      kind: 'test' as const,
      command: ['node', id + '.mjs'],
      timeoutMs: 60_000,
      report: { type: 'junit' as const, path: `.reports/${id}.xml` },
    });
    f.h.config.gates = [gate('unit'), gate('engine')];
    const b = f.h.createBoard('Measured');
    const whole = f.h.addTask(b.id, input('Whole profile'));
    const narrow = f.h.addTask(b.id, { ...input('Narrow'), gates: ['unit'] });
    const at = (ms: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + ms).toISOString();
    const timing = (stage: string, from: number, ms: number) => ({
      id: stage + from,
      stage,
      startedAt: at(from),
      finishedAt: at(from + ms),
    });
    f.store.change('fixture.runs', (s) => {
      const base = {
        status: 'succeeded' as const,
        attempt: 1,
        token: 't',
        leaseUntil: 0,
        policyDigest: 'p',
        runtime: 'codex' as const,
        reviewer: 'claude' as const,
        evidence: [],
        startedAt: at(0),
        finishedAt: at(100_000),
        repositoryId: 'main',
      };
      const ev = (phase: string, gate: string, command: string[]) => ({
        kind: 'test',
        phase,
        sha: 'x',
        gate,
        passed: true,
        command,
      });
      s.runs.push(
        {
          ...base,
          id: 'R-whole',
          taskId: whole.id,
          requiredGates: ['unit', 'engine'],
          evidence: [
            ev('candidate', 'engine', ['node', 'engine.mjs']),
            ev('integration', 'engine', ['node', 'engine.mjs']),
          ],
          timings: [
            timing('candidate-test:unit', 0, 1_000),
            timing('candidate-test:engine', 1_000, 4_000),
            timing('integration-test:unit', 5_000, 1_000),
            timing('integration-test:engine', 6_000, 6_000),
          ],
        } as never,
        // Прежняя команда engine: её замеры с текущей не сопоставимы.
        {
          ...base,
          id: 'R-old-command',
          taskId: whole.id,
          startedAt: at(50_000),
          requiredGates: ['unit', 'engine'],
          evidence: [
            ev('candidate', 'engine', ['node', 'old-engine.mjs']),
            ev('integration', 'engine', ['node', 'old-engine.mjs']),
          ],
          timings: [
            timing('candidate-test:engine', 50_000, 100_000),
            timing('integration-test:engine', 150_000, 100_000),
          ],
        } as never,
        // Позже узкой попытки: в её оценку не входит.
        {
          ...base,
          id: 'R-later',
          taskId: whole.id,
          startedAt: at(900_000),
          requiredGates: ['unit', 'engine'],
          evidence: [
            ev('candidate', 'engine', ['node', 'engine.mjs']),
            ev('integration', 'engine', ['node', 'engine.mjs']),
          ],
          timings: [
            timing('candidate-test:engine', 900_000, 50_000),
            timing('integration-test:engine', 950_000, 50_000),
          ],
        } as never,
        // Область есть, таймингов нет: неизмеренная попытка, а не нулевая.
        {
          ...base,
          id: 'R-unmeasured',
          taskId: narrow.id,
          startedAt: at(300_000),
          requiredGates: ['unit'],
        } as never,
        {
          ...base,
          id: 'R-narrow',
          taskId: narrow.id,
          startedAt: at(200_000),
          requiredGates: ['unit'],
          dependencyFreshness: [
            {
              repositoryId: 'library',
              snapshot: 'a'.repeat(40),
              head: 'b'.repeat(40),
              fresh: false,
            },
          ],
          timings: [
            timing('candidate-test:unit', 0, 2_000),
            timing('integration-test:unit', 2_000, 2_000),
          ],
        } as never,
      );
      s.changeSets.push({
        id: 'CHG-1',
        title: 'Measured',
        description: '',
        boardIds: [b.id],
        createdAt: at(0),
        verifications: [
          {
            id: 'V-1',
            token: 't',
            leaseUntil: 0,
            startedAt: at(0),
            status: 'passed',
            policyDigest: 'p',
            specDigest: 's',
            tasks: [],
            boards: [],
            evidence: [
              {
                gate: 'e2e',
                passed: true,
                command: [],
                exitCode: 0,
                log: '',
                digest: 'd',
                summary: '',
                artifacts: [],
                durationMs: 3_000,
              },
              {
                gate: 'e2e',
                passed: true,
                command: [],
                exitCode: 0,
                log: '',
                digest: 'd',
                summary: '',
                artifacts: [],
                durationMs: 5_000,
              },
            ],
          },
        ],
      });
      // Узкая задача завершена, но engine в ней не проходил integration.
      const t = s.tasks.find((x) => x.id === narrow.id)!;
      t.status = 'done';
      t.resultSha = 'a'.repeat(40);
    });
    const scope = workflowMetrics(f.h, 'main').gateScope;
    const narrowAttempt = scope.attempts.perAttempt.find((a) => a.runId === 'R-narrow')!;
    // Узкая попытка: 4 с выбранной области; полный набор — плюс медианы
    // engine той же команды из более ранних прогонов по фазам: 4 с и 6 с.
    // Замеры прежней команды (100 с) и более поздней попытки (50 с) не входят.
    assert.deepEqual(narrowAttempt, {
      runId: 'R-narrow',
      taskId: narrow.id,
      repositoryId: 'main',
      selectedMs: 4_000,
      fullEstimateMs: 14_000,
      unestimatedGates: [],
    });
    assert.equal(
      scope.attempts.perAttempt.find((a) => a.runId === 'R-unmeasured')!.selectedMs,
      null,
    );
    assert.equal(scope.attempts.unmeasuredAttempts, 1);
    // Суммы — по попыткам с известной оценкой: whole 12 с, old 200 с, later 100 с, narrow.
    assert.equal(scope.attempts.estimatedAttempts, 4);
    assert.equal(scope.attempts.selectedMs, 12_000 + 200_000 + 100_000 + 4_000);
    assert.equal(scope.attempts.savedEstimateMs, 10_000);
    assert.deepEqual(scope.attempts.unestimatedGates, []);
    assert.deepEqual(scope.workspace.byGate, { e2e: { runs: 2, medianMs: 4_000 } });
    assert.equal(scope.workspace.totalMs, 8_000);
    // Результат, проверенный на устаревшем снимке зависимости, назван.
    assert.deepEqual(scope.dependencyFreshness, {
      checked: 1,
      stale: [{ runId: 'R-narrow', taskId: narrow.id, repositoryId: 'library' }],
    });
    // Незакрытая доска: у выполненной узкой задачи нет integration-evidence.
    assert.deepEqual(scope.coverage, [
      { boardId: b.id, uncovered: [{ repositoryId: 'main', gates: ['unit', 'engine'] }] },
    ]);
  } finally {
    f.cleanup();
  }
});

/**
 * Два компонента: library и product, зависящий от неё. Gate `test` продукта
 * читает value.json библиотеки по пути из DEVCONTOUR_COMPONENTS_JSON и ждёт
 * значения из DEVCONTOUR_EXPECT (по умолчанию 2).
 */
async function components() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-consumers-'));
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd })
      .toString()
      .trim();
  const verify = `import fs from 'node:fs';
const paths = JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);
const value = fs.readFileSync(paths.library + '/value.json', 'utf8').trim();
const ok = value === '2';
fs.mkdirSync('.reports', { recursive: true });
fs.writeFileSync('.reports/test.xml', ok
  ? '<testsuite tests="1" failures="0"><testcase name="consumer"/></testsuite>'
  : '<testsuite tests="1" failures="1"><testcase name="consumer"><failure message="library value ' + value + '"/></testcase></testsuite>');
process.exit(ok ? 0 : 1);
`;
  const gate = {
    id: 'test',
    kind: 'test' as const,
    command: [process.execPath, 'verify.mjs'],
    timeoutMs: 30_000,
    report: { type: 'junit' as const, path: '.reports/test.xml' },
  };
  const repos = [];
  for (const id of ['library', 'product', 'unrelated']) {
    const path = join(root, id);
    execFileSync('mkdir', ['-p', path]);
    sh(path, 'init', '-q', '-b', 'main');
    await writeFile(join(path, '.gitignore'), '.reports/\n');
    await writeFile(join(path, 'value.json'), '1\n');
    await writeFile(join(path, 'verify.mjs'), verify);
    sh(path, 'add', '.');
    sh(path, 'commit', '-qm', 'baseline');
    sh(path, 'branch', 'devcontour/accepted');
    repos.push(
      repositorySchema.parse({
        id,
        name: id,
        kind: id === 'library' ? 'library' : 'product',
        path,
        dependsOn: id === 'product' ? ['library'] : [],
        gates: [gate],
      }),
    );
  }
  const data = join(root, 'data');
  execFileSync('mkdir', ['-p', data]);
  const c = config({ repository: repos[0].path, repositories: repos, runTimeoutMs: 60_000 });
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(store, c);
  return {
    root,
    data,
    h,
    store,
    sh,
    repos,
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('G02: consumer checks are declared explicitly, recorded at dispatch and required at finish; their evidence never stands in for own gates', async () => {
  const f = await components();
  try {
    const board = f.h.createBoard('Library change', '', 'library');
    // Потребитель обязан зависеть от компонента задачи; свой компонент и
    // чужой gate — отказ.
    assert.throws(
      () =>
        f.h.addTask(board.id, {
          ...input('Wrong consumer'),
          repositoryId: 'library',
          consumers: [{ repositoryId: 'unrelated', gates: ['test'] }],
        }),
      /не зависит от library/,
    );
    assert.throws(
      () =>
        f.h.addTask(board.id, {
          ...input('Self consumer'),
          repositoryId: 'library',
          consumers: [{ repositoryId: 'library', gates: ['test'] }],
        }),
      /другой компонент/,
    );
    assert.throws(
      () =>
        f.h.addTask(board.id, {
          ...input('Foreign gate'),
          repositoryId: 'library',
          consumers: [{ repositoryId: 'product', gates: ['nightly'] }],
        }),
      /вне профиля/,
    );
    const task = f.h.addTask(board.id, {
      ...input('Change value'),
      repositoryId: 'library',
      consumers: [{ repositoryId: 'product', gates: ['test'] }],
    });
    f.h.approve(board.id);
    f.h.pause(false);
    const run = f.h.claim('worker')!;
    assert.equal(run.taskId, task.id);
    assert.deepEqual(run.consumers, [{ repositoryId: 'product', gates: ['test'] }]);
    f.h.phase(run.id, run.token, 'integrating', { candidateSha: 'c', integrationSha: 'm' });
    const record = (gate: string, phase: 'candidate' | 'integration', consumer?: string) =>
      f.h.evidence(run.id, run.token, {
        kind: gate === 'independent-review' ? 'review' : 'test',
        phase,
        sha: phase === 'candidate' ? 'c' : 'm',
        gate,
        ...(consumer ? { consumer } : {}),
        passed: true,
        command: ['fixture'],
        exitCode: 0,
        log: '',
        digest: 'd',
        summary: 'fixture',
      });
    // Только evidence потребителя: собственный test он не закрывает.
    record('test', 'candidate', 'product');
    record('test', 'integration', 'product');
    record('independent-review', 'candidate');
    record('independent-review', 'integration');
    assert.throws(() => f.h.finish(run.id, run.token, 'm'), /Нет PASS: candidate\/test/);
    // Собственные gates добавлены; проверку потребителя закрывает его evidence.
    record('test', 'candidate');
    record('test', 'integration');
    const second = f.store.read().runs.find((r) => r.id === run.id)!;
    assert.ok(second.evidence.some((e) => e.consumer === 'product'));
    f.h.finish(run.id, run.token, 'm');
    assert.equal(f.store.read().tasks.find((t) => t.id === task.id)!.status, 'done');
  } finally {
    await f.cleanup();
  }
});

test('G02: without a consumer PASS the task does not finish', async () => {
  const f = await components();
  try {
    const board = f.h.createBoard('Library change', '', 'library');
    f.h.addTask(board.id, {
      ...input('Change value'),
      repositoryId: 'library',
      consumers: [{ repositoryId: 'product', gates: ['test'] }],
    });
    f.h.approve(board.id);
    f.h.pause(false);
    const run = f.h.claim('worker')!;
    f.h.phase(run.id, run.token, 'integrating', { candidateSha: 'c', integrationSha: 'm' });
    for (const phase of ['candidate', 'integration'] as const)
      for (const gate of ['test', 'independent-review'])
        f.h.evidence(run.id, run.token, {
          kind: gate === 'test' ? 'test' : 'review',
          phase,
          sha: phase === 'candidate' ? 'c' : 'm',
          gate,
          passed: true,
          command: ['fixture'],
          exitCode: 0,
          log: '',
          digest: 'd',
          summary: 'fixture',
        });
    assert.throws(
      () => f.h.finish(run.id, run.token, 'm'),
      /Нет PASS проверки потребителя: product\/test/,
    );
  } finally {
    await f.cleanup();
  }
});

test('G02: the runner checks a consumer in its own worktree against the integrated result of the library', async () => {
  const f = await components();
  try {
    const board = f.h.createBoard('Library change', '', 'library');
    const task = f.h.addTask(board.id, {
      ...input('Change value'),
      repositoryId: 'library',
      consumers: [{ repositoryId: 'product', gates: ['test'] }],
    });
    f.h.approve(board.id);
    f.h.pause(false);
    const run = f.h.claim('worker')!;
    const library = f.repos[0].path;
    const scheduler = new Scheduler(f.h, f.data);
    const consume = (cwd: string, sha: string) =>
      (
        scheduler as unknown as {
          runConsumers(
            r: typeof run,
            t: typeof task,
            c: string,
            s: string,
            a: AbortSignal,
          ): Promise<void>;
        }
      ).runConsumers(
        run,
        f.store.read().tasks.find((t) => t.id === task.id)!,
        cwd,
        sha,
        new AbortController().signal,
      );
    // Интегрированный результат библиотеки: value.json = 2.
    const integrated = join(f.root, 'integration');
    f.sh(library, 'worktree', 'add', '--detach', integrated, 'devcontour/accepted');
    await writeFile(join(integrated, 'value.json'), '2\n');
    f.sh(integrated, 'commit', '-qam', 'value 2');
    const sha = f.sh(integrated, 'rev-parse', 'HEAD');
    f.h.phase(run.id, run.token, 'integrating', { candidateSha: sha, integrationSha: sha });
    await consume(integrated, sha);
    const evidence = f.store
      .read()
      .runs.find((r) => r.id === run.id)!
      .evidence.filter((e) => e.consumer === 'product');
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].passed, true, evidence[0].summary);
    assert.equal(evidence[0].phase, 'integration');
    assert.equal(evidence[0].sha, sha);
    // Целевая ветка продукта не тронута, рабочее дерево потребителя убрано.
    assert.equal(f.sh(f.repos[1].path, 'status', '--porcelain'), '');
    // Интегрированный результат без изменения (value.json = 1) — провал потребителя.
    const stale = join(f.root, 'stale');
    f.sh(library, 'worktree', 'add', '--detach', stale, 'devcontour/accepted');
    await assert.rejects(
      consume(stale, f.sh(stale, 'rev-parse', 'HEAD')),
      /integration\/product:test/,
    );
  } finally {
    await f.cleanup();
  }
});

test('G02: a transitive consumer is built against the integrated provider, runs its own prepare and lifecycle, records what it checked and leaves no worktrees, even on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-consumer-chain-'));
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd })
      .toString()
      .trim();
  const node = (code: string) => [process.execPath, '-e', code];
  const log = join(root, 'lifecycle.log');
  // Промежуточный компонент собирает артефакт из значения библиотеки;
  // потребитель видит библиотеку только через этот артефакт.
  const build = node(
    `const fs=require('fs');const p=JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);fs.writeFileSync('built.json',fs.readFileSync(p.library+'/value.json','utf8'))`,
  );
  const verify = `import fs from 'node:fs';
const paths = JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);
const via = fs.readFileSync(paths.mid + '/built.json', 'utf8').trim();
const prepared = fs.existsSync('.prepared');
const ok = via === '2' && prepared;
fs.mkdirSync('.reports', { recursive: true });
fs.writeFileSync('.reports/test.xml', '<testsuite tests="1" failures="' + (ok ? 0 : 1) + '"><testcase name="chain">' + (ok ? '' : '<failure message="via ' + via + ' prepared ' + prepared + '"/>') + '</testcase></testsuite>');
process.exit(ok ? 0 : 1);
`;
  const gate = {
    id: 'test',
    kind: 'test' as const,
    command: [process.execPath, 'verify.mjs'],
    timeoutMs: 30_000,
    report: { type: 'junit' as const, path: '.reports/test.xml' },
  };
  const repos = [];
  for (const id of ['library', 'mid', 'product']) {
    const path = join(root, id);
    execFileSync('mkdir', ['-p', path]);
    sh(path, 'init', '-q', '-b', 'main');
    await writeFile(join(path, '.gitignore'), '.reports/\nbuilt.json\n.prepared\n');
    await writeFile(join(path, 'value.json'), '1\n');
    await writeFile(join(path, 'verify.mjs'), verify);
    sh(path, 'add', '.');
    sh(path, 'commit', '-qm', 'baseline');
    sh(path, 'branch', 'devcontour/accepted');
    repos.push(
      repositorySchema.parse({
        id,
        name: id,
        kind: id === 'product' ? 'product' : 'library',
        path,
        dependsOn: id === 'mid' ? ['library'] : id === 'product' ? ['mid'] : [],
        gates: [gate],
        ...(id === 'mid'
          ? {
              dependencyBuild: [{ id: 'build', command: build }],
              dependencyArtifacts: ['built.json'],
            }
          : {}),
        ...(id === 'product'
          ? {
              prepare: [
                { id: 'install', command: node(`require('fs').writeFileSync('.prepared','')`) },
              ],
              lifecycle: {
                setup: [
                  {
                    id: 'up',
                    command: node(
                      `require('fs').appendFileSync(${JSON.stringify(log)},'setup\\n')`,
                    ),
                  },
                ],
                teardown: [
                  {
                    id: 'down',
                    command: node(
                      `require('fs').appendFileSync(${JSON.stringify(log)},'teardown\\n')`,
                    ),
                  },
                ],
              },
            }
          : {}),
      }),
    );
  }
  const data = join(root, 'data');
  execFileSync('mkdir', ['-p', data]);
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(
    store,
    config({ repository: repos[0].path, repositories: repos, runTimeoutMs: 60_000 }),
  );
  try {
    const board = h.createBoard('Library change', '', 'library');
    const task = h.addTask(board.id, {
      ...input('Change value'),
      repositoryId: 'library',
      consumers: [{ repositoryId: 'product', gates: ['test'] }],
    });
    h.approve(board.id);
    h.pause(false);
    const run = h.claim('worker')!;
    const scheduler = new Scheduler(h, data);
    const consume = (cwd: string, sha: string) =>
      (
        scheduler as unknown as {
          runConsumers(
            r: typeof run,
            t: typeof task,
            c: string,
            s: string,
            a: AbortSignal,
          ): Promise<void>;
        }
      ).runConsumers(
        run,
        store.read().tasks.find((t) => t.id === task.id)!,
        cwd,
        sha,
        new AbortController().signal,
      );
    const worktrees = (id: string) =>
      sh(join(root, id), 'worktree', 'list', '--porcelain')
        .split('\n')
        .filter((l) => l.startsWith('worktree ')).length;
    const integrated = join(root, 'integration');
    sh(repos[0].path, 'worktree', 'add', '--detach', integrated, 'devcontour/accepted');
    await writeFile(join(integrated, 'value.json'), '2\n');
    sh(integrated, 'commit', '-qam', 'value 2');
    const sha = sh(integrated, 'rev-parse', 'HEAD');
    h.phase(run.id, run.token, 'integrating', { candidateSha: sha, integrationSha: sha });
    await consume(integrated, sha);
    const stored = store.read().runs.find((r) => r.id === run.id)!;
    const evidence = stored.evidence.filter((e) => e.consumer === 'product');
    // PASS означает: mid собран против интегрированной библиотеки (2), и
    // prepare потребителя выполнен в его дереве.
    assert.equal(evidence[0]?.passed, true, evidence[0]?.summary);
    assert.equal(await readFile(log, 'utf8'), 'setup\nteardown\n');
    // Что проверено, сохранено: голова потребителя и снимок всех его зависимостей.
    const checked = stored.consumers![0].checked!;
    assert.equal(checked.sha, sh(repos[2].path, 'rev-parse', 'devcontour/accepted'));
    assert.deepEqual(
      checked.dependencies.map((d) => [d.repositoryId, d.sha]),
      [
        ['library', sha],
        ['mid', sh(repos[1].path, 'rev-parse', 'devcontour/accepted')],
      ],
    );
    assert.equal(checked.dependencies[1].artifacts[0].path, 'built.json');
    assert.equal(worktrees('mid'), 1);
    assert.equal(worktrees('product'), 1);
    // Сборка mid падает (у «интегрированной» библиотеки нет value.json):
    // созданные деревья всё равно убраны.
    const broken = join(root, 'broken');
    sh(repos[0].path, 'worktree', 'add', '--detach', broken, 'devcontour/accepted');
    sh(broken, 'rm', '-q', 'value.json');
    sh(broken, 'commit', '-qm', 'no value');
    await assert.rejects(consume(broken, sh(broken, 'rev-parse', 'HEAD')));
    assert.equal(worktrees('mid'), 1);
    assert.equal(worktrees('product'), 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

const profileGate = (id: string) => ({
  id,
  kind: 'test' as const,
  command: ['node', id + '.mjs'],
  timeoutMs: 60_000,
  report: { type: 'junit' as const, path: `.reports/${id}.xml` },
});
const integrationPass = (gate: string, sha: string, extra: Partial<Evidence> = {}) =>
  ({
    kind: 'test',
    phase: 'integration',
    sha,
    gate,
    passed: true,
    command: [],
    exitCode: 0,
    log: '',
    digest: 'd',
    summary: '',
    ...extra,
  }) as Evidence;

test('G02: consumer evidence proves neither an own requirement nor own profile coverage; a task without scope is checked against the current profile', () => {
  const sha = 'b'.repeat(40);
  // Одноимённый testcase потребителя не подтверждает собственный критерий.
  const consumerOnly = [
    integrationPass('unit', sha, {
      consumer: 'app',
      tests: [{ id: 'required-test', status: 'passed' }],
    }),
    integrationPass('unit', sha, { tests: [{ id: 'different-test', status: 'passed' }] }),
  ];
  assert.equal(
    requirementProof({ id: 'REQ-1', gate: 'unit', testId: 'required-test' }, consumerOnly, sha)
      .level,
    'none',
  );
  const f = fixture();
  try {
    f.h.config.gates = [profileGate('unit'), profileGate('nightly')];
    const b = f.h.createBoard('Coverage');
    const narrow = f.h.addTask(b.id, { ...input('Narrow'), gates: ['unit'] });
    const whole = f.h.addTask(b.id, input('Whole'));
    f.store.change('fixture.coverage', (s) => {
      for (const t of s.tasks) {
        t.status = 'done';
        t.resultSha = sha;
      }
      s.runs.push(
        {
          id: 'R-narrow',
          taskId: narrow.id,
          status: 'succeeded',
          // nightly прошёл только как проверка потребителя.
          evidence: [
            integrationPass('unit', sha),
            integrationPass('nightly', sha, { consumer: 'app' }),
          ],
        } as never,
        {
          id: 'R-whole',
          taskId: whole.id,
          status: 'succeeded',
          // Задача без области выполнялась профилем своего времени — без nightly.
          evidence: [integrationPass('unit', sha)],
        } as never,
      );
    });
    const s = f.store.read();
    assert.deepEqual(uncoveredGates(f.h.config, s, [s.tasks.find((t) => t.id === narrow.id)!]), [
      { repositoryId: 'main', gates: ['nightly'] },
    ]);
    assert.deepEqual(uncoveredGates(f.h.config, s, [s.tasks.find((t) => t.id === whole.id)!]), [
      { repositoryId: 'main', gates: ['nightly'] },
    ]);
  } finally {
    f.cleanup();
  }
});

test('G01: a receipt cannot shrink the expanded task scope or carry a dependency snapshot that does not match the component', () => {
  const f = fixture();
  try {
    f.h.config.gates = [profileGate('unit'), profileGate('engine')];
    f.h.config.gateGroups = { all: ['unit', 'engine'] };
    const b = f.h.createBoard('Grouped');
    const t = f.h.addTask(b.id, { ...input('Grouped task'), gates: ['@all'] });
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    const candidate = 'c'.repeat(40),
      merged = 'b'.repeat(40);
    f.h.phase(run.id, run.token, 'integrating', {
      candidateSha: candidate,
      integrationSha: merged,
    });
    for (const phase of ['candidate', 'integration'] as const)
      for (const gate of [...run.requiredGates!, 'independent-review'])
        f.h.evidence(run.id, run.token, {
          kind: gate === 'independent-review' ? 'review' : 'test',
          phase,
          sha: phase === 'candidate' ? candidate : merged,
          gate,
          passed: true,
          command: ['fixture'],
          exitCode: 0,
          log: '',
          digest: 'd'.repeat(64),
          summary: 'fixture',
        });
    f.h.finish(run.id, run.token, merged);
    const done = f.store.read().tasks.find((x) => x.id === t.id)!;
    const receipt = completion(f.h, f.store.read(), done);
    receipt.runtime = 'codex';
    receipt.reviewer = 'claude';
    const scope = {
      expand: (repositoryId: string, refs: string[]) =>
        expandGates(repository(f.h.config, repositoryId), refs),
      dependencyIds: () => [] as string[],
    };
    validateReceipt(receiptSchema.parse(receipt), done, false, undefined, [], scope);
    const cut = structuredClone(receipt);
    cut.requiredGates = cut.requiredGates.filter((g) => g !== 'engine');
    cut.checks = cut.checks.filter((c) => c.gate !== 'engine');
    assert.throws(
      () => validateReceipt(receiptSchema.parse(cut), done, false, undefined, [], scope),
      /область задачи требует engine/,
    );
    const ghost = structuredClone(receipt);
    ghost.dependencies = [
      { repositoryId: 'ghost', sha: merged, tree: merged, head: merged, artifacts: [] },
    ];
    assert.throws(
      () => validateReceipt(receiptSchema.parse(ghost), done, false, undefined, [], scope),
      /снимок зависимостей не совпадает/,
    );
  } finally {
    f.cleanup();
  }
});

test('G02: the consumer policy is part of the task contract; G01: shared subgroups expand once', async () => {
  const f = await components();
  try {
    const task = {
      repositoryId: 'library',
      consumers: [{ repositoryId: 'product', gates: ['test'] }],
    };
    const own = f.h.policyDigest('library');
    const before = f.h.taskPolicyDigest(task);
    assert.notEqual(before, own);
    f.h.config.repositories[1].gates = [
      { ...f.h.config.repositories[1].gates[0], command: [process.execPath, 'other.mjs'] },
    ];
    assert.equal(f.h.policyDigest('library'), own);
    assert.notEqual(f.h.taskPolicyDigest(task), before);
  } finally {
    await f.cleanup();
  }
  // Каждая группа дважды ссылается на предыдущую: без запоминания раскрытие
  // обходит 2^40 путей.
  const groups: Record<string, string[]> = { g0: ['unit'] };
  for (let i = 1; i <= 40; i++) groups[`g${i}`] = [`@g${i - 1}`, `@g${i - 1}`];
  const started = Date.now();
  assert.deepEqual(
    expandGates(
      repositorySchema.parse({
        id: 'main',
        name: 'main',
        kind: 'product',
        path: '/tmp',
        gates: [profileGate('unit')],
        gateGroups: groups,
      }),
      ['@g40'],
    ),
    ['unit'],
  );
  assert.ok(Date.now() - started < 1_000);
});
