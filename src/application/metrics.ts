import { usageTotals, type UsageRecord } from '../core/usage.ts';
import type { Harness } from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import { taskOwner, boardOwner } from '../core/sync-state.ts';

const elapsed = (start?: string, end?: string) =>
  start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
export function workflowMetrics(h: Harness, repositoryId?: string, at = new Date().toISOString()) {
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
    })),
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
