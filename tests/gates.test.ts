import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, fixture, input } from './helpers.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { repositorySchema } from '../src/core/model.ts';
import { assertDependencies } from '../src/runner/dependencies.ts';
import { Scheduler, classifyFailure } from '../src/runner/scheduler.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { receiptSchema } from '../src/core/sync-model.ts';

/**
 * Композиция и выбор регрессионных gates: свежесть зависимостей (G03) и
 * снимок зависимостей в квитанции.
 */
test('G03: a dependency branch that moved after the snapshot is an environment refusal, and the receipt carries the snapshot', async () => {
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
    await assertDependencies(snapshots, c);
    // Зависимость продвинулась: результат проверен на устаревшей версии.
    await writeFile(join(lib, 'index.mjs'), 'export const v = 2;\n');
    sh(lib, 'commit', '-qam', 'v2');
    sh(lib, 'branch', '-f', 'devcontour/accepted', 'HEAD');
    const refusal = await assertDependencies(snapshots, c).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(refusal instanceof Error);
    assert.match(refusal.message, /Версия зависимости library изменилась после снимка/);
    // Отказ окружения: попытка повторяется на свежей зависимости, бюджет не тратится.
    assert.equal(classifyFailure(refusal, refusal.message), 'environment');
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
        { repositoryId: 'library', sha: snapshotSha, tree: snapshots[0].tree, artifacts: [] },
      ],
    });
    assert.equal(receipt.dependencies?.[0].sha, snapshotSha);
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
      s.runs.push(
        {
          ...base,
          id: 'R-whole',
          taskId: whole.id,
          requiredGates: ['unit', 'engine'],
          timings: [
            timing('candidate-test:unit', 0, 1_000),
            timing('candidate-test:engine', 1_000, 4_000),
            timing('integration-test:unit', 5_000, 1_000),
            timing('integration-test:engine', 6_000, 6_000),
          ],
        } as never,
        {
          ...base,
          id: 'R-narrow',
          taskId: narrow.id,
          requiredGates: ['unit'],
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
    // Выбранная область — фактическое время: 12 с у полной и 4 с у узкой.
    assert.equal(scope.attempts.selectedMs, 16_000);
    // Полный набор узкой попытки: + 2 × медиана engine (4 и 6 с → 5 с).
    assert.equal(scope.attempts.fullEstimateMs, 26_000);
    assert.equal(scope.attempts.savedEstimateMs, 10_000);
    assert.deepEqual(scope.attempts.unestimatedGates, []);
    assert.deepEqual(scope.workspace.byGate, { e2e: { runs: 2, medianMs: 4_000 } });
    assert.equal(scope.workspace.totalMs, 8_000);
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
