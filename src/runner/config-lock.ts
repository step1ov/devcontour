import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export { loadedDigest } from '../core/service.ts';

/**
 * Исключительная блокировка записи `config.json`: её берут шаг `context`
 * операции изменения контракта и `context-lock`. Каталог создаётся атомарно;
 * блокировка умершего процесса снимается.
 */
export function withConfigLock<T>(path: string, action: () => T): T {
  const lock = path + '.lock';
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid = 0;
      try {
        pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
      } catch {
        /* Блокировку только что создали, pid ещё не записан. */
      }
      if (pid && !alive(pid)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (attempt > 50)
        throw new Error('config.json записывает другой процесс: ' + (pid || 'pid неизвестен'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid));
    return action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
