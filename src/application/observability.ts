import { z } from 'zod';
import { DevContour, digest } from '../core/service.ts';
import { DomainError } from '../core/model.ts';
import { repository } from '../core/repositories.ts';
import { taskOwner } from '../core/sync-state.ts';
import type { UsageRecord } from '../core/usage.ts';
import { HarnessError, pageItems } from 'devcontour-harness';

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
/**
 * Страница отчёта — общая операция harness (`pageItems`, cursor
 * `<digest>:<offset>`): бюджет 48000 байт по сумме записей, без запаса под
 * конверт. Хост задаёт revision (digest записей) и прежние отказы: чужой или
 * нечитаемый cursor и offset вне диапазона — 409, запись больше страницы — 413.
 */
function page<T>(records: T[], input: { cursor?: string; limit: number }) {
  try {
    const p = pageItems(
      records,
      {},
      {
        cursorFormat: 'digest-offset',
        measure: 'items',
        revision: digest(records),
        cursor: input.cursor,
        limit: input.limit,
        maxBytes: 48000,
        reserveBytes: 0,
      },
    );
    return { revision: p.revision, records: p.items, nextCursor: p.nextCursor };
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error;
    if (
      error.code === 'INVALID_INPUT' &&
      JSON.stringify(error.issues[0]?.path) === '["cursor","offset"]'
    )
      throw new DomainError('Некорректный cursor');
    if (error.code === 'REVISION_CONFLICT')
      throw new DomainError('Отчёт изменился; начните чтение заново');
    if (error.code === 'RESPONSE_TOO_LARGE')
      throw new DomainError('Запись превышает размер страницы', 413);
    throw error;
  }
}
export class Observability {
  constructor(readonly h: DevContour) {}
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
