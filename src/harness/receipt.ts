// Receipt Git-синхронизации — переносимый результат принятой задачи.
//
// Формат receipt не меняется: receipts прежних версий в Git читаются как
// прежде. Приёмку по receipt проверяет получатель harness (`resultProblems`):
// receipt переводится в `RunResult` по таблице `receiptFields`, контекст
// получателя — постановка, договоры, политика и корпус этого клона. В
// DevContour остаются только правила формата receipt (`validateReceipt`).
import {
  API_VERSION,
  STATE_VERSION,
  digestOf,
  resultProblems,
  vendorOf,
  type PortableSuite,
  type ReceiverContext,
  type RunResult,
} from 'devcontour-harness';
import type { Contract, Task } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { specDigest } from '../core/service.ts';
import { effectiveChecks } from '../core/checks.ts';
import { localSuite } from '../core/check-store.ts';
import type { CompletionReceipt } from '../core/sync-model.ts';
import { policyFromConfig } from './policy.ts';
import { contractDocumentOf, orderOf } from './projection.ts';
import { projectionOptions, suiteBasisOf } from './host.ts';

/**
 * Откуда берётся каждое поле `RunResult`, построенного из receipt.
 *
 * - `receipt` — значение receipt; получатель harness сверяет его по своей
 *   модели доверия (`receiptTrust`);
 * - `receiver` — receipt такого поля не несёт: привязку к поручению дают
 *   `taskId` и `specDigest`, которые сверяет `validateReceipt`, поэтому
 *   значение берётся у получателя и ничего не доказывает;
 * - `fixed` — сведение без доказательной силы (`informative` в модели
 *   доверия) или литерал схемы.
 */
export const receiptFields = {
  workOrderId: ['receipt', 'taskId'],
  repositoryId: ['receipt', 'repositoryId'],
  runId: ['receipt', 'id'],
  'inputs.policyDigest': ['receipt', 'policyDigest'],
  'inputs.requiredGates': ['receipt', 'requiredGates'],
  'inputs.writer.runtime': ['receipt', 'runtime (demo — fixture на границе)'],
  'inputs.checks': ['receipt', 'checkVersion.effective'],
  'inputs.corpus': ['receipt', 'checkVersion.corpus'],
  'shas.candidate': ['receipt', 'candidateSha'],
  'shas.integration': ['receipt', 'resultSha'],
  'shas.result': ['receipt', 'resultSha'],
  evidence: ['receipt', 'checks[]; запись потребителя — вид consumer'],
  'evidence[].tests': [
    'receipt',
    'tests собственной проверки интеграции; у прочих записей не переносится',
  ],
  'evidence[].reviewer': ['receipt', 'reviewer у записей ревью; признак вендора — по writer'],
  'checked.dependencies': ['receipt', 'dependencies (нет поля — входы не наблюдались)'],
  'checked.freshness': ['receipt', 'dependencies[].sha и head'],
  'checked.consumers': ['receipt', 'consumers (нет свежести — входы не наблюдались)'],
  graphId: ['receiver', 'граф receipt не переносит'],
  source: ['receiver', 'источник — редакция постановки, сверенная по specDigest'],
  targetRef: ['receiver', 'target ref политики получателя'],
  'inputs.workOrderDigest': ['receiver', 'поручение получателя'],
  'inputs.contextDigest': ['receiver', 'снимок контекста receipt не переносит'],
  'shas.base': ['fixed', 'основание receipt не переносит; не проверяется'],
  attempt: ['fixed', 'номер попытки'],
  'inputs.harnessVersion': ['fixed', 'receipt DevContour'],
  'inputs.graphDigest': ['fixed', 'граф receipt не переносит'],
  'evidence[].id': ['fixed', 'позиция записи в receipt'],
  'evidence[].summary': ['fixed', 'receipt не переносит'],
} as const;

const RECEIPT_GRAPH = 'devcontour-receipt';
const ownIntegration = (c: CompletionReceipt['checks'][number]) =>
  c.kind === 'test' && c.phase === 'integration' && !c.consumer;
const harnessRuntime = (runtime: CompletionReceipt['runtime']) =>
  runtime === 'demo' ? ('fixture' as const) : runtime;

