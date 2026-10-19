import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setupDemo } from '../src/demo.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { loadConfig } from '../src/runner/config.ts';
import type { ChangeSet, DevContourState, Run, Task } from '../src/core/model.ts';

/**
 * Обезличенная большая история для измерения панели. Основа — настоящий
 * прогон учебного демо (настоящие Git, runner, гейты и SQLite); затем его
 * доски, задачи и попытки размножаются с новыми id, у части задач — серии
 * отказавших попыток с длинной диагностикой, плюс ChangeSet со снимками задач
 * и журнал событий. Модели не вызываются.
 */
export interface HistoryShape {
  /** Копий каждой доски демо. */
  copies: number;
  /** Отказавших попыток перед успешной у каждой третьей задачи. */
  failedAttempts: number;
  /** Строк в журнале событий. */
  events: number;
  /** ChangeSet с проверками и снимками задач. */
  changeSets: number;
  /** Проверок в каждом ChangeSet. */
  verifications: number;
}
export const LARGE: HistoryShape = {
  copies: 40,
  failedAttempts: 4,
  events: 20000,
  changeSets: 60,
  verifications: 3,
};

const LOG = Array.from(
  { length: 40 },
  (_, i) => `step ${i}: fixture assertion output line with deterministic text`,
).join('\n');

export async function largeHistory(root: string, shape: HistoryShape = LARGE) {
  await completedDemo(root);
  amplifyHistory(root, shape);
}

/** A real completed demo; all processes and SQLite handles are closed on return. */
export async function completedDemo(root: string) {
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const scheduler = new Scheduler(h, root);
  await scheduler.init();
  try {
    // Второй, ещё не выполненный демо-board — настоящим прогоном.
    h.pause(false);
    await scheduler.drain();
    assert.ok(
      store.read().tasks.every((task) => task.status === 'done'),
      'demo history completed',
    );
    h.pause(true);
  } finally {
    await scheduler.stop();
    store.close();
  }
}

/** Add projection volume to an independent copy of the completed demo. */
export function amplifyHistory(root: string, shape: HistoryShape) {
  const store = new Store(join(root, 'state.sqlite'));
  store.change('fixture.large-history', (s) => amplify(s, shape));
  store.close();
  const db = new DatabaseSync(join(root, 'state.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO events(at,type,data) VALUES(?,?,?)');
    db.exec('BEGIN');
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < shape.events; i++)
      insert.run(
        new Date(start + i * 60000).toISOString(),
        ['run.claimed', 'run.evidence', 'run.finished', 'task.updated'][i % 4],
        JSON.stringify({ id: 'R-' + i, summary: 'fixture event ' + i }),
      );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

function amplify(s: DevContourState, shape: HistoryShape) {
  const templateBoards = structuredClone(s.boards);
  const templateTasks = structuredClone(s.tasks);
  const templateRuns = structuredClone(s.runs);
  const at = (n: number) =>
    new Date(Date.parse('2026-01-01T00:00:00Z') + n * 3600000).toISOString();
  let clock = 0;
  for (let copy = 0; copy < shape.copies; copy++)
    for (const board of templateBoards) {
      const ids = new Map<string, string>();
      for (const t of templateTasks.filter((t) =>
        board.revisions.some((r) => r.taskIds.includes(t.id)),
      ))
        ids.set(t.id, 'T-' + randomUUID());
      const map = (id: string) => ids.get(id) ?? id;
      const tasks: Task[] = templateTasks
        .filter((t) => ids.has(t.id))
        .map((t, i) => ({
          ...structuredClone(t),
          id: map(t.id),
          title: `${t.title} · копия ${copy + 1}`,
          dependsOn: t.dependsOn.map(map),
          // Часть истории отменена: так копится реальная история задач.
          ...(i % 5 === 4 ? { status: 'cancelled' as const } : {}),
        }));
      s.tasks.push(...tasks);
      s.boards.push({
        ...structuredClone(board),
        id: 'B-' + randomUUID(),
        title: `${board.title} · копия ${copy + 1}`,
        revisions: board.revisions.map((r) => ({ ...r, taskIds: r.taskIds.map(map) })),
      });
      for (const [index, task] of tasks.entries()) {
        const source = templateRuns.filter((r) => map(r.taskId) === task.id).at(-1);
        if (!source) continue;
        const failures = index % 3 === 0 ? shape.failedAttempts : 0;
        for (let attempt = 1; attempt <= failures + 1; attempt++) {
          const failed = attempt <= failures;
          const id = 'R-' + randomUUID();
          const run: Run = {
            ...structuredClone(source),
            id,
            taskId: task.id,
            attempt,
            token: randomUUID(),
            status: failed ? 'failed' : source.status,
            startedAt: at(clock++),
            finishedAt: at(clock++),
            evidence: source.evidence.map((e) => ({
              ...structuredClone(e),
              id: 'E-' + randomUUID(),
              runId: id,
              passed: failed ? false : e.passed,
              log: failed ? LOG : e.log,
              summary: failed ? `Отказ попытки ${attempt}: ${LOG.slice(0, 300)}` : e.summary,
              ...(failed && e.kind === 'review'
                ? {
                    findings: Array.from({ length: 6 }, (_, k) => ({
                      severity: 'major',
                      message: `Fixture finding ${k}: ${LOG.slice(0, 160)}`,
                      path: 'src/feature.mjs',
                      line: k + 1,
                    })),
                  }
                : {}),
            })),
          };
          if (failed) run.error = `Fixture failure ${attempt}`;
          s.runs.push(run);
        }
        task.attempt = failures + 1;
      }
    }
  for (let c = 0; c < shape.changeSets; c++) {
    const boards = s.boards.slice(c % s.boards.length, (c % s.boards.length) + 2);
    const snapshot = s.tasks.filter((t) =>
      boards.some((b) => b.revisions.some((r) => r.taskIds.includes(t.id))),
    );
    const changeSet: ChangeSet = {
      id: 'CHG-' + randomUUID(),
      title: `Fixture change set ${c + 1}`,
      description: 'Обезличенный ChangeSet для измерения панели.',
      boardIds: boards.map((b) => b.id),
      createdAt: at(clock++),
      verifications: Array.from({ length: shape.verifications }, (_, v) => ({
        id: 'V-' + randomUUID(),
        token: randomUUID(),
        leaseUntil: 0,
        startedAt: at(clock++),
        finishedAt: at(clock++),
        status: v === shape.verifications - 1 ? 'passed' : 'failed',
        policyDigest: 'f'.repeat(64),
        specDigest: 'e'.repeat(64),
        tasks: structuredClone(snapshot),
        boards: boards.map((b) => ({ id: b.id, title: b.title, revision: 1 })),
        evidence: [
          {
            gate: 'workspace-tests',
            passed: v === shape.verifications - 1,
            command: ['node', 'verify.mjs'],
            exitCode: v === shape.verifications - 1 ? 0 : 1,
            log: LOG,
            digest: 'd'.repeat(64),
            summary: 'fixture workspace check',
            artifacts: [],
          },
        ],
      })),
    };
    s.changeSets.push(changeSet);
  }
  return { boards: s.boards.length, tasks: s.tasks.length, runs: s.runs.length };
}
