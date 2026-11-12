import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runGatesAt } from 'devcontour-harness';
import { digest, specDigest, type DevContour } from '../core/service.ts';
import {
  DomainError,
  requirementLink,
  type DevContourState,
  type Evidence,
  type Task,
} from '../core/model.ts';
import { requirementProof } from '../core/proof.ts';
import { scenarioKey } from '../core/product-map.ts';
import { repository, repositories } from '../core/repositories.ts';
import { taskOwner } from '../core/sync-state.ts';
import { executionOf, toDomain } from '../harness/execution.ts';
import { controllerBoundary } from './checks.ts';
import { checkoutRootOption, workspaceCheckoutRoot } from './checkout-root.ts';
import { journalError } from './board-coverage.ts';
import { IntentService } from './intent.ts';

/**
 * Доказательство сценария принятой задачи после приёмки (`task_scenario_proof`).
 *
 * Связь `requirements` с testcase входит в постановку: добавить её выполненной
 * задаче — значит изменить `specDigest` и исполнить задачу заново, а повтор
 * без изменений кода движок принимает только с механическим основанием
 * («уже выполнено»). Когда поведение уже проверяет существующий тест, писать
 * его заново не нужно: здесь названный gate исполняется на принятом SHA задачи
 * тем же исполнением, что integration (`runGatesAt`), и сценарий доказан,
 * только если названный testcase в этом прогоне выполнился и прошёл
 * (`requirementProof`, правило приёмки). Объявление без прогона ничего не
 * доказывает: запись хранит сам прогон.
 *
 * Запись локальная (как проверка доски): постановка задачи, её принятый
 * результат и история не меняются, Git sync запись не переносит — другая
 * копия доказывает сценарий своим прогоном.
 */
export const SCENARIO_PROOF = 'scenario-proof';

const taskId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
/** Вход `task_scenario_proof` и CLI `scenario-proof`. */
export const scenarioProofInput = z.strictObject({
  taskId,
  gate: requirementLink.shape.gate,
  scenario: requirementLink.shape.scenario,
  testId: requirementLink.shape.testId.unwrap(),
  reason: z.string().trim().min(10).max(5000),
});

export interface ScenarioProof {
  taskId: string;
  repositoryId: string;
  /** Принятый SHA задачи, на котором исполнен gate. */
  resultSha: string;
  /** Утверждённая постановка задачи на момент доказательства. */
  approvedDigest: string;
  gate: string;
  scenario: string;
  testId: string;
  reason: string;
  actor: 'agent' | 'operator';
  runId: string;
  /** Договор компонента, под которым исполнен gate. */
  policyDigest: string;
  /**
   * Определение gate (запись профиля компонента), которое исполнил прогон.
   * Другое определение того же ID — другой gate: доказательство перестаёт
   * действовать.
   */
  gateDigest: string;
  /** Решающая test-запись gate этого прогона (с манифестом testcases). */
  evidence: Evidence;
  at: string;
}

export const proofKey = (taskId: string, scenario: string) =>
  taskId + ':' + digest(scenarioKey(scenario)).slice(0, 32);

/** Запись сценария как связь для правила доказательства harness. */
const linkOf = (p: Pick<ScenarioProof, 'gate' | 'testId'>) => ({
  id: 'scenario',
  gate: p.gate,
  testId: p.testId,
});

/**
 * Записи доказательства задач компонента. Каждая перепроверяется при чтении
 * (`proofHolds`): запись относится к принятому результату и постановке
 * задачи, а её прогон доказывает testcase правилом приёмки.
 */
export function scenarioProofs(h: DevContour, repositoryId: string): ScenarioProof[] {
  return Object.values(h.store.localRecords<ScenarioProof>(SCENARIO_PROOF, repositoryId));
}

/** Digest текущего определения gate компонента; нет gate — undefined. */
export function gateDigestOf(h: DevContour, repositoryId: string, gate: string) {
  try {
    const found = repository(h.config, repositoryId).gates.find((g) => g.id === gate);
    return found ? digest(found) : undefined;
  } catch {
    return undefined;
  }
}

