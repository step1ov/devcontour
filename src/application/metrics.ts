import { usageTotals, type UsageRecord } from '../core/usage.ts';
import type { DevContour } from '../core/service.ts';
import type { Run } from '../core/model.ts';
import { repository } from '../core/repositories.ts';
import { taskOwner, boardOwner } from '../core/sync-state.ts';

const elapsed = (start?: string, end?: string) =>
  start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;

// Семейство стадии: «candidate-test:install» и «candidate-test:unit» — одна
// фаза проверки кандидата.
const phaseOf = (stage: string) => stage.split(':')[0];
const failedRun = (r: Run) => ['failed', 'expired', 'cancelled'].includes(r.status);

/**
 * Время и стоимость по фазам, отдельно — в попытках, которые не дали
 * результата. Без этого нельзя сказать, какую фазу выгодно не повторять:
 * дорогая, но редко теряемая фаза оптимизации не требует.
 */
function phaseBreakdown(runs: Run[], calls: UsageRecord[]) {
  const phases: Record<
    string,
    {
      durationMs: number;
      lostMs: number;
      costUsd: number;
      lostCostUsd: number;
      unknownCost: number;
    }
  > = {};
  const at = (name: string) =>
    (phases[name] ??= { durationMs: 0, lostMs: 0, costUsd: 0, lostCostUsd: 0, unknownCost: 0 });
  for (const r of runs)
    for (const t of r.timings ?? []) {
      const ms = elapsed(t.startedAt, t.finishedAt);
      if (ms === null) continue;
      at(phaseOf(t.stage)).durationMs += ms;
      if (failedRun(r)) at(phaseOf(t.stage)).lostMs += ms;
    }
  const byRun = new Map(runs.map((r) => [r.id, r]));
  for (const c of calls) {
    const r = c.runId ? byRun.get(c.runId) : undefined;
    if (!r) continue;
    const p = at(phaseOf(c.stage));
    if (c.costUsd === null) p.unknownCost++;
    p.costUsd += c.costUsd ?? 0;
    if (failedRun(r)) p.lostCostUsd += c.costUsd ?? 0;
  }
  return phases;
}

/**
 * Взятые реализации и то, во что обошлась бы каждая заново: длительность
 * реализации той попытки, чей кандидат взят. Это наблюдённая цена, а не
 * прогноз, и она не вычитается из расходов — прежние траты остаются на своей
 * попытке.
 */
function reuseSummary(runs: Run[]) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const reused = runs.filter((r) => r.reusedFrom);
  return {
    attempts: reused.length,
    implementationMsNotRepeated: reused.reduce((sum, r) => {
      const source = byId.get(r.reusedFrom!.runId);
      const span = source?.timings?.findLast(
        (t) => t.stage === 'implementation' && t.outcome === 'passed',
      );
      return sum + (elapsed(span?.startedAt, span?.finishedAt) ?? 0);
    }, 0),
  };
}
export function workflowMetrics(
  h: DevContour,
  repositoryId?: string,
  at = new Date().toISOString(),
) {
  if (repositoryId) repository(h.config, repositoryId);
  const s = h.store.read(),
    tasks = s.tasks.filter((t) => taskOwner(t) === repositoryId),
    ids = new Set(tasks.map((t) => t.id));
  const runs = s.runs.filter((r) => ids.has(r.taskId));
  const done = tasks.filter((t) => t.status === 'done');
  const calls = Object.values(h.store.localRecords<UsageRecord>('usage', repositoryId));
  const costs = usageTotals(
    calls,
    runs.some((r) => r.status === 'active' || !calls.some((c) => c.runId === r.id)),
  );
  const acceptedLocal = done.filter((t) => !t.sharedCompletion).length;
  return {
    repositoryId: repositoryId ?? null,
    observedAt: at,
    costUsd: costs.costUsd,
    usage: {
      ...costs,
      costPerAcceptedTaskUsd:
        costs.complete && acceptedLocal ? costs.costUsd! / acceptedLocal : null,
    },
    counts: {
      tasks: tasks.length,
      accepted: done.length,
      attempts: runs.length,
      active: runs.filter((r) => r.status === 'active').length,
      failed: runs.filter((r) => ['failed', 'expired', 'cancelled'].includes(r.status)).length,
      corrections: tasks.filter((t) => t.supersedes).length,
      importedResults: tasks.filter((t) => t.sharedCompletion).length,
    },
    firstAttemptAcceptanceRate: tasks.filter(
      (t) =>
        !t.sharedCompletion && ['done', 'failed', 'cancelled'].includes(t.status) && t.attempt > 0,
    ).length
      ? done.filter((t) => !t.sharedCompletion && t.attempt === 1).length /
        tasks.filter(
          (t) =>
            !t.sharedCompletion &&
            ['done', 'failed', 'cancelled'].includes(t.status) &&
            t.attempt > 0,
        ).length
      : null,
    attempts: runs.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      status: r.status,
      runtime: r.runtime,
      model: r.model ?? null,
      policyDigest: r.policyDigest,
      durationMs: elapsed(r.startedAt, r.finishedAt ?? at),
      ongoing: !r.finishedAt,
      costUsd: usageTotals(
        calls.filter((c) => c.runId === r.id),
        r.status === 'active',
      ).costUsd,
      dependencyWaitMs: elapsed(r.wait?.approvedAt, r.wait?.readyAt),
      dispatchWaitMs: elapsed(r.wait?.readyAt, r.startedAt),
      stages: (r.timings ?? []).map((t) => ({
        ...t,
        durationMs: elapsed(
          t.startedAt,
          t.finishedAt ?? (r.status === 'active' ? at : r.finishedAt),
        ),
        incomplete: !t.finishedAt,
      })),
      timingCoverage: r.timings?.length ? 'instrumented-stages-only' : 'unknown-historical',
      reusedFrom: r.reusedFrom?.runId ?? null,
    })),
    phases: phaseBreakdown(runs, calls),
    reuse: reuseSummary(runs),
    boards: s.boards
      .filter((b) => boardOwner(b, s) === repositoryId)
      .map((b) => ({
        id: b.id,
        revisions: b.revisions.map((r) => ({
          number: r.number,
          accepted: r.status === 'accepted',
          durationMs: elapsed(r.createdAt, r.acceptedAt ?? at),
          ongoing: !r.acceptedAt,
        })),
      })),
    changeSets: repositoryId
      ? []
      : s.changeSets.map((c) => ({
          id: c.id,
          durationMs: elapsed(c.createdAt, c.acceptance?.at ?? at),
          ongoing: !c.acceptance,
          publicationWaitMs:
            c.verifications.findLast((v) => v.status === 'passed')?.finishedAt &&
            h.config.completionMode === 'remote'
              ? elapsed(
                  c.verifications.findLast((v) => v.status === 'passed')!.finishedAt,
                  c.acceptance?.at ?? at,
                )
              : null,
        })),
    limitations: [
      'Unknown or incomplete telemetry is not zero; tariffs are estimates, not subscription invoices',
      'Owner cost per accepted local task includes failed attempts and owner planning/review overhead',
      'Dispatch wait includes pauses, ownership and worker availability',
      'Imported results have no local execution timing',
      'Stage spans may be incomplete after interruption; durations are not summed into model time',
    ],
  };
}