/** Receipt в форме переносимого результата harness (`receiptFields`). */
export function receiptResult(
  receipt: CompletionReceipt,
  context: Pick<ReceiverContext, 'order' | 'policy'>,
): RunResult {
  const repo = context.policy.repositories.find((r) => r.id === receipt.repositoryId);
  const writer = harnessRuntime(receipt.runtime);
  const reviewer = harnessRuntime(receipt.reviewer);
  return {
    apiVersion: API_VERSION,
    outcome: 'accepted',
    workOrderId: receipt.taskId,
    graphId: RECEIPT_GRAPH,
    source: context.order.source,
    runId: receipt.id,
    attempt: 1,
    repositoryId: receipt.repositoryId,
    targetRef: repo?.targetRef ?? '',
    inputs: {
      harnessVersion: 'devcontour-receipt',
      stateVersion: STATE_VERSION,
      workOrderDigest: digestOf(context.order),
      graphDigest: digestOf(RECEIPT_GRAPH),
      policyDigest: receipt.policyDigest,
      ...(receipt.checkVersion ? { checks: receipt.checkVersion.effective } : {}),
      ...(receipt.checkVersion?.corpus ? { corpus: receipt.checkVersion.corpus } : {}),
      requiredGates: receipt.requiredGates,
      writer: { runtime: writer },
    },
    checked: {
      dependencies: (receipt.dependencies ?? []).map(({ repositoryId, sha, tree, artifacts }) => ({
        repositoryId,
        sha,
        tree,
        artifacts,
      })),
      freshness: (receipt.dependencies ?? []).flatMap((d) =>
        d.head
          ? [
              {
                repositoryId: d.repositoryId,
                snapshot: d.sha,
                head: d.head,
                fresh: d.sha === d.head,
              },
            ]
          : [],
      ),
      consumers: (receipt.consumers ?? []).map((c) => ({
        repositoryId: c.repositoryId,
        gates: c.gates,
        sha: c.sha,
        tree: c.tree,
        dependencies: c.dependencies,
        freshness: c.freshness ?? [],
      })),
    },
    evidence: receipt.checks.map((c, i) => ({
      id: `${receipt.id}/${i}`,
      kind: c.consumer ? 'consumer' : c.kind,
      phase: c.phase,
      gate: c.gate,
      sha: c.sha,
      passed: c.passed,
      digest: c.digest,
      summary: '',
      ...(c.consumer ? { consumer: c.consumer } : {}),
      ...(c.checks ? { checks: c.checks } : {}),
      // Список тестов доказывает testcase только у собственной проверки
      // интеграции; у остальных записей receipt он сведение и не переносится.
      ...(c.tests && ownIntegration(c) ? { tests: c.tests } : {}),
      ...(c.testsTruncated && ownIntegration(c) ? { testsTruncated: c.testsTruncated } : {}),
      ...(c.property
        ? {
            property: {
              level: c.property.level,
              ...(c.property.manifest ? { manifest: c.property.manifest } : {}),
            },
          }
        : {}),
      ...(c.kind === 'review'
        ? { reviewer: { runtime: reviewer, sameVendor: vendorOf(reviewer) === vendorOf(writer) } }
        : {}),
    })),
    findings: [],
    limitations: [],
    finishedAt: receipt.finishedAt,
    shas: {
      base: receipt.candidateSha,
      candidate: receipt.candidateSha,
      integration: receipt.resultSha,
      result: receipt.resultSha,
    },
  };
}

/**
 * Что получатель знает сам о задаче receipt: её постановка и договоры (из
 * состояния, в котором задача проверяется), политика этого клона, корпус по
 * копии в Git и закреплённая за задачей версия корпуса.
 */
export function receiptContext(
  h: DevContour,
  task: Task,
  contracts: Contract[],
  suites: (id: string) => PortableSuite | undefined,
  unobserved: NonNullable<ReceiverContext['unobserved']>,
): ReceiverContext {
  const own = task.contracts
    .map((id) => contracts.find((c) => c.id === id))
    .filter((c): c is Contract => !!c);
  return {
    order: orderOf(task, {
      ...projectionOptions(h),
      contractDigest: (id) => contracts.find((c) => c.id === id)?.digest,
    }),
    graphId: RECEIPT_GRAPH,
    contracts: own.map(contractDocumentOf),
    policy: policyFromConfig(h.config),
    contextDigest: null,
    specDigest: specDigest(task),
    checkVersion: task.checkVersion ?? null,
    suite: (id) => {
      const suite = suites(id);
      return suite && localSuite(suite);
    },
    suiteBasis: (contract) => suiteBasisOf(contract),
    checksDigest: ({ specDigest: spec, policyDigest, corpus }) =>
      effectiveChecks(
        {
          approvedDigest: spec,
          contractDigests: task.contractDigests,
          ...(corpus ? { checkVersion: { ...task.checkVersion!, ...corpus } } : {}),
        },
        policyDigest,
      ),
    unobserved,
    // Receipt перепроверяется при каждой синхронизации, а назначение ролей
    // могло смениться: writer и reviewer — записанные в receipt.
    assignment: 'recorded',
  };
}

/** Условия приёмки, которые receipt не подтверждает (проверка получателя harness). */
export function receiptProblems(
  h: DevContour,
  receipt: CompletionReceipt,
  task: Task,
  contracts: Contract[],
  suites: (id: string) => PortableSuite | undefined,
  unobserved: NonNullable<ReceiverContext['unobserved']>,
) {
  const context = receiptContext(h, task, contracts, suites, unobserved);
  return resultProblems(receiptResult(receipt, context), context);
}
