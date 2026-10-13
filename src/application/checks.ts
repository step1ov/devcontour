import { z } from 'zod';
import { DomainError, type Task } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { obligationOf, effectiveChecks } from '../core/checks.ts';
import { CheckCorpus } from '../core/check-store.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { clip } from './bounded.ts';

/**
 * Чтение договора проверки задачи: действующая версия, свойства и
 * фактическое покрытие, случаи корпуса, история отказов по свойству, эпизод
 * восстановления, остаток бюджета и следующий шаг с тем, кто должен
 * действовать. Ничего не запускает. Подробности выдаются страницами: в
 * опрашиваемое состояние панели входы корпуса не попадают.
 */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const checksQuery = z.strictObject({
  taskId: id,
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.number().int().min(0).default(0),
});
export type Actor = 'controller' | 'lead' | 'user' | null;

function nextStep(
  h: DevContour,
  task: Task,
  waitingAdoption: boolean,
): { actor: Actor; step: string } {
  const r = task.recovery;
  const attemptsLeft = h.config.maxAttempts - task.attempt;
  if (task.status === 'done') return { actor: null, step: 'Задача принята.' };
  if (task.status === 'cancelled') return { actor: null, step: 'Задача отменена.' };
  if (r)
    switch (r.status) {
      case 'awaiting-lead':
        return {
          actor: 'lead',
          step:
            h.config.approvalMode === 'agent'
              ? `Ограниченный разбор ведущего по свойству ${r.property}: сервер вызовет его сам в пределах бюджета.`
              : `Разбор свойства ${r.property}: решение ведущего через recovery_decide (operator mode автоматически не вызывает модель).`,
        };
      case 'analyzing':
        return { actor: 'lead', step: `Ведущий разбирает отказы по свойству ${r.property}.` };
      case 'applying':
        return { actor: 'controller', step: 'Контур подтверждает предложенные случаи эталоном.' };
      case 'retry':
        return {
          actor: 'controller',
          step: 'Разрешён один повтор по решению разбора; задача ждёт выдачи.',
        };
      case 'retrying':
        return { actor: 'controller', step: 'Идёт разрешённый повтор.' };
      case 'awaiting-user':
        return { actor: 'user', step: r.reason ?? 'Нужно решение пользователя.' };
      case 'stopped':
        return {
          actor: r.decision?.proposal ? 'lead' : 'user',
          step: r.reason ?? 'Автоматических действий больше нет.',
        };
    }
  if (waitingAdoption)
    return {
      actor: 'controller',
      step: 'Новая версия корпуса будет принята после окончания попытки.',
    };
  if (task.hold)
    return { actor: 'controller', step: `Выдачу удерживает операция ${task.hold.operation}.` };
  if (task.status === 'draft') return { actor: 'lead', step: 'Черновик ждёт ревью плана.' };
  if (['running', 'verifying', 'reviewing', 'integrating'].includes(task.status))
    return { actor: 'controller', step: 'Идёт попытка: реализация, гейты, ревью и интеграция.' };
  if (task.status === 'failed')
    return attemptsLeft > 0
      ? { actor: 'controller', step: 'Повтор в пределах бюджета попыток.' }
      : { actor: 'user', step: 'Попытки исчерпаны: сброс — решение человека с причиной.' };
  return { actor: 'controller', step: 'Задача ждёт выдачи.' };
}

