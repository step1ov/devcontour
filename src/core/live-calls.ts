import { activeStart, type UsageRecord } from './usage.ts';

/**
 * Идущие ли вызовы на самом деле. Процессы и ОС — дело runner: он
 * регистрирует свой процесс и проверку чужого владельца. Без регистрации
 * чужой владелец живым не считается (консервативно).
 */
type Owner = { id: string; pid: number; startedAt?: number };
let current: Owner | undefined;
let foreignAlive: (owner: Owner) => boolean = () => false;
export function registerProcess(owner: Owner, alive: (owner: Owner) => boolean) {
  current = owner;
  foreignAlive = alive;
}

/**
 * Вызов идёт на самом деле. Свой — ещё не завершён в этом процессе. Чужой —
 * его процесс существует и это тот же процесс (pid этого процесса у чужой
 * записи значит, что pid достался нам; момент старта сверяет runner), и вызов
 * не старше `maxMs`. Владелец, которого подтвердить нельзя, живым не считается.
 */
export function liveCall(r: UsageRecord, at: number, maxMs: number) {
  if (r.outcome !== 'active' || !r.process) return false;
  if (current && r.process.id === current.id) return activeStart(r.id) !== undefined;
  if (r.process.pid === process.pid || r.process.startedAt === undefined) return false;
  if (at - Date.parse(r.startedAt) > maxMs) return false;
  return foreignAlive(r.process);
}
