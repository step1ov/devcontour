import type { DevContour } from '../core/service.ts';
import type { AuditEvent, DevContourState } from '../core/model.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { repositories } from '../core/repositories.ts';
import { queueStopView } from '../core/work-status.ts';

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