export function taskChecks(h: DevContour, raw: unknown) {
  const q = checksQuery.parse(raw);
  const s = h.store.read();
  const task = s.tasks.find((t) => t.id === q.taskId);
  if (!task) throw new DomainError('Задача не найдена', 404);
  const corpus = new CheckCorpus(h);
  const runs = s.runs.filter((r) => r.taskId === task.id);
  const last = runs.at(-1);
  const properties = (task.properties ?? []).map((p) => {
    const found = obligationOf(task, s.contracts, p);
    return {
      id: p,
      promise: found?.obligation.promise ?? null,
      gate: found?.gate ?? null,
      contract: found?.contract.id ?? null,
      minCases: found?.obligation.coverage.minCases ?? null,
      families:
        found?.obligation.coverage.families.map((f) => ({
          id: f.id,
          kind: f.kind,
          minCases: f.minCases,
        })) ?? [],
    };
  });
  // Фактическое покрытие — из последнего evidence генеративной проверки.
  const coverage = (last?.evidence ?? [])
    .filter((e) => e.kind === 'test' && e.property)
    .map((e) => ({
      phase: e.phase,
      gate: e.gate,
      sha: e.sha,
      passed: e.passed,
      level: e.property!.level ?? null,
      seed: e.property!.seed,
      problems: e.property!.coverage ?? [],
      properties: (e.property!.report?.properties ?? []).map((p) => ({
        id: p.testId,
        status: p.status,
        cases: p.cases,
        families: p.families ?? null,
      })),
      corpus: e.property!.report?.corpus
        ? {
            executed: e.property!.report.corpus.executed,
            passed: e.property!.report.corpus.passed,
            failed: e.property!.report.corpus.failed.length,
          }
        : null,
    }));
  const binding = task.checkVersion;
  const suite = binding
    ? corpus.get(binding.suite)
    : corpus.all(task.repositoryId).find((x) => task.contracts.includes(x.contractId));
  const version = binding ? suite?.versions.find((v) => v.digest === binding.digest) : undefined;
  const confirmed = (version?.cases ?? []).map((cid) => suite!.cases[cid]);
  const decisions = (suite?.decisions ?? []).filter((d) => d.source.taskId === task.id);
  const disputed = decisions.filter((d) => d.outcome !== 'confirmed');
  const proposed = (s.reproductions ?? []).filter((r) => r.taskId === task.id);
  const waitingAdoption = !!suite?.pending.some(
    (p) => p.status === 'waiting' && !p.awaitingOperator && p.tasks.includes(task.id),
  );
  const awaitingOperator = suite?.pending.find(
    (p) => p.status === 'waiting' && p.awaitingOperator && p.tasks.includes(task.id),
  );
  const history: Record<
    string,
    { run: string; attempt: number; kind: string | null; at: string | null; summary: string }[]
  > = {};
  for (const r of runs)
    for (const p of r.properties ?? [])
      (history[p] ??= []).push({
        run: r.id,
        attempt: r.attempt,
        kind: r.failureKind ?? null,
        at: r.finishedAt ?? null,
        summary: (r.error ?? '').slice(0, 300),
      });
  const job = new LeadWorkflow(h)
    .list(task.scope === 'workspace' ? undefined : task.repositoryId)
    .find(
      (j) =>
        j.kind === 'board' &&
        s.boards
          .find((b) => b.id === j.id)
          ?.revisions.at(-1)
          ?.taskIds.includes(task.id),
    );
  const page = <T>(items: T[]) => ({
    total: items.length,
    cursor: q.cursor,
    items: items.slice(q.cursor, q.cursor + q.limit),
    nextCursor: q.cursor + q.limit < items.length ? q.cursor + q.limit : null,
  });
  return {
    taskId: task.id,
    level: task.properties?.length ? 'manifest' : 'legacy',
    versions: {
      effective: task.approvedDigest
        ? effectiveChecks(task, h.policyDigest(task.repositoryId))
        : null,
      lastRun: last?.checks?.effective ?? null,
      corpus: binding ?? null,
      suite: suite?.id ?? null,
      versions: (suite?.versions ?? []).map((v) => ({
        number: v.number,
        digest: v.digest,
        cases: v.cases.length,
        createdAt: v.createdAt,
      })),
    },
    properties,
    coverage,
    cases: {
      confirmed: confirmed.length,
      proposed: proposed.length,
      disputed: disputed.length,
      page: page(
        confirmed.map((c) => ({
          id: c.id,
          property: c.property,
          input: c.input,
          expected: c.expected,
          sha: c.source.sha,
          addedAt: c.addedAt,
        })),
      ),
      decisions: decisions
        .slice(-20)
        .reverse()
        .map((d) => ({
          id: d.id,
          property: d.property,
          outcome: d.outcome,
          reason: d.reason,
          origin: d.origin,
          version: d.version ?? null,
          at: d.at,
        })),
    },
    // История отказов растёт с каждой попыткой: по свойству — последние
    // 10 отказов и их общее число, необъявленные свойства — первые 50.
    history: (() => {
      const unbound = [...new Set(runs.flatMap((r) => r.unboundProperties ?? []))];
      return {
        byProperty: Object.fromEntries(
          Object.entries(history).map(([p, list]) => [p, list.slice(-10)]),
        ),
        counts: Object.fromEntries(Object.entries(history).map(([p, list]) => [p, list.length])),
        unbound: clip(unbound.slice(0, 50), 200),
        unboundCount: unbound.length,
      };
    })(),
    // Причины и история пишутся ведущим и оператором: строки ограничены.
    recovery: task.recovery
      ? clip({
          id: task.recovery.id,
          property: task.recovery.property,
          status: task.recovery.status,
          calls: task.recovery.calls,
          version: task.recovery.version,
          reason: task.recovery.reason ?? null,
          decision: task.recovery.decision
            ? {
                action: task.recovery.decision.action,
                reason: task.recovery.decision.reason,
                hypothesis: task.recovery.decision.hypothesis ?? null,
                source: task.recovery.decision.source,
              }
            : null,
          history: task.recovery.history.slice(-20),
          historyCount: task.recovery.history.length,
        })
      : null,
    recoveries: clip(
      (task.recoveryHistory ?? []).slice(-5).map((r) => ({
        id: r.id,
        property: r.property,
        status: r.status,
        action: r.decision?.action ?? null,
        reason: r.reason ?? null,
      })),
    ),
    budget: {
      attemptsUsed: task.attempt,
      attemptsMax: h.config.maxAttempts,
      repairsUsed: job?.repairs ?? 0,
      repairBudget: h.config.repairBudget,
    },
    next: awaitingOperator
      ? {
          actor: 'user' as Actor,
          step: `Принятие версии корпуса ждёт подтверждения оператора: devcontour checks-approve --suite ${suite!.id} --pending ${awaitingOperator.id}`,
        }
      : // Шаг может цитировать причину эпизода — она ограничена.
        clip(nextStep(h, task, waitingAdoption)),
  };
}

/** Краткая проекция для опрашиваемого состояния: только counts, id и причины. */
export function checksSummary(task: Task) {
  if (!task.properties?.length && !task.recovery && !task.checkVersion) return undefined;
  return {
    properties: task.properties ?? [],
    corpus: task.checkVersion
      ? { number: task.checkVersion.number, digest: task.checkVersion.digest }
      : null,
    recovery: task.recovery
      ? {
          status: task.recovery.status,
          property: task.recovery.property,
          reason: task.recovery.reason ?? null,
        }
      : null,
  };
}