/** Решающая запись: та же выборка, что у `requirementProof`, и код выхода 0. */
const decisiveOf = (evidence: readonly Evidence[], gate: string, sha: string) =>
  evidence.findLast(
    (e) =>
      e.kind === 'test' &&
      !e.consumer &&
      e.gate === gate &&
      e.phase === 'integration' &&
      e.sha === sha,
  );

/**
 * Доказательство действует, пока относится к принятому результату и
 * постановке задачи, gate с тем же ID определён так же, как при прогоне, а
 * сохранённая запись прогона доказывает testcase правилом приёмки (с кодом
 * выхода 0, как у связи в постановке).
 */
export function proofHolds(h: DevContour, task: Task, p: ScenarioProof) {
  return (
    p.taskId === task.id &&
    task.status === 'done' &&
    Boolean(task.resultSha) &&
    p.resultSha === task.resultSha &&
    p.approvedDigest === task.approvedDigest &&
    p.gateDigest !== undefined &&
    p.gateDigest === gateDigestOf(h, p.repositoryId, p.gate) &&
    p.evidence.exitCode === 0 &&
    requirementProof(linkOf(p), [p.evidence], task.resultSha).level === 'testcase'
  );
}

/** Задача, которой можно доказать сценарий: принятая, не заменённая, компонентная. */
function provable(h: DevContour, state: DevContourState, id: string) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new DomainError('Задача не найдена: ' + id, 404);
  const owner = taskOwner(task);
  if (!owner)
    throw new DomainError(
      `${task.id}: задача workspace не доказывает сценарии компонента; нужна задача истории компонента`,
      409,
    );
  if (task.status !== 'done' || !task.resultSha)
    throw new DomainError(
      `${task.id}: доказать сценарий после приёмки можно только выполненной задаче с принятым результатом; черновику добавьте связь requirements со scenario и testId`,
      409,
    );
  if (state.tasks.some((t) => t.supersedes === task.id))
    throw new DomainError(`${task.id}: задача заменена корректировкой`, 409);
  if (!task.approvedDigest || task.approvedDigest !== specDigest(task))
    throw new DomainError(`${task.id}: постановка задачи изменилась после утверждения`, 409);
  return { task, repositoryId: owner, resultSha: task.resultSha };
}

/**
 * Исполнить названный gate на принятом SHA задачи и записать доказательство
 * сценария, если названный testcase выполнился и прошёл. Иначе — отказ с
 * причиной правила доказательства; запись не появляется.
 */
