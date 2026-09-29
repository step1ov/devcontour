import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, DevContourState } from '../core/model.ts';
import { DevContour } from '../core/service.ts';
import { Store } from '../core/store.ts';
import { repository, repositories } from '../core/repositories.ts';
import type { WorkflowJob } from '../core/lead-workflow.ts';
import { git } from './process.ts';

const interrupted =
  'Прервано восстановлением backup: процесс-владелец остался на прежней установке';

/**
 * Снять всё оперативное владение восстановленной копии. Раньше снимались
 * только попытки задач: выкладка preview с её блокировкой, совместная
 * проверка, поставка, лидер контроллера и работы ведущего цикла переживали
 * восстановление со старыми токенами, а отчёт называл копию готовой. История
 * сохраняется: владение заканчивается записью с причиной, а не стирается.
 */
function releaseOwnership(h: DevContour, store: Store) {
  const runs = h.expire(Number.MAX_SAFE_INTEGER);
  const released = store.change('backup.ownership-released', (s: DevContourState) => {
    const at = new Date().toISOString();
    const previews: string[] = [];
    for (const p of s.previews ?? [])
      if (p.active) {
        p.active = false;
        p.status = 'failed';
        p.failure = 'lease';
        p.error = interrupted;
        p.finishedAt = at;
        p.leaseUntil = 0;
        previews.push(p.id);
      }
    const previewLock = s.previewLock ? s.previewLock.kind : null;
    s.previewLock = undefined;
    const verifications: string[] = [];
    const deliveries: string[] = [];
    for (const c of s.changeSets) {
      for (const v of c.verifications)
        if (v.status === 'active') {
          v.status = 'failed';
          v.finishedAt = at;
          v.leaseUntil = 0;
          verifications.push(v.id);
        }
      for (const d of c.deliveries ?? [])
        if (d.status === 'active') {
          d.status = 'failed';
          d.error = interrupted;
          d.finishedAt = at;
          d.leaseUntil = 0;
          deliveries.push(d.id);
        }
    }
    const leader = s.leader?.owner ?? null;
    s.leader = undefined;
    return { previews, previewLock, verifications, deliveries, leader };
  });
  // Работы ведущего цикла хранятся локально, по владельцу-компоненту.
  const workflows = store.atomic(() => {
    const keys: string[] = [];
    const owners = [undefined, ...repositories(h.config).map((r) => r.id)];
    const seen = new Set<string>();
    for (const owner of owners) {
      const jobs = store.localRecords<WorkflowJob>('lead', owner);
      for (const [key, job] of Object.entries(jobs)) {
        if (job.status !== 'running' || seen.has(key)) continue;
        seen.add(key);
        job.status = 'queued';
        job.error = interrupted;
        job.token = undefined;
        job.leaseUntil = undefined;
        job.history.push({ at: new Date().toISOString(), stage: job.stage, event: 'released' });
        store.saveLocal('lead', owner, key, job);
        keys.push(key);
      }
    }
    return keys;
  });
  return { runs, ...released, workflows };
}

/** Что ещё считается действующим владением — после снятия должно быть пусто. */
function activeOwnership(s: DevContourState) {
  return [
    ...s.runs.filter((r) => r.status === 'active').map((r) => `run:${r.id}`),
    ...(s.previews ?? []).filter((p) => p.active).map((p) => `preview:${p.id}`),
    ...(s.previewLock ? ['previewLock'] : []),
    ...s.changeSets.flatMap((c) => [
      ...c.verifications.filter((v) => v.status === 'active').map((v) => `verification:${v.id}`),
      ...(c.deliveries ?? []).filter((d) => d.status === 'active').map((d) => `delivery:${d.id}`),
    ]),
    ...(s.leader ? ['leader'] : []),
  ];
}

/**
 * Восстановление backup в независимый каталог с проверкой.
 *
 * Действующий workspace не затрагивается. Восстановленная база хранит всю
 * историю, но не владение: всё, что было активным в момент копии, завершается
 * с причиной — процессы остались на прежней машине, и считать их работающими
 * значило бы ждать то, что не придёт. Принятые результаты сверяются с Git:
 * backup базы не содержит коммитов, и отсутствующий SHA называется явно, а не
 * обнаруживается при следующей интеграции. Доступность результатов в Git и
 * операционная готовность копии названы в отчёте отдельно.
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
    const released = releaseOwnership(h, store);
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
    const remaining = activeOwnership(state);
    return {
      path,
      events,
      tasks: state.tasks.length,
      runs: state.runs.length,
      releasedOwnership: released,
      remainingOwnership: remaining,
      missingResults: missing,
      resultsAvailable: missing.length === 0,
      ready: missing.length === 0 && remaining.length === 0,
    };
  } finally {
    store.close();
  }
}
