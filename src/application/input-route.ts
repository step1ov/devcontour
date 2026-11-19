// Маршрут contract-change отклонённого ответа (F82): правило находки ревью
// и его разбор. Отдельный модуль: его читают и служба вопросов, и проход
// сервера (`input-resume.ts`), который служба сама импортирует.
import type { InputRequest, ReviewRecord } from 'devcontour-harness';

/**
 * Правило находки ревью ответа, которым reviewer называет маршрут
 * contract-change: ответ — последовательный выбор, и его единственный
 * конфликт с утверждённой задачей — явная поправка закреплённого контракта.
 * Значение — `contract-change:<ID контракта>`, одна находка на контракт.
 */
export const CONTRACT_CHANGE_RULE = 'contract-change:';
const CONTRACT_RULE = /^contract-change:([A-Za-z0-9_-]{1,80})$/;

/**
 * ID контрактов, которые называет маршрут contract-change раунда: раунд
 * отклонён, вопрос затрагивает контракт, и каждая открытая блокирующая
 * находка несёт правило `contract-change:<ID>`. Любая другая блокирующая
 * находка — обычное отклонение. Проверку ID по постановке задачи делает
 * вызывающий.
 */
export function routeRules(
  round: Pick<ReviewRecord, 'approved' | 'findings'>,
  request: Pick<InputRequest, 'question'>,
): string[] | undefined {
  if (round.approved || !request.question.affects.includes('contract')) return undefined;
  const blocking = round.findings.filter((f) => f.status === 'open' && f.severity === 'blocking');
  if (!blocking.length) return undefined;
  const ids: string[] = [];
  for (const f of blocking) {
    const match = CONTRACT_RULE.exec(f.rule?.trim() ?? '');
    if (!match) return undefined;
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}