export async function proveScenario(
  h: DevContour,
  root: string,
  raw: unknown,
  actor: 'agent' | 'operator',
  signal?: AbortSignal,
) {
  const input = scenarioProofInput.parse(raw);
  const { task, repositoryId, resultSha } = provable(h, h.store.read(), input.taskId);
  const repo = repository(h.config, repositoryId);
  const gate = repo.gates.find((g) => g.id === input.gate);
  const tests = repo.gates.filter((g) => g.kind === 'test').map((g) => g.id);
  if (!gate || gate.kind !== 'test')
    throw new DomainError(
      `Gate ${input.gate} не объявлен как test gate компонента ${repositoryId}` +
        (tests.length ? `; test gates: ${tests.join(', ')}` : ''),
      400,
    );
  // Сценарий, который доказательство не засчитало бы (не сценарий фичи
  // историй задачи), — отказ до прогона.
  new IntentService(h).assertScenarioScope(task, input.scenario);
  const approvedDigest = task.approvedDigest!;
  const gateDigest = digest(gate);
  const policyDigest = h.policyDigest(repositoryId);
  const runId = 'SP-' + randomUUID();
  const subject = { taskId: task.id, repositoryId, sha: resultSha, gate: input.gate, runId };
  const event = (type: string, data: Record<string, unknown> = {}) =>
    h.store.atomic(() => h.store.appendEvent(type, { ...subject, ...data }));
  const roots = [root, ...repositories(h.config).map((r) => r.path)];
  event('scenario.proof.started', { testId: input.testId });
  let result;
  try {
    const { engine } = executionOf(h);
    result = await runGatesAt(
      {
        policy: engine.policy,
        stateDir: root,
        repoPath: (r) => repository(h.config, r.id).path,
        boundary: () => controllerBoundary(h, root),
        ...checkoutRootOption(workspaceCheckoutRoot(h)),
        ...(h.config.resourceDatabase ? { resourceDatabase: h.config.resourceDatabase } : {}),
      },
      {
        id: runId,
        repositoryId,
        sha: resultSha,
        gates: [input.gate],
        record: () => {},
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    try {
      event('scenario.proof.failed', { error: journalError(error, roots) });
    } catch {
      // Без права записи событие не пишется; причина — исходная ошибка.
    }
    throw toDomain(error);
  }
  const evidence = result.evidence as unknown as Evidence[];
  const proof = requirementProof(linkOf(input), evidence, resultSha);
  if (proof.level !== 'testcase') {
    event('scenario.proof.failed', { testId: input.testId, reason: proof.reason });
    throw new DomainError(
      `Сценарий не доказан прогоном ${input.gate} на принятом SHA ${resultSha.slice(0, 12)}: ${proof.reason}. ` +
        'Имя testcase — requirements_testcases (CLI: requirements-testcases); если тест поведения ещё нет, нужна задача, которая его напишет.',
      409,
      { reason: proof.reason },
    );
  }
  const decisive = decisiveOf(evidence, input.gate, resultSha)!;
  if (decisive.exitCode !== 0) {
    const reason = `Проверка ${input.gate} завершилась с кодом ${decisive.exitCode}`;
    event('scenario.proof.failed', { testId: input.testId, reason });
    throw new DomainError(`Сценарий не доказан: ${reason}`, 409, { reason });
  }
  const record: ScenarioProof = {
    taskId: task.id,
    repositoryId,
    resultSha,
    approvedDigest,
    gate: input.gate,
    scenario: input.scenario,
    testId: input.testId,
    reason: input.reason,
    actor,
    runId,
    policyDigest,
    gateDigest,
    evidence: decisive,
    at: new Date().toISOString(),
  };
  try {
    h.store.atomic(() => {
      // Задача и договор те же, что при запуске прогона: иначе прогон доказывал
      // бы не то, что записано.
      const now = provable(h, h.store.read(), task.id);
      if (now.resultSha !== resultSha || now.task.approvedDigest !== approvedDigest)
        throw new DomainError('Принятый результат задачи изменился во время прогона', 409);
      if (h.policyDigest(repositoryId) !== policyDigest)
        throw new DomainError('Договор компонента изменился во время прогона', 409);
      h.store.saveLocal(SCENARIO_PROOF, repositoryId, proofKey(task.id, input.scenario), record);
      h.store.appendEvent('scenario.proof.recorded', {
        ...subject,
        testId: input.testId,
        scenario: input.scenario,
        reason: input.reason,
        actor,
      });
    });
  } catch (error) {
    // Начатый прогон кончается событием и тогда, когда запись не состоялась.
    try {
      event('scenario.proof.failed', {
        testId: input.testId,
        reason: 'record',
        error: journalError(error, roots),
      });
    } catch {
      // Без права записи событие не пишется; причина — исходная ошибка.
    }
    throw error;
  }
  return {
    taskId: task.id,
    repositoryId,
    sha: resultSha,
    gate: input.gate,
    scenario: input.scenario,
    testId: input.testId,
    runId,
    level: proof.level,
    proof: proof.reason,
    actor,
    note: 'Evidence-only: the gate ran at the accepted SHA; the approved spec, result and history of the task are unchanged. intent_report lists this proof with afterAcceptance: true. Local to this copy: Git sync does not carry it.',
  };
}
