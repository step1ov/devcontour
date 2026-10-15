import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config, Run, Task } from '../core/model.ts';
import type { DependencySnapshot } from '../core/integrations.ts';
import { dependencyOrder, repository } from '../core/repositories.ts';
import { git } from './process.ts';
import { executionEnvironment, runSteps } from './environment.ts';

export { dependencyOrder };
export async function artifactDigest(root: string, path: string) {
  const full = await realpath(join(root, path));
  if (!full.startsWith((await realpath(root)) + sep))
    throw new Error('Artifact выходит из компонента');
  return createHash('sha256')
    .update(await readFile(full))
    .digest('hex');
}
/**
 * Снимок зависимостей компонента задачи в топологическом порядке.
 *
 * `overrides` подставляет зависимость уже существующим деревом (проверка
 * потребителя: компонент задачи — её интегрированный результат). Подстановка
 * идёт до сборки: промежуточные зависимости собираются уже против неё, а не
 * против прежней версии. Каждое созданное здесь рабочее дерево принадлежит
 * снимку с момента создания: при отказе на любом шаге созданные деревья
 * убираются, и отказ очистки не скрывается.
 */
export async function snapshotDependencies(
  config: Config,
  root: string,
  run: Run,
  task: Task,
  tasks: Task[],
  signal: AbortSignal,
  overrides: Map<string, { path: string; sha: string }> = new Map(),
) {
  const ids = dependencyOrder(config, repository(config, task.repositoryId).dependsOn ?? []);
  const snapshots: DependencySnapshot[] = [];
  const created: DependencySnapshot[] = [];
  const dir = join(root, 'dependencies', run.id);
  await mkdir(dir, { recursive: true });
  try {
    for (const id of ids) {
      signal.throwIfAborted();
      const repo = repository(config, id);
      const override = overrides.get(id);
      if (override) {
        snapshots.push({
          repositoryId: id,
          sha: override.sha,
          tree: await git(override.path, 'rev-parse', 'HEAD^{tree}'),
          path: override.path,
          artifacts: [],
        });
        continue;
      }
      const sha = await git(repo.path, 'rev-parse', `refs/heads/${repo.targetBranch}`);
      for (const predecessor of tasks.filter(
        (t) => task.dependsOn.includes(t.id) && t.repositoryId === id,
      )) {
        if (!predecessor.resultSha) throw new Error('Зависимая задача не имеет принятого SHA');
        await git(repo.path, 'merge-base', '--is-ancestor', predecessor.resultSha, sha);
      }
      const path = join(dir, id);
      await git(repo.path, 'worktree', 'add', '--detach', path, sha);
      const snapshot = {
        repositoryId: id,
        sha,
        tree: await git(path, 'rev-parse', 'HEAD^{tree}'),
        path,
        artifacts: [],
      };
      created.push(snapshot);
      snapshots.push(snapshot);
    }
    const paths = Object.fromEntries(snapshots.map((s) => [s.repositoryId, s.path]));
    for (const snapshot of snapshots) {
      const repo = repository(config, snapshot.repositoryId);
      const execution = executionEnvironment([config.environment, repo.environment], {
        DEVCONTOUR_RUN_ID: run.id,
        DEVCONTOUR_COMPONENTS_JSON: JSON.stringify(paths),
      });
      await runSteps(
        repo.dependencyBuild ?? [],
        snapshot.path,
        join(root, 'artifacts', run.id, 'dependency-build', repo.id),
        execution,
        signal,
      );
      for (const path of repo.dependencyArtifacts ?? [])
        snapshot.artifacts.push({ path, digest: await artifactDigest(snapshot.path, path) });
    }
    await assertDependencies(snapshots);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(snapshots, null, 2));
    return snapshots;
  } catch (error) {
    const failures = await removeSnapshots(config, created);
    if (failures.length)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; не удалось убрать снимки: ${failures.join('; ')}`,
        { cause: error },
      );
    throw error;
  }
}
/** Убирает рабочие деревья снимков; возвращает отказы, а не скрывает их. */
export async function removeSnapshots(config: Config, snapshots: DependencySnapshot[]) {
  const failures: string[] = [];
  for (const snapshot of snapshots)
    await git(
      repository(config, snapshot.repositoryId).path,
      'worktree',
      'remove',
      '--force',
      snapshot.path,
    ).catch((e: unknown) =>
      failures.push(`${snapshot.repositoryId}: ${e instanceof Error ? e.message : String(e)}`),
    );
  return failures;
}
export async function assertDependencies(snapshots: DependencySnapshot[]) {
  for (const snapshot of snapshots) {
    if (
      (await git(snapshot.path, 'rev-parse', 'HEAD')) !== snapshot.sha ||
      (await git(snapshot.path, 'status', '--porcelain', '--untracked-files=no'))
    )
      throw new Error('Изменён закреплённый dependency snapshot: ' + snapshot.repositoryId);
    for (const artifact of snapshot.artifacts)
      if ((await artifactDigest(snapshot.path, artifact.path)) !== artifact.digest)
        throw new Error(
          'Изменён artifact зависимости: ' + snapshot.repositoryId + '/' + artifact.path,
        );
  }
}
/**
 * Свежесть снимка зависимостей на момент завершения: голова целевой ветки
 * каждой зависимости и совпадает ли она со снимком. Параллельная работа
 * законно двигает ветки зависимостей, поэтому сдвиг не отклоняет результат, а
 * фиксируется в попытке и квитанции; сочетание версий проверяет совместная
 * проверка workspace по закреплённому манифесту.
 */
export async function dependencyFreshness(snapshots: DependencySnapshot[], config: Config) {
  const result: { repositoryId: string; snapshot: string; head: string; fresh: boolean }[] = [];
  for (const snapshot of snapshots) {
    const repo = repository(config, snapshot.repositoryId);
    const head = await git(repo.path, 'rev-parse', `refs/heads/${repo.targetBranch}`);
    result.push({
      repositoryId: repo.id,
      snapshot: snapshot.sha,
      head,
      fresh: head === snapshot.sha,
    });
  }
  return result;
}
export function runEnvironment(config: Config, run: Run, phase: string, cwd: string) {
  const repo = repository(config, run.repositoryId ?? 'main');
  return executionEnvironment([config.environment, repo.environment], {
    DEVCONTOUR_REPOSITORY_ID: repo.id,
    DEVCONTOUR_RUN_ID: run.id,
    DEVCONTOUR_TASK_ID: run.taskId,
    DEVCONTOUR_PHASE: phase,
    DEVCONTOUR_RESOURCES_JSON: JSON.stringify(run.resources ?? []),
    DEVCONTOUR_DEPENDENCIES_JSON: JSON.stringify(run.dependencies ?? []),
    DEVCONTOUR_COMPONENTS_JSON: JSON.stringify({
      ...Object.fromEntries((run.dependencies ?? []).map((s) => [s.repositoryId, s.path])),
      [repo.id]: cwd,
    }),
  });
}
