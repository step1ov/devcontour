import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../core/model.ts';
import { DevContour } from '../core/service.ts';
import { Store } from '../core/store.ts';
import { repository } from '../core/repositories.ts';
import { git } from './process.ts';

/**
 * Восстановление backup в независимый каталог с проверкой.
 *
 * Действующий workspace не затрагивается. Восстановленная база хранит всю
 * историю, но не владение: попытки, активные в момент копии, помечаются
 * истёкшими — их процессы остались на прежней машине, и считать их
 * работающими значило бы ждать то, что не придёт. Принятые результаты
 * сверяются с Git: backup базы не содержит коммитов, и отсутствующий SHA
 * называется явно, а не обнаруживается при следующей интеграции.
 */
export async function restoreBackup(from: string, dir: string, config: Config) {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw new Error(`Каталог восстановления не пуст: ${dir}`);
  const path = join(dir, 'state.sqlite');
  await copyFile(from, path);
  const store = new Store(path);
  try {
    const h = new DevContour(store, config);
    // История считается до снятия владения: оно само становится событием.
    const events = store.eventCount();
    const released = h.expire(Number.MAX_SAFE_INTEGER);
    const state = store.read();
    const missing: { taskId: string; repositoryId: string; sha: string }[] = [];
    for (const t of state.tasks) {
      if (t.status !== 'done' || !t.resultSha) continue;
      const repositoryId = t.repositoryId ?? 'main';
      const repo = repository(config, repositoryId);
      try {
        await git(repo.path, 'cat-file', '-e', `${t.resultSha}^{commit}`);
      } catch {
        missing.push({ taskId: t.id, repositoryId, sha: t.resultSha });
      }
    }
    return {
      path,
      events,
      tasks: state.tasks.length,
      runs: state.runs.length,
      releasedOwnership: released,
      missingResults: missing,
      ready: missing.length === 0,
    };
  } finally {
    store.close();
  }
}
