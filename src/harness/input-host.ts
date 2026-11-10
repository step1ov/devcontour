// Порт продолжения после ответа на вопрос исполнителя (`ExecutionHost.input`).
//
// DevContour согласует задачи сам (утверждение ревизии доски), поэтому
// снимок контекста с ответом движок не активирует в `graph.approval`: его
// активирует этот порт в задаче (`Task.inputContext`), а claim закрепляет
// его по `contextDigestOf`. Ревью снимка — раунд технического ревью плана с
// отдельным предметом `input-<id>`: раунды ответа не смешиваются с историей
// ревью плана доски.
import {
  HarnessError,
  WORKSPACE_OWNER,
  digestOf,
  type ExecutionView,
  type InputHost,
  type ReviewRecord,
  type WorkState,
} from 'devcontour-harness';
import type { DevContour } from '../core/service.ts';
import { specDigest } from '../core/task-digest.ts';
import type { Task } from '../core/model.ts';
import { approvalPolicyDigest } from './policy.ts';
import { reviewExecutionOf } from './execution.ts';
import type { DevContourExecutionStore } from './store.ts';

/** Предмет раундов ревью снимка с ответом на запрос `requestId`. */
export const inputReviewSubject = (requestId: string) => 'input-' + requestId;

/**
 * Digest предложения, которое проверяет ревью ответа: задача, запрос,
 * точный ответ, утверждение задачи и утверждаемая часть политики. Другой
 * ответ, переутверждение или смена политики — новый раунд. У черновика
 * утверждения нет, и его заменяет постановка: ревью одной редакции черновика
 * не годится для применения к другой (перенос ответа в черновике, F14).
 */
export function inputReviewDigest(
  h: DevContour,
  task: Task,
  requestId: string,
  answerDigest: string,
) {
  return digestOf({
    kind: 'input-answer',
    taskId: task.id,
    requestId,
    answerDigest,
    approvedDigest: task.approvedDigest ?? null,
    ...(task.approvedDigest ? {} : { draftSpec: specDigest(task) }),
    approvalPolicy: approvalPolicyDigest(h.config),
  });
}

/** Раунды ревью ответа на запрос по порядку. */
export function inputReviewRounds(view: ExecutionView, requestId: string): ReviewRecord[] {
  const subject = inputReviewSubject(requestId);
  return view
    .locals('reviews', WORKSPACE_OWNER)
    .map((r) => r.value)
    .filter((r) => r.kind === 'plan' && r.subject === subject)
    .sort((a, b) => a.round - b.round);
}

/**
 * Действующий снимок с ответами задачи: активированный и привязанный к её
 * текущему утверждению. Переутверждённая задача (новая постановка) прежний
 * снимок не закрепляет — контекст снова живой из пакетов.
 */
export function activeInputContext(task: Task) {
  const context = task.inputContext;
  return context && context.approvedDigest === task.approvedDigest ? context : undefined;
}

/**
 * Утверждение черновика сохраняет снимок с ответами, активированный в этом
 * черновике (перенос ответа после `reopen` и новой постановки, F14), если
 * утверждена ровно та постановка, к которой ответ применён. Прежде снимок
 * терял привязку при утверждении, применение устаревало (`input.stale`), и
 * цепочку ответа проходили второй раз. Постановка, изменённая после
 * применения, снимок не наследует: ответ ревьюировали для другой редакции.
 * `draftSpec` — постановка черновика до закрепления контрактов утверждением
 * (в черновике `contractDigests` пусты, утверждение их закрепляет);
 * вызывается после записи нового `approvedDigest`.
 */
export function rebindInputContext(task: Task, draftSpec: string) {
  const context = task.inputContext;
  if (!context || context.approvedDigest || !context.specDigest || !task.approvedDigest) return;
  if (context.specDigest !== draftSpec) return;
  context.approvedDigest = task.approvedDigest;
}

const taskOf = (store: DevContourExecutionStore, view: ExecutionView, work: WorkState) => {
  const task = store.stateOf(view).tasks.find((t) => t.id === work.id);
  if (!task) throw new HarnessError('NOT_FOUND', 'Задача не найдена: ' + work.id);
  return task;
};

export function devcontourInputHost(h: DevContour, store: DevContourExecutionStore): InputHost {
  return {
    contextDigestOf: (work, view) => activeInputContext(taskOf(store, view, work))?.digest,
    review: (work, contextDigest, actor, view, request) => {
      const task = taskOf(store, view, work);
      const last = inputReviewRounds(view, request.id).at(-1);
      if (!last || last.digest !== inputReviewDigest(h, task, request.id, request.answerDigest))
        throw new HarnessError(
          'APPROVAL_REQUIRED',
          `Ответ на запрос ${request.id} не прошёл ревью для текущего утверждения задачи и политики: проведите input_review со снимком ответа`,
        );
      if ((last.contextDigest ?? null) !== contextDigest)
        throw new HarnessError(
          'APPROVAL_REQUIRED',
          `Последний раунд ревью ответа на запрос ${request.id} рассматривал другой снимок контекста: проведите input_review с этим снимком`,
        );
      const binding = reviewExecutionOf(h).engine.reviewerBinding('plan', last.authorRuntime);
      if ((last.reviewerBinding ?? null) !== (binding ?? null))
        throw new HarnessError(
          'APPROVAL_STALE',
          `Назначение reviewer изменилось после ревью ответа на запрос ${request.id}: нужен новый раунд input_review`,
        );
      // В режиме оператора решение — само применение оператором; ревью — сведение.
      if (actor === 'agent' && !last.approved)
        throw new HarnessError(
          'REVIEW_REJECTED',
          `Ревью ответа на запрос ${request.id} (раунд ${last.round}) отклонено: ${last.summary.slice(0, 500)}`,
        );
      return {
        round: last.round,
        approved: last.approved,
        reviewerBinding: last.reviewerBinding ?? null,
      };
    },
    // Активация — продуктовое поле задачи во вложенной транзакции хоста той же
    // записи, что `applied` запроса и повтор: откат движка снимает и её.
    activate: (_tx, work, target, request) =>
      store.host('input.applied', (ht) => {
        const task = ht.state.tasks.find((t) => t.id === work.id);
        if (!task) throw new HarnessError('NOT_FOUND', 'Задача не найдена: ' + work.id);
        if (target.contextDigest === null)
          throw new HarnessError(
            'INVALID_INPUT',
            `Запрос ${request.id}: продолжение без снимка контекста у DevContour невозможно`,
          );
        const previous = activeInputContext(task);
        task.inputContext = {
          digest: target.contextDigest,
          // Черновик: снимок привязан к постановке, и её утверждение
          // привяжет его к себе (`rebindInputContext`, F14).
          ...(task.approvedDigest
            ? { approvedDigest: task.approvedDigest }
            : { specDigest: specDigest(task) }),
          requestIds: [
            ...(previous?.requestIds ?? []).filter((id) => id !== request.id),
            request.id,
          ],
          targetDigest: target.digest,
          actor: target.actor,
          activatedAt: new Date().toISOString(),
        };
      }),
  };
}
