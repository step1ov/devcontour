import { usageTotals, type UsageRecord } from '../core/usage.ts';
import { budgetOverview } from '../core/budget.ts';
import { uncoveredGates, type DevContour } from '../core/service.ts';
import type { AuditEvent, Run, Task } from '../core/model.ts';
import { CheckCorpus } from '../core/check-store.ts';
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
/**
 * Обратная связь цикла качества. Каждое измерение называет знаменатель и
 * поведение при недостающих данных; неизмеренное не превращается в ноль.
 */
function feedbackMetrics(
  h: DevContour,
  tasks: Task[],
  runs: Run[],
  calls: UsageRecord[],
  events: AuditEvent[],
  at: string,
) {
  const owners = [...new Set(tasks.map((t) => t.repositoryId))];
  const suites = owners.flatMap((o) => new CheckCorpus(h).all(o));
  const ids = new Set(tasks.map((t) => t.id));
  const decisions = suites
    .flatMap((s) => s.decisions)
    .filter((d) => !d.source.taskId || ids.has(d.source.taskId));
  // Повторный дефект: после подтверждённого случая свойства задача снова
  // ломается — на том же случае (корпус) или на новом входе того же свойства.
  const confirmedAt = new Map<string, string>();
  for (const d of decisions)
    if (d.outcome === 'confirmed' && d.source.taskId) {
      const key = `${d.source.taskId}:${d.property}`;
      if (!confirmedAt.has(key) || d.at < confirmedAt.get(key)!) confirmedAt.set(key, d.at);
    }
  let sameCase = 0,
    sameProperty = 0,
    unknown = 0;
  for (const r of runs) {
    if (!['gate', 'review'].includes(r.failureKind ?? '')) continue;
    const after = (p: string) => {
      const since = confirmedAt.get(`${r.taskId}:${p}`);
      return !!since && r.startedAt > since;
    };
    const props = r.properties ?? [];
    if (!props.length) {
      if ([...confirmedAt.keys()].some((k) => k.startsWith(r.taskId + ':'))) unknown++;
      continue;
    }
    for (const p of props) {
      if (!after(p)) continue;
      const fromCorpus = r.evidence.some(
        (e) =>
          e.property?.report?.corpus?.failed.some((c) => c.property === p) ||
          e.property?.report?.properties.some((x) => x.testId === p && x.counterexample?.case),
      );
      if (fromCorpus) sameCase++;
      else sameProperty++;
    }
  }
  // Отказ ревью после зелёных гейтов: завершённое ревью кандидата после
  // полного PASS обязательных гейтов на том же SHA и той же версии проверок.
  const greenReviews: { passed: boolean; summary: string }[] = [];
  for (const r of runs) {
    const required = r.requiredGates ?? [];
    for (const review of r.evidence.filter((e) => e.kind === 'review' && e.phase === 'candidate')) {
      const green =
        required.length > 0 &&
        required.every((gate) =>
          r.evidence.some(
            (e) =>
              e.kind === 'test' &&
              e.phase === 'candidate' &&
              e.gate === gate &&
              e.sha === review.sha &&
              e.passed &&
              e.checks === review.checks,
          ),
        );
      if (green)
        greenReviews.push({ passed: review.passed, summary: review.summary.slice(0, 200) });
    }
  }
  const rejected = greenReviews.filter((x) => !x.passed);
  const durations = (values: (number | null)[]) => {
    const known = values.filter((v): v is number => v !== null);
    return {
      count: values.length,
      knownMs: known.reduce((a, b) => a + b, 0),
      unknown: values.length - known.length,
    };
  };
  const operations = owners.flatMap((o) =>
    Object.values(
      h.store.localRecords<{ startedAt: string; finishedAt?: string }>('contract-change', o),
    ),
  );
  // Технические вмешательства, наблюдаемые контуром: ручные решения разбора,
  // сброс бюджета попыток, перенос базы. Действия вне инструмента не видны.
  const manual = new Map<string, number>();
  const bump = (taskId: string) => manual.set(taskId, (manual.get(taskId) ?? 0) + 1);
  for (const t of tasks)
    for (const r of [...(t.recoveryHistory ?? []), ...(t.recovery ? [t.recovery] : [])])
      if (r.decision?.source.kind === 'operator') bump(t.id);
  for (const e of events) {
    const data = e.data as { taskId?: string; reset?: unknown } | null;
    if (e.type === 'task.retry' && data?.taskId && data.reset && ids.has(data.taskId))
      bump(data.taskId);
  }
  const baseUpdates = events.filter((e) => e.type === 'base.updated').length;
  const accepted = tasks.filter((t) => t.status === 'done' && !t.sharedCompletion);
  const recoveryCalls = calls.filter((c) => c.stage === 'property-recovery');
  return {
    repeatedDefects: {
      sameCase,
      newCaseSameProperty: sameProperty,
      unknownClassification: unknown,
      denominator: 'substantive failures after a confirmed case of the same task and property',
    },
    reviewAfterGreenGates: {
      rejected: rejected.length,
      completed: greenReviews.length,
      rate: greenReviews.length ? rejected.length / greenReviews.length : null,
      reasons: rejected.slice(-10).map((x) => x.summary),
    },
    feedbackCost: {
      confirmations: durations(
        decisions.map((d) =>
          d.observed?.durationsMs.length ? d.observed.durationsMs.reduce((a, b) => a + b, 0) : null,
        ),
      ),
      outcomes: Object.fromEntries(
        ['confirmed', 'refuted', 'inconclusive', 'rejected'].map((o) => [
          o,
          decisions.filter((d) => d.outcome === o).length,
        ]),
      ),
      leadAnalyses: durations(recoveryCalls.map((c) => elapsed(c.startedAt, c.finishedAt))),
      corpusVersions: suites.reduce((n, s) => n + s.versions.length, 0),
      contractChanges: durations(operations.map((o) => elapsed(o.startedAt, o.finishedAt))),
      technicalInterventions: [...manual.values()].reduce((a, b) => a + b, 0) + baseUpdates,
    },
    // Последние 50 утверждённых задач: ответ ограничен, полный список — CLI-отчёт.
    progress: tasks
      .filter((t) => t.approvedAt)
      .slice(-50)
      .map((t) => {
        const own = runs.filter((r) => r.taskId === t.id);
        const finished = own.findLast((r) => r.status === 'succeeded')?.finishedAt;
        return {
          taskId: t.id,
          status: t.status,
          attempts: own.length,
          failedAttempts: own.filter((r) => ['failed', 'expired', 'cancelled'].includes(r.status))
            .length,
          toAcceptedMs: t.status === 'done' && finished ? elapsed(t.approvedAt, finished) : null,
          ongoingMs: t.status === 'done' ? null : elapsed(t.approvedAt, at),
        };
      }),
    autonomy: {
      acceptedWithoutObservedIntervention: accepted.filter((t) => !manual.get(t.id)).length,
      accepted: accepted.length,
      limitation:
        'Counts only technical actions the controller records; human work outside the tool is not observed',
    },
  };
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Расход выбранной области gates и покрытие профиля.
 *
 * По каждой завершённой попытке с записанной областью: фактическое время её
 * gates (этапы `<фаза>-test:<gate>`) и оценка полного набора — то же плюс
 * медиана прошлых прогонов каждого не выбранного gate профиля на каждой фазе.
 * Сопоставимы только прогоны того же компонента, той же фазы и той же команды
 * gate, начатые раньше оцениваемой попытки; без них gate не оценивается и
 * назван. Попытка без таймингов — неизмеренная, а не нулевая. Совместная
 * проверка — по длительности её evidence. Покрытие — gates профиля, не
 * прошедшие integration ни в одной задаче незакрытой доски.
 */
export function gateScopeMetrics(h: DevContour, runs: Run[], tasks: Task[]) {
  const s = h.store.read();
  const key = (repositoryId: string, phase: string, gate: string, command: unknown) =>
    JSON.stringify([repositoryId, phase, gate, command]);
  // История для попытки — замеры той же команды, закончившиеся строго до её
  // начала: результат не зависит от порядка попыток в массиве.
  const finished = runs.filter((r) => r.status !== 'active');
  const measurements = new Map(
    finished.map((run) => {
      const repositoryId = run.repositoryId ?? 'main';
      const measured: { k: string; ms: number; finishedAt: number }[] = [];
      for (const t of run.timings ?? []) {
        const match = /^(candidate|integration)-test:(.+)$/.exec(t.stage);
        if (!match || !t.finishedAt) continue;
        const command = run.evidence.find(
          (e) => !e.consumer && e.phase === match[1] && e.gate === match[2],
        )?.command;
        measured.push({
          k: key(repositoryId, match[1], match[2], command),
          ms: Date.parse(t.finishedAt) - Date.parse(t.startedAt),
          finishedAt: Date.parse(t.finishedAt),
        });
      }
      return [run.id, measured] as const;
    }),
  );
  const history = [...measurements.values()].flat();
  const perAttempt: {
    runId: string;
    taskId: string;
    repositoryId: string;
    selectedMs: number | null;
    fullEstimateMs: number | null;
    unestimatedGates: string[];
  }[] = [];
  for (const run of finished) {
    if (!run.requiredGates) continue;
    const repositoryId = run.repositoryId ?? 'main';
    const repo = repository(h.config, repositoryId);
    const measured = measurements.get(run.id)!;
    const started = Date.parse(run.startedAt);
    const selectedMs = measured.length ? measured.reduce((a, m) => a + m.ms, 0) : null;
    const unestimatedGates: string[] = [];
    let extra = 0;
    for (const gate of repo.gates.filter((g) => !run.requiredGates!.includes(g.id)))
      for (const phase of ['candidate', 'integration']) {
        const k = key(repositoryId, phase, gate.id, gate.command);
        const m = median(
          history.filter((x) => x.k === k && x.finishedAt < started).map((x) => x.ms),
        );
        if (m === null) {
          if (!unestimatedGates.includes(gate.id)) unestimatedGates.push(gate.id);
        } else extra += m;
      }
    perAttempt.push({
      runId: run.id,
      taskId: run.taskId,
      repositoryId,
      selectedMs,
      fullEstimateMs: selectedMs === null || unestimatedGates.length ? null : selectedMs + extra,
      unestimatedGates,
    });
  }
  perAttempt.sort(
    (a, b) =>
      Date.parse(finished.find((r) => r.id === a.runId)!.startedAt) -
        Date.parse(finished.find((r) => r.id === b.runId)!.startedAt) ||
      a.runId.localeCompare(b.runId),
  );
  const estimated = perAttempt.filter((a) => a.fullEstimateMs !== null);
  const selectedMs = estimated.reduce((a, x) => a + x.selectedMs!, 0);
  const fullEstimateMs = estimated.reduce((a, x) => a + x.fullEstimateMs!, 0);
  const unestimated = new Set(perAttempt.flatMap((a) => a.unestimatedGates));
  const workspace = new Map<string, number[]>();
  for (const c of s.changeSets)
    for (const v of c.verifications)
      for (const e of v.evidence)
        if (typeof e.durationMs === 'number')
          workspace.set(e.gate, [...(workspace.get(e.gate) ?? []), e.durationMs]);
  const openBoards = s.boards.filter((b) => b.revisions.at(-1)?.status === 'active');
  const coverage = openBoards
    .map((b) => {
      const own = b.revisions
        .at(-1)!
        .taskIds.map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is Task => !!t && t.status === 'done');
      return { boardId: b.id, uncovered: uncoveredGates(h.config, s, own) };
    })
    .filter((b) => b.uncovered.length);
  // Результаты, проверенные на снимке зависимости, который к завершению
  // устарел: ветка зависимости сдвинулась параллельной работой.
  const stale = runs.flatMap((r) => [
    ...(r.dependencyFreshness ?? [])
      .filter((f) => !f.fresh)
      .map((f) => ({ runId: r.id, taskId: r.taskId, repositoryId: f.repositoryId })),
    // Входы проверок потребителей, устаревшие к её окончанию.
    ...(r.consumers ?? []).flatMap((c) =>
      (c.checked?.freshness ?? [])
        .filter((f) => !f.fresh)
        .map((f) => ({
          runId: r.id,
          taskId: r.taskId,
          repositoryId: f.repositoryId,
          consumer: c.repositoryId,
        })),
    ),
  ]);
  return {
    dependencyFreshness: {
      checked: runs.filter((r) => r.dependencyFreshness?.length).length,
      stale,
    },
    attempts: {
      /** Суммы — только по попыткам, для которых оценка полного набора известна. */
      estimatedAttempts: estimated.length,
      selectedMs,
      fullEstimateMs,
      savedEstimateMs: fullEstimateMs - selectedMs,
      /** Попытки с областью, но без таймингов gates или без оценки части профиля. */
      unmeasuredAttempts: perAttempt.filter((a) => a.selectedMs === null).length,
      unestimatedAttempts: perAttempt.filter(
        (a) => a.selectedMs !== null && a.fullEstimateMs === null,
      ).length,
      unestimatedGates: [...unestimated].sort(),
      /** Последние 200 попыток с областью. */
      perAttempt: perAttempt.slice(-200),
    },
    workspace: {
      totalMs: [...workspace.values()].flat().reduce((a, b) => a + b, 0),
      byGate: Object.fromEntries(
        [...workspace].map(([gate, values]) => [
          gate,
          { runs: values.length, medianMs: median(values) },
        ]),
      ),
    },
    coverage,
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
    gateScope: gateScopeMetrics(h, runs, tasks),
    budgets: budgetOverview(h, s),
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
    feedback: feedbackMetrics(h, tasks, runs, calls, h.store.allEvents(), at),
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
