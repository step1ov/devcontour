import { selectedWorkspaceMode, assertControllerCheckout } from './workspace-mode.ts';
import { mkdir, readFile, writeFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { configSchema, repositorySchema } from '../core/model.ts';
import { profile, packKey, profileMetadata } from './packs.ts';
import { projectConfig, profileLock } from './setup.ts';
import { loadConfig, readComponentConfig, scopedConfig } from './config.ts';
import { reserveRepositories } from './ownership.ts';

const registrySchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  approvalMode: configSchema.shape.approvalMode,
  repositories: z
    .array(
      repositorySchema.omit({ gates: true, protectedPaths: true }).extend({
        profile: z.string(),
        gates: repositorySchema.shape.gates.optional(),
        protectedPaths: repositorySchema.shape.protectedPaths.optional(),
      }),
    )
    .min(1),
  workspaceGates: configSchema.shape.workspaceGates,
  contextPacks: configSchema.shape.contextPacks,
  resources: configSchema.shape.resources,
  resourceDatabase: configSchema.shape.resourceDatabase,
  verificationMode: configSchema.shape.verificationMode,
  environment: configSchema.shape.environment,
  workspaceLifecycle: configSchema.shape.workspaceLifecycle,
  toolProfiles: configSchema.shape.toolProfiles,
  completionMode: configSchema.shape.completionMode,
  forgeConnections: configSchema.shape.forgeConnections,
});
export async function setupWorkspace(file: string, data?: string) {
  const source = await realpath(resolve(file));
  const workspaceRoot = dirname(source);
  assertControllerCheckout(workspaceRoot);
  const workspaceMode = selectedWorkspaceMode(workspaceRoot) ?? 'separate';
  const raw = JSON.parse(await readFile(source, 'utf8'));
  raw.repositories = raw.repositories.map((r: any) =>
    readComponentConfig({ ...r, path: resolve(workspaceRoot, r.path) }),
  );
  const input = registrySchema.parse(raw);
  const root = resolve(data ?? join(workspaceRoot, '.devcontour-local'));
  const selected = await Promise.all(
    input.repositories.map((r) => profile(r.profile, r.path, r.id)),
  );
  const repos = await Promise.all(
    input.repositories.map(async (r, i) => ({
      id: r.id,
      configFile: r.configFile,
      roles: r.roles,
      reviewer: r.reviewer,
      name: r.name,
      kind: r.kind,
      dependsOn: r.dependsOn,
      generatedPaths: [...new Set([...selected[i].generatedPaths, ...(r.generatedPaths ?? [])])],
      environment: r.environment ?? selected[i].environment,
      lifecycle: r.lifecycle ?? selected[i].lifecycle,
      prepare: r.prepare ?? selected[i].prepare,
      dependencyBuild: r.dependencyBuild,
      dependencyArtifacts: r.dependencyArtifacts,
      preflight: r.preflight,
      forge: r.forge,
      path: await realpath(resolve(workspaceRoot, r.path)),
      targetBranch: r.targetBranch,
      gates: r.gates ?? selected[i].gates,
      protectedPaths: [
        ...new Set([
          ...(r.protectedPaths ?? projectConfig('.', selected[i]).protectedPaths),
          ...selected[i].protectedPaths,
        ]),
      ],
    })),
  );
  if (
    workspaceMode === 'embedded'
      ? repos.length !== 1 || repos[0].path !== workspaceRoot
      : repos.some((r) => workspaceRoot === r.path || workspaceRoot.startsWith(r.path + sep))
  )
    throw new Error(
      'Embedded требует один репозиторий в корне workspace; separate — workspace вне компонентов',
    );
  if (
    new Set(repos.map((r) => r.id)).size !== repos.length ||
    new Set(repos.map((r) => r.path)).size !== repos.length
  )
    throw new Error('IDs и пути репозиториев должны быть уникальны');
  const packs = [...new Map(selected.map((p) => [packKey(p), p])).values()];
  const config = configSchema.parse({
    ...projectConfig(repos[0].path, selected[0], input.approvalMode),
    name: input.name,
    workspaceRoot,
    workspaceMode,
    targetBranch: repos[0].targetBranch,
    concurrency: Math.min(...selected.map((p) => p.concurrency ?? 2)),
    repositories: repos,
    workspaceGates: input.workspaceGates,
    contextPacks: input.contextPacks,
    resources: input.resources,
    resourceDatabase: input.resourceDatabase,
    verificationMode: input.verificationMode,
    environment: input.environment,
    lifecycle: undefined,
    prepare: undefined,
    generatedPaths: [],
    workspaceLifecycle: input.workspaceLifecycle,
    toolProfiles: input.toolProfiles,
    completionMode: input.completionMode,
    forgeConnections: input.forgeConnections,
    storage: workspaceMode === 'embedded' ? 'central' : 'component',
    gates: repos[0].gates,
    packs: packs.map(profileMetadata),
  });
  const configPath = join(root, 'config.json');
  try {
    await readFile(configPath);
    const existing = loadConfig(configPath);
    if (
      existing.workspaceRoot !== workspaceRoot ||
      JSON.stringify(existing.packs) !== JSON.stringify(config.packs) ||
      JSON.stringify(existing.repositories.map(({ id, path }) => ({ id, path }))) !==
        JSON.stringify(repos.map(({ id, path }) => ({ id, path })))
    )
      throw new Error('Существующая конфигурация относится к другому workspace или профилю');
    await reserveRepositories(existing, root);
    // The workspace and its repositories are the same, so joint gates may still
    // be declared after the fact. A product configured by `setup` starts without
    // them, and without this there is no route to add one: a release feature
    // check requires a workspace test gate, which could then never exist.
    if (JSON.stringify(existing.workspaceGates) !== JSON.stringify(config.workspaceGates)) {
      await writeFile(
        configPath,
        JSON.stringify({ ...existing, workspaceGates: config.workspaceGates }, null, 2),
      );
      return { status: 'gates-updated', data: root, config: configPath };
    }
    return { status: 'preserved', data: root, config: configPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(root, { recursive: true });
  const lock = { version: 1, packs: packs.flatMap((p) => profileLock(p).packs) };
  const previewRoot = await mkdtemp(join(root, '.setup-'));
  try {
    const preview = join(previewRoot, 'config.json');
    await writeFile(join(previewRoot, 'packs.lock.json'), JSON.stringify(lock));
    await writeFile(preview, JSON.stringify(config));
    const validated = loadConfig(preview);
    const lockPath = join(root, 'packs.lock.json');
    try {
      if (JSON.stringify(JSON.parse(await readFile(lockPath, 'utf8'))) !== JSON.stringify(lock))
        throw new Error('Существующий lock-файл отличается; нужна явная сверка');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await reserveRepositories(validated, root);
    try {
      await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await writeFile(configPath, JSON.stringify(scopedConfig(validated), null, 2) + '\n', {
      flag: 'wx',
    });
  } finally {
    await rm(previewRoot, { recursive: true, force: true });
  }
  return {
    status: 'configured',
    data: root,
    config: configPath,
    next: 'Ведущий агент проверяет команды workspaceGates, импортирует планы с repositoryId и создаёт ChangeSet.',
  };
}
