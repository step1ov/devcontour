import type { DevContour } from '../core/service.ts';
import type { AuditEvent, DevContourState } from '../core/model.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { repositories } from '../core/repositories.ts';
import {
  livenessNext,
  livenessText,
  queueStopView,
  runLiveness,
  type RunLiveness,
} from '../core/work-status.ts';

/**
 * Остановка очереди контура (`queueStopView`) с режимом согласований и
 * признаком зарегистрированной работы ведущего: от них зависит, кто снимет
 * исходную и штатную паузы. Состояние передаёт вызывающий, если уже прочитал
 * его для ответа: вид остановки и остальные поля ответа — один снимок.
 */
export function queueStopOf(
  h: DevContour,
  state: DevContourState = h.store.read(),
  events: AuditEvent[] = h.store.events(),
) {
  return queueStopView(state, events, {
    approvalMode: h.config.approvalMode,
    // Работа ведущего нужна только для подсказки остановленной очереди.
    workflowActive: state.paused && workflowActive(h),
  });
}

/** Есть ли работа ведущего, которую продвинет цикл `serve` (queued/running). */
function workflowActive(h: DevContour) {
  const workflow = new LeadWorkflow(h);
  return [undefined, ...repositories(h.config).map((r) => r.id)].some((owner) =>
    workflow.list(owner).some((j) => j.status === 'queued' || j.status === 'running'),
  );
}

/** Идущая попытка без движения глазами ведущего агента и CLI. */
export type QuietAttempt = RunLiveness & {
  taskId: string;
  title: string;
  runId: string;
  attempt: number;
  phase: string;
  repositoryId: string;
  /** Подпись состояния словами панели («зависла 12 мин: проверьте среду»). */
  text: string;
  /** Что делать и кто действует. */
  next: string;
};

/**
 * Идущие попытки без движения (`quiet`/`stalled` обхода зависаний
 * controller): ведущий видит их в `workflow_status`, не запрашивая журнал.
 * Сначала требующие человека, затем дольше всех стоящие. `repositoryId` —
 * только попытки компонента.
 */
export function quietAttempts(
  state: Pick<DevContourState, 'runs' | 'tasks'>,
  now: number,
  repositoryId?: string,
): QuietAttempt[] {
  return state.runs
    .flatMap((run) => {
      const liveness = runLiveness(run, now);
      if (!liveness) return [];
      const task = state.tasks.find((t) => t.id === run.taskId);
      const repo = run.repositoryId ?? task?.repositoryId ?? 'main';
      if (repositoryId && repo !== repositoryId) return [];
      return [
        {
          taskId: run.taskId,
          title: task?.title ?? run.taskId,
          runId: run.id,
          attempt: run.attempt,
          phase: run.phase,
          repositoryId: repo,
          ...liveness,
          text: livenessText(liveness),
          next: livenessNext(liveness),
        },
      ];
    })
    .sort((a, b) => Number(b.attention) - Number(a.attention) || b.idleMs - a.idleMs);
}
