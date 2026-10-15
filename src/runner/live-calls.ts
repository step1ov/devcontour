import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { registerProcess } from '../core/live-calls.ts';
import { registerMonotonic, type UsageRecord } from '../core/usage.ts';
import { processAlive } from './resources.ts';

/** Момент старта процесса по данным ОС, мс; `undefined` — узнать нельзя. */
export function processStartedAt(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    const at = Date.parse(out);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Этот процесс: по нему восстановление и бюджет отличают свои идущие вызовы.
 * Момент старта отличает процесс от другого, получившего тот же pid.
 */
export const CURRENT_PROCESS: { id: string; pid: number; startedAt?: number } = {
  id: randomUUID(),
  pid: process.pid,
  startedAt: processStartedAt(process.pid),
};

/** Тот же ли это процесс: pid существует и момент старта совпадает. */
const sameProcess = (owner: { pid: number; startedAt?: number }) => {
  if (owner.startedAt === undefined || !processAlive(owner.pid)) return false;
  // Оба момента — из одного источника (ОС) с одним округлением: у того же
  // процесса они равны, любое расхождение — другой процесс.
  return processStartedAt(owner.pid) === owner.startedAt;
};
registerProcess(CURRENT_PROCESS, sameProcess);
registerMonotonic(() => process.hrtime.bigint());

/**
 * Владелец записи точно не ведёт вызов: процесса нет, или pid достался
 * другому процессу (наш pid у чужой записи, другой момент старта). Владелец,
 * которого нельзя ни подтвердить, ни опровергнуть, ушедшим не считается:
 * восстановление не закрывает, возможно, идущий вызов.
 */
export function ownerGone(r: UsageRecord) {
  if (!r.process || r.process.id === CURRENT_PROCESS.id) return false;
  if (r.process.pid === process.pid || !processAlive(r.process.pid)) return true;
  if (r.process.startedAt === undefined) return false;
  const started = processStartedAt(r.process.pid);
  return started !== undefined && started !== r.process.startedAt;
}
