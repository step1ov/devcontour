import { randomUUID } from 'node:crypto';
import { activeStart, type UsageRecord } from './usage.ts';

/**
 * Идущие вызовы моделей этого процесса. Отдельно от `usage.ts`: тот входит в
 * модель конфигурации и в бандл панели, а здесь — процесс и его часы.
 */
/** Этот процесс: по нему восстановление и бюджет отличают свои идущие вызовы. */
export const CURRENT_PROCESS = { id: randomUUID(), pid: process.pid };
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
/**
 * Вызов идёт на самом деле: его владелец жив (свой — ещё не завершил вызов,
 * чужой — процесс существует) и вызов не старше `maxMs`. Запись без процесса,
 * умершего процесса или слишком старая (pid мог достаться другому процессу)
 * идущей не считается.
 */
export function liveCall(r: UsageRecord, at: number, maxMs: number) {
  if (r.outcome !== 'active' || !r.process) return false;
  if (at - Date.parse(r.startedAt) > maxMs && !activeStart(r.id) !== undefined) return false;
  return r.process.id === CURRENT_PROCESS.id ? activeStart(r.id) !== undefined : pidAlive(r.process.pid);
}
