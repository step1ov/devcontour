import { z } from 'zod';
import { Harness, digest } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { repository } from '../core/repositories.ts';
import { taskOwner } from '../core/sync-state.ts';
import type { UsageRecord } from '../core/usage.ts';

const scope = {
  repositoryId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
};
const paging = {
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).default(20),
};
export const observabilityInputs = {
  usage_report: z.strictObject({ ...scope, ...paging }),
  decision_report: z.strictObject({ ...scope, ...paging }),
  strategy_replay: z.strictObject({
    ...scope,
    policy: z.enum(['fifo-ready-v1', 'fewest-attempts-v1']),
  }),
};
function page<T>(records: T[], input: { cursor?: string; limit: number }) {
  const revision = digest(records);
  const match = input.cursor?.match(/^([a-f0-9]{64}):(\d+)$/);
  if (input.cursor && (!match || match[1] !== revision))
    throw new DomainError('Отчёт изменился; начните чтение заново');
  const offset = Number(match?.[2] ?? 0);
  if (!Number.isSafeInteger(offset) || offset > records.length)
    throw new DomainError('Некорректный cursor');
  let end = offset,
    bytes = 0;
  while (end < records.length && end - offset < input.limit) {
    const size = Buffer.byteLength(JSON.stringify(records[end]));
    if (bytes + size > 48000) break;
    bytes += size;
    end++;
  }
  if (end === offset && offset < records.length)
    throw new DomainError('Запись превышает размер страницы', 413);
  return {
    revision,
    records: records.slice(offset, end),
    nextCursor: end < records.length ? revision + ':' + end : null,
  };
}
export class Observability {
  constructor(readonly h: Harness) {}
  private runs(repositoryId?: string) {
    if (repositoryId) repository(this.h.config, repositoryId);
    const s = this.h.store.read(),
      ids = new Set(s.tasks.filter((t) => taskOwner(t) === repositoryId).map((t) => t.id));
    return s.runs.filter((r) => ids.has(r.taskId));
  }
  usage(raw: unknown) {
    const input = observabilityInputs.usage_report.parse(raw);
    if (input.repositoryId) repository(this.h.config, input.repositoryId);
    return page(
      Object.values(this.h.store.localRecords<UsageRecord>('usage', input.repositoryId)).sort(
        (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
      ),
      input,
    );
  }
  decisions(raw: unknown) {
    const input = observabilityInputs.decision_report.parse(raw);
    return page(
      this.runs(input.repositoryId).map((r) => ({
        runId: r.id,
        taskId: r.taskId,
        dispatch: r.dispatch ?? null,
        runtime: r.runtime,
        model: r.model ?? null,
        reviewer: r.reviewer,
        reviewerModel: r.reviewerModel ?? null,
        policyDigest: r.policyDigest,
        baseSha: r.baseSha ?? null,
        context: r.context ?? [],
        memory: r.memory ?? null,
        outcome: {
          status: r.status,
          finishedAt: r.finishedAt ?? null,
          resultSha: r.integrationSha ?? null,
        },
      })),
      input,
    );
  }
  replay(raw: unknown) {
    const input = observabilityInputs.strategy_replay.parse(raw),
      runs = this.runs(input.repositoryId);
    let matched = 0,
      unsupported = 0,
      unrecorded = 0;
    const outcomes: Record<string, number> = {};
    for (const run of runs) {
      if (!run.dispatch) {
        unrecorded++;
        continue;
      }
      // Policy sees only the prefix available at dispatch. Outcomes never enter choose().
      const choices = run.dispatch.eligible;
      const selected =
        input.policy === 'fifo-ready-v1'
          ? choices[0]
          : [...choices].sort((a, b) => a.attempt - b.attempt)[0];
      if (selected?.taskId !== run.taskId) {
        unsupported++;
        continue;
      }
      matched++;
      outcomes[run.status] = (outcomes[run.status] ?? 0) + 1;
    }
    return {
      policy: input.policy,
      decisions: runs.length,
      matched,
      unsupported,
      unrecorded,
      observedOutcomes: outcomes,
      scope: 'independent recorded decisions only',
      promotable: false,
      note: 'A different choice has no observed outcome here. Matching decisions do not simulate a counterfactual full rollout, cost or parallel speedup. No policy is installed.',
    };
  }
}
