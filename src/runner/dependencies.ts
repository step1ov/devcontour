import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config, Run, Task } from '../core/model.ts';
import type { DependencySnapshot } from '../core/integrations.ts';
import { repository } from '../core/repositories.ts';
import { git } from './process.ts';
import { executionEnvironment, runSteps } from './environment.ts';

export function dependencyOrder(config: Config, ids: string[]) {
  const ordered: string[] = [],
    active = new Set<string>();
  const visit = (id: string) => {
    if (ordered.includes(id)) return;
    if (active.has(id)) throw new Error('Цикл зависимостей компонентов');
    active.add(id);
    for (const parent of repository(config, id).dependsOn ?? []) visit(parent);
    active.delete(id);
    ordered.push(id);
  };
  ids.forEach(visit);
  return ordered;
}
export async function artifactDigest(root: string, path: string) {
  const full = await realpath(join(root, path));
  if (!full.startsWith((await realpath(root)) + sep))
    throw new Error('Artifact выходит из компонента');
  return createHash('sha256')
    .update(await readFile(full))
    .digest('hex');
}
export async function snapshotDependencies(
  config: Config,
  root: string,
  run: Run,
  task: Task,
  tasks: Task[],
  signal: AbortSignal,
) {
  const ids = dependencyOrder(config, repository(config, task.repositoryId).dependsOn ?? []);
  const snapshots: DependencySnapshot[] = [];
  const dir = join(root, 'dependencies', run.id);
  await mkdir(dir, { recursive: true });
  for (const id of ids) {
    signal.throwIfAborted();
    const repo = repository(config, id);
    const sha = await git(repo.path, 'rev-parse', `refs/heads/${repo.targetBranch}`);
    for (const predecessor of tasks.filter(
      (t) => task.dependsOn.includes(t.id) && t.repositoryId === id,
    )) {
      if (!predecessor.resultSha) throw new Error('Зависимая задача не имеет принятого SHA');
      await git(repo.path, 'merge-base', '--is-ancestor', predecessor.resultSha, sha);
    }
    const path = join(dir, id);
    await git(repo.path, 'worktree', 'add', '--detach', path, sha);
    snapshots.push({
      repositoryId: id,
      sha,
      tree: await git(path, 'rev-parse', 'HEAD^{tree}'),
      path,
      artifacts: [],
    });
  }
  const paths = Object.fromEntries(snapshots.map((s) => [s.repositoryId, s.path]));
  for (const snapshot of snapshots) {
    const repo = repository(config, snapshot.repositoryId);
    const execution = executionEnvironment([config.environment, repo.environment], {
      HARNESS_RUN_ID: run.id,
      HARNESS_COMPONENTS_JSON: JSON.stringify(paths),
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
}
export async function assertDependencies(snapshots: DependencySnapshot[], config?: Config) {
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
    if (config) {
      const repo = repository(config, snapshot.repositoryId);
      if ((await git(repo.path, 'rev-parse', `refs/heads/${repo.targetBranch}`)) !== snapshot.sha)
        throw new Error('Версия зависимости изменилась; нужна новая попытка: ' + repo.id);
    }
  }
}
export function runEnvironment(config: Config, run: Run, phase: string, cwd: string) {
  const repo = repository(config, run.repositoryId ?? 'main');
  return executionEnvironment([config.environment, repo.environment], {
    HARNESS_REPOSITORY_ID: repo.id,
    HARNESS_RUN_ID: run.id,
    HARNESS_TASK_ID: run.taskId,
    HARNESS_PHASE: phase,
    HARNESS_RESOURCES_JSON: JSON.stringify(run.resources ?? []),
    HARNESS_DEPENDENCIES_JSON: JSON.stringify(run.dependencies ?? []),
    HARNESS_COMPONENTS_JSON: JSON.stringify({
      ...Object.fromEntries((run.dependencies ?? []).map((s) => [s.repositoryId, s.path])),
      [repo.id]: cwd,
    }),
  });
}
