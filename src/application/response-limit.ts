/**
 * Отказ по пределу ответа агентского API (64 KiB) называет путь, который
 * существует: поля входа самой операции (её inputSchema в capabilities).
 * Прежний текст отсылал к «CLI-отчёту», которого у большинства операций нет.
 * Общий модуль: им пользуются AgentService, AgentContext и PreparationAgent.
 */

/** Отказ `workflow_status`: поля, которые сужают именно его. */
export const WORKFLOW_STATUS_OVERSIZED =
  'Ответ workflow_status превышает 64 KiB: сузьте запрос полями его входа — key (одно задание), kind и id (задания одной доски или ChangeSet), active (true — только действующие), limit (число законченных)';

export function oversized(operation: string) {
  if (operation === 'workflow_status') return WORKFLOW_STATUS_OVERSIZED;
  return `Ответ ${operation} превышает 64 KiB: сузьте запрос полями его входа, если они есть (фильтры, limit, cursor — inputSchema операции в capabilities)`;
}
