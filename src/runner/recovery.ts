import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError, type Task } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import { CheckCorpus } from '../core/check-store.ts';
import { obligationOf } from '../core/checks.ts';
import { recoveryActions, type RecoveryDecision } from '../core/property-recovery.ts';
import { taskOwner } from '../core/sync-state.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import { measuredAgentCall } from '../harness/measured.ts';
import { toolProfileFor, agentEnvironment } from './tools.ts';
import { isolation } from './isolation.ts';
import { submitCase } from './checks.ts';

/**
 * Разбор ведущего по повторяющемуся свойству.
 *
 * Ответ — структурированное предложение с причиной и evidence, а не
 * произвольная программа или правка базы. Контур проверяет допустимость и
 * исполняет только разрешённое: добавление подтверждённых случаев под
 * существующим эталоном и один повтор с новой гипотезой — полностью
 * автономно; усиление checker и декомпозиция — подготовленным предложением
 * для обычного ревью; уточнение обязательства — решением пользователя;
 * причина в среде — остановкой с диагностикой.
 */
export const recoveryResult = z.object({
  action: z.enum(recoveryActions),
  reason: z.string().min(10).max(4000),
  evidence: z.array(z.string().max(2000)).max(20),
  hypothesis: z.string().max(4000).nullable(),
  plan: z.string().max(4000).nullable(),
  cases: z
    .array(
      z.object({
        input: z
          .string()
          .min(1)
          .max(64 * 1024),
        expected: z
          .string()
          .max(64 * 1024)
          .nullable(),
      }),
    )
    .max(10)
    .nullable(),
  proposal: z.string().max(8000).nullable(),
  conflict: z.string().max(4000).nullable(),
});
/** Что ведущий получает для разбора: свойство, версии, примеры, попытки, время, действия. */
export function recoveryBrief(h: DevContour, task: Task) {
  const s = h.store.read();
  const r = task.recovery!;
  const found = obligationOf(task, s.contracts, r.property);
  const runs = r.runs
    .map((id) => s.runs.find((x) => x.id === id))
    .filter((x): x is NonNullable<typeof x> => !!x);
  const corpus = task.checkVersion ? new CheckCorpus(h).get(task.checkVersion.suite) : undefined;
  const duration = (x: (typeof runs)[number]) =>
    x.finishedAt ? Date.parse(x.finishedAt) - Date.parse(x.startedAt) : null;
  return {
    task: { id: task.id, title: task.title, description: task.description, attempt: task.attempt },
    property: r.property,
    obligation: found?.obligation,
    versions: {
      spec: task.approvedDigest,
      contracts: task.contractDigests,
      corpus: task.checkVersion ?? null,
      policy: h.taskPolicyDigest(task),
    },
    examples: [
      ...runs.flatMap((x) =>
        x.evidence
          .filter((e) => e.property?.report)
          .flatMap((e) =>
            e
              .property!.report!.properties.filter(
                (p) => p.testId === r.property && p.status !== 'passed',
              )
              .map((p) => ({
                run: x.id,
                phase: e.phase,
                seed: e.property!.seed,
                counterexample: p.counterexample ?? null,
                current: p.current ?? null,
              })),
          ),
      ),
      ...(s.reproductions ?? [])
        .filter((x) => x.taskId === task.id && x.property === r.property)
        .slice(-10)
        .map((x) => ({
          reproduction: x.id,
          input: x.input,
          expected: x.expected,
          actual: x.actual,
          observed: x.observed,
        })),
    ],
    corpus: corpus
      ? {
          suite: corpus.id,
          cases: Object.values(corpus.cases)
            .filter((c) => c.property === r.property)
            .slice(-20)
            .map((c) => ({ id: c.id, input: c.input, expected: c.expected })),
        }
      : null,
    attempts: runs.map((x) => ({
      run: x.id,
      attempt: x.attempt,
      failureKind: x.failureKind,
      error: x.error?.slice(0, 2000),
      findings: x.evidence.flatMap((e) => (e.passed ? [] : (e.findings ?? []))).slice(0, 20),
      durationMs: duration(x),
    })),
    spentMs: runs.reduce((n, x) => n + (duration(x) ?? 0), 0),
    budgets: {
      attemptsLeft: h.config.maxAttempts - task.attempt,
      repairBudget: h.config.repairBudget,
    },
    actions: {
      'add-cases':
        'Add confirmed cases under the existing pinned oracle (inputs as exact JSON); each is confirmed by the controller on the defective commit, then one retry runs within the remaining attempts.',
      'new-approach':
        'One retry with a concrete new implementation hypothesis and a verification plan; the hypothesis is handed to the executor with its source.',
      'strengthen-checker':
        'Prepare a proposal to strengthen the checker or oracle; it goes through the normal contract/plan review and is not applied automatically.',
      'split-task':
        'Prepare a proposal to split the task; it goes through normal replanning and is not applied automatically.',
      'clarify-obligation':
        'Name the conflict in the product obligation; the work waits for the user decision.',
      environment: 'The cause is in the environment or unknown; stop with a diagnosis.',
    },
  };
}

