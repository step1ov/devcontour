import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import { gateScopeMetrics, workflowMetrics } from '../src/application/metrics.ts';

/**
 * Композиция и выбор регрессионных gates: свежесть зависимостей (G03) и
 * снимок зависимостей в квитанции.
 */
// Гарантии G01 (группы gates), G02 (проверки потребителей) и G03 (свежесть
// зависимостей) — движка и runner harness: tests/consumers.test.ts и
// tests/validate.test.ts пакета (перенос этапа 2, срез C). Здесь остаются
// метрики области проверок (G05) — экраны DevContour.

const profileGate = (id: string) => ({
  id,
  kind: 'test' as const,
  command: ['node', id + '.mjs'],
  timeoutMs: 60_000,
  report: { type: 'junit' as const, path: `.reports/${id}.xml` },
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
          // Наблюдение только у входа проверки потребителя: попытка тоже измерена.
          consumers: [
            {
              repositoryId: 'app',
              gates: ['test'],
              checked: {
                sha: 'c'.repeat(40),
                tree: 'c'.repeat(40),
                dependencies: [],
                freshness: [
                  {
                    repositoryId: 'app',
                    snapshot: 'c'.repeat(40),
                    head: 'd'.repeat(40),
                    fresh: false,
                  },
                ],
                observedAt: at(300_000),
              },
            },
          ],
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
            token: 'fixture-verification-token-0001',
            leaseUntil: 0,
            startedAt: at(0),
            finishedAt: at(0),
            status: 'passed',
            policyDigest: 'a'.repeat(64),
            specDigest: 'b'.repeat(64),
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
    // Порядок попыток в массиве не меняет оценку: история — строго по времени.
    const runs = f.store.read().runs;
    const tasks = f.store.read().tasks;
    assert.deepEqual(
      gateScopeMetrics(f.h, [...runs].reverse(), tasks).attempts,
      gateScopeMetrics(f.h, runs, tasks).attempts,
    );
    assert.deepEqual(scope.workspace.byGate, { e2e: { runs: 2, medianMs: 4_000 } });
    assert.equal(scope.workspace.totalMs, 8_000);
    // Результат, проверенный на устаревшем снимке зависимости, назван.
    assert.equal(scope.dependencyFreshness.checked, 2);
    assert.deepEqual(
      new Set(scope.dependencyFreshness.stale.map((x) => JSON.stringify(x))),
      new Set([
        JSON.stringify({ runId: 'R-narrow', taskId: narrow.id, repositoryId: 'library' }),
        JSON.stringify({
          runId: 'R-unmeasured',
          taskId: narrow.id,
          repositoryId: 'app',
          consumer: 'app',
        }),
      ]),
    );
    // Незакрытая доска: у выполненной узкой задачи нет integration-evidence.
    assert.deepEqual(scope.coverage, [
      { boardId: b.id, uncovered: [{ repositoryId: 'main', gates: ['unit', 'engine'] }] },
    ]);
  } finally {
    f.cleanup();
  }
});

test('G05: attempts started at the same moment never serve as each other’s history, whatever the array order', () => {
  const f = fixture();
  try {
    f.h.config.gates = [profileGate('unit'), profileGate('nightly')];
    const at = (ms: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + ms).toISOString();
    const run = (id: string, requiredGates: string[], gates: string[]) =>
      ({
        id,
        taskId: 'T',
        status: 'succeeded',
        repositoryId: 'main',
        startedAt: at(0),
        requiredGates,
        evidence: gates.flatMap((gate) =>
          ['candidate', 'integration'].map((phase) => ({
            kind: 'test',
            phase,
            gate,
            command: ['node', gate + '.mjs'],
          })),
        ),
        timings: gates.flatMap((gate, i) =>
          ['candidate', 'integration'].map((phase, j) => ({
            id: `${gate}${phase}`,
            stage: `${phase}-test:${gate}`,
            startedAt: at(i * 100 + j * 50),
            finishedAt: at(i * 100 + j * 50 + 40),
          })),
        ),
      }) as never;
    const history = run('R-history', ['unit', 'nightly'], ['unit', 'nightly']);
    const narrow = run('R-narrow', ['unit'], ['unit']);
    const forward = gateScopeMetrics(f.h, [history, narrow], []).attempts.perAttempt;
    const backward = gateScopeMetrics(f.h, [narrow, history], []).attempts.perAttempt;
    assert.deepEqual(forward, backward);
    assert.equal(forward.find((a) => a.runId === 'R-narrow')!.fullEstimateMs, null);
  } finally {
    f.cleanup();
  }
});
