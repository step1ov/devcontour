import { randomUUID } from 'node:crypto';
import { runGatesAt, type EvidenceRecord } from 'devcontour-harness';
import type { DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import { executionOf } from '../harness/execution.ts';
import { git } from './process.ts';
import { controllerBoundary } from './checks.ts';
import { journalError } from './board-coverage.ts';

/** Локальная запись проверки базы: компонент, SHA базы, договор и исход. */
export const BASE_CHECK = 'base-check';
export interface BaseCheck {
  repositoryId: string;
  sha: string;
  policyDigest: string;
  runId: string;
  passed: boolean;
  gates: string[];
  failures: { gate: string; message: string }[];
  evidence: EvidenceRecord[];
  at: string;
}

/**
 * Проверка перенесённой базы gates компонентов в режиме `approvalMode: agent`.
 *
 * После `base-update` и автоматической перемотки очередь ждёт `base-check`:
 * новую базу проверяют gates до выдачи (D42). В режиме оператора это решение
 * человека, и ожидание снимает он. В режиме агента согласования ведёт контур,
 * и ручной `queue --start` был лишним шагом: цикл ведущего проверяет базу сам
 * тем же исполнением, что integration задач (`runGatesAt`), — весь профиль
 * каждого компонента на SHA его базы прогонов. Все прошли — ожидание снято и
 * очередь продолжена; провал — ожидание остаётся и называет gates. Исход
 * хранится по SHA и договору: провалившаяся база не проверяется повторно,
 * пока её не перенесут или не изменят договор.
 *
 * Возвращает `true`, когда ожидание снято (или его уже нет).
 */
export async function checkBase(
  h: DevContour,
  root: string,
  guard: () => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const waiting = () => {
    const s = h.store.read();
    return s.paused && s.pauseReason === 'base-check';
  };
  if (h.config.approvalMode !== 'agent' || !waiting()) return !waiting();
  const bases = await Promise.all(
    repositories(h.config).map(async (repo) => ({
      repositoryId: repo.id,
      sha: await git(repo.path, 'rev-parse', 'refs/heads/' + repo.targetBranch),
    })),
  );
  const { engine } = executionOf(h);
  const failed: string[] = [];
  for (const base of bases) {
    const repo = repository(h.config, base.repositoryId);
    const gates = repo.gates.map((g) => g.id);
    if (!gates.length) continue;
    const policyDigest = h.policyDigest(base.repositoryId);
    const previous = h.store.localRecord<BaseCheck>(BASE_CHECK, base.repositoryId, base.sha);
    let record = previous?.policyDigest === policyDigest ? previous : undefined;
    if (!record) {
      const runId = 'BK-' + randomUUID();
      const event = (type: string, data: Record<string, unknown>) =>
        h.store.atomic(() => {
          guard();
          h.store.appendEvent(type, {
            repositoryId: base.repositoryId,
            sha: base.sha,
            runId,
            ...data,
          });
        });
      event('base.check.started', { gates });
      let result;
      try {
        result = await runGatesAt(
          {
            policy: engine.policy,
            stateDir: root,
            repoPath: (r) => repository(h.config, r.id).path,
            boundary: () => controllerBoundary(h, root),
            ...(h.config.resourceDatabase ? { resourceDatabase: h.config.resourceDatabase } : {}),
          },
          {
            id: runId,
            repositoryId: base.repositoryId,
            sha: base.sha,
            gates,
            record: () => guard(),
            ...(signal ? { signal } : {}),
          },
        );
      } catch (error) {
        try {
          event('base.check.failed', {
            error: journalError(error, [root, ...repositories(h.config).map((r) => r.path)]),
          });
        } catch {
          // Без права записи событие не пишется; причина — исходная ошибка.
        }
        throw error;
      }
      record = {
        repositoryId: base.repositoryId,
        sha: base.sha,
        policyDigest,
        runId,
        passed: !result.failures.length,
        gates: result.gates,
        failures: result.failures,
        evidence: result.evidence,
        at: new Date().toISOString(),
      };
      const saved = record;
      h.store.atomic(() => {
        guard();
        h.store.saveLocal(BASE_CHECK, base.repositoryId, base.sha, saved);
      });
      event(saved.passed ? 'base.check.passed' : 'base.check.failed', {
        gates: saved.gates,
        ...(saved.passed ? {} : { failures: saved.failures.map((f) => f.gate) }),
      });
    }
    for (const f of record.failures) failed.push(`${base.repositoryId}/${f.gate}`);
  }
  // Решение — в одной транзакции со сверкой: ожидание то же, базы не сдвинулись.
  const current = await Promise.all(
    bases.map(async (b) => {
      const repo = repository(h.config, b.repositoryId);
      return git(repo.path, 'rev-parse', 'refs/heads/' + repo.targetBranch);
    }),
  );
  if (current.some((sha, i) => sha !== bases[i].sha)) return false;
  if (failed.length) {
    const detail = `Проверка базы не пройдена: ${failed.join(', ')}. Исправьте базу и выполните base-update`;
    if (h.store.read().waits?.some((w) => w.kind === 'base-check' && w.detail !== detail))
      h.store.change('base.check.waiting', (s) => {
        guard();
        s.waits = (s.waits ?? []).map((w) => (w.kind === 'base-check' ? { ...w, detail } : w));
        return { failures: failed };
      });
    return false;
  }
  return h.store.atomic(() => {
    guard();
    if (!waiting()) return true;
    h.store.appendEvent('base.checked', { bases });
    h.pause(false);
    return true;
  });
}