export async function analyzeRecovery(
  h: DevContour,
  root: string,
  task: Task,
  author: 'codex' | 'claude',
  signal: AbortSignal,
  runtimes: Record<'codex' | 'claude', AgentAdapter> = adapters,
): Promise<RecoveryDecision> {
  const brief = recoveryBrief(h, task);
  const repo = repository(h.config, task.repositoryId);
  const dir = join(root, 'recoveries', task.recovery!.id);
  await mkdir(dir, { recursive: true });
  const prompt = [
    'You are the lead agent. A task failed twice in a row on the same declared property and the controller stopped automatic retries until you decide.',
    'Choose exactly one action. Prefer the narrowest action that addresses the class of defect, not only the last example. A timeout or flaky case is not proof of a defect; a product obligation is never weakened by you — name the conflict instead. Return a structured decision with reason and evidence. Do not edit files.',
    JSON.stringify(brief, null, 2),
  ].join('\n\n');
  await writeFile(join(dir, 'prompt.txt'), prompt);
  const toolProfile = toolProfileFor(h.config, author, task.role, true, task.repositoryId);
  const result = await measuredAgentCall(
    h,
    runtimes[author],
    {
      toolProfile,
      execution: agentEnvironment(h.config, toolProfile),
      cwd: repo.path,
      artifactDir: dir,
      prompt,
      review: true,
      purpose: 'recovery',
      task,
      isolation:
        h.config.isolation.mode === 'os'
          ? isolation({
              write: [],
              controller: [root],
              readable: [repo.path],
              domains: h.config.isolation.domains,
            })
          : undefined,
      model: h.config.reviewer.runtime === author ? h.config.reviewer.model : undefined,
      signal,
      timeoutMs: h.config.runTimeoutMs,
    },
    {
      repositoryId: taskOwner(task),
      runId: task.recovery!.runs.at(-1),
      subjectId: task.id,
      stage: 'property-recovery',
    },
  );
  const parsed = recoveryResult.parse(result.data);
  await writeFile(join(dir, 'decision.json'), JSON.stringify(parsed, null, 2));
  return {
    action: parsed.action,
    reason: parsed.reason,
    evidence: parsed.evidence,
    ...(parsed.hypothesis ? { hypothesis: parsed.hypothesis } : {}),
    ...(parsed.plan ? { plan: parsed.plan } : {}),
    ...(parsed.cases ? { cases: parsed.cases } : {}),
    ...(parsed.proposal ? { proposal: parsed.proposal } : {}),
    ...(parsed.conflict ? { conflict: parsed.conflict } : {}),
    source: { kind: 'lead', runtime: author, ...(result.command.length ? {} : {}) },
    decidedAt: new Date().toISOString(),
  };
}

/**
 * Исполнить разрешённое добавление случаев: каждый подтверждается эталоном
 * на дефектном SHA. Ключи выводятся из эпизода — повтор после сбоя не создаёт
 * второго подтверждения.
 */
export async function applyCases(h: DevContour, root: string, task: Task) {
  const r = task.recovery!;
  const cases = r.decision?.cases ?? [];
  const outcomes: { outcome: string; reason: string }[] = [];
  const source = r.runs.at(-1);
  for (const [i, c] of cases.entries()) {
    const result = await submitCase(h, root, {
      taskId: task.id,
      property: r.property,
      input: c.input,
      expected: c.expected ?? null,
      sourceRunId: source,
      key: `${r.id}-case-${i}`,
      origin: r.decision!.source.kind === 'lead' ? 'lead' : 'operator',
      runtime: r.decision!.source.runtime,
    });
    outcomes.push({ outcome: result.decision.outcome, reason: result.decision.reason });
  }
  if (!cases.length) throw new DomainError('Решение add-cases без случаев', 400);
  return outcomes;
}
