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

// Роль, которой в конфигурации ещё нет, добавляется: именно этого не хватало,
// когда продукт обзаводился мобильным приложением. Уже существующая роль не
// трогается — её runtime и ревьюера выбирал оператор, и перенос объявления не
// повод отменять этот выбор.

// Реестр объявляет пакеты, но не закрепляет их: revision и digest появляются
// только при context-lock. Переносить объявление целиком значит сбрасывать
// закрепление каждый раз, когда рядом меняется что-то другое, и останавливать
// очередь на «пакет не закреплён». Неизменившийся пакет закрепление сохраняет.
const withPins = (
  existing: { id: string; version: string; files: string[] }[],
  declared: { id: string; version: string; files: string[] }[],
) => {
  const pinned = new Map(existing.map((p) => [JSON.stringify([p.id, p.files]), p]));
  return declared.map((p) => {
    const was = pinned.get(JSON.stringify([p.id, p.files]));
    return was && was.version === p.version ? { ...p, ...was } : p;
  });
};

/** Имена ролей, объявленных конфигурацией: workspace плюс каждый компонент. */
const declaredNames = (
  scope: { roles: Record<string, unknown> },
  components: { roles?: Record<string, unknown> }[],
) => [...new Set([...Object.keys(scope.roles), ...components.flatMap((r) => Object.keys(r.roles ?? {}))])];
const withDeclaredRoles = (
  existing: Record<string, unknown>,
  declared: Record<string, unknown>,
) => ({ ...declared, ...existing });
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
  const lock = { version: 1, packs: packs.flatMap((p) => profileLock(p).packs) };
  try {
    await readFile(configPath);
    let existing;
    try {
      existing = loadConfig(configPath);
    } catch (error) {
      // Профиль пинится digest, и изменить его после установки было нечем.
      // Поднятая автором версия — явное заявление «изменилось намеренно»:
      // только она разрешает переписать lock. Правка без смены версии
      // по-прежнему отклоняется, иначе пин ничего не защищает.
      const raw = JSON.parse(await readFile(configPath, 'utf8')) as {
        packs?: { id: string; version: string }[];
      };
      const sameProfiles =
        raw.packs?.length === config.packs.length &&
        raw.packs.every((p, i) => p.id === config.packs[i].id);
      const versionBumped = raw.packs?.some((p, i) => p.version !== config.packs[i].version);
      if (!/Профиль изменился/.test(String(error)) || !sameProfiles || !versionBumped) throw error;
      await writeFile(join(root, 'packs.lock.json'), JSON.stringify(lock, null, 2) + '\n');
      await writeFile(
        configPath,
        JSON.stringify(
          {
            ...raw,
            packs: config.packs,
            gates: config.gates,
            repositories: repos,
            workspaceGates: config.workspaceGates,
            contextPacks: withPins(
              (raw as { contextPacks?: { id: string; version: string; files: string[] }[] })
                .contextPacks ?? [],
              config.contextPacks,
            ),
            roles: withDeclaredRoles(
              (raw as { roles?: Record<string, unknown> }).roles ?? {},
              config.roles,
            ),
          },
          null,
          2,
        ),
      );
      await reserveRepositories(loadConfig(configPath), root);
      return { status: 'profile-updated', data: root, config: configPath };
    }
    if (
      existing.workspaceRoot !== workspaceRoot ||
      JSON.stringify(existing.packs) !== JSON.stringify(config.packs) ||
      JSON.stringify(existing.repositories.map(({ id, path }) => ({ id, path }))) !==
        JSON.stringify(repos.map(({ id, path }) => ({ id, path })))
    )
      throw new Error('Существующая конфигурация относится к другому workspace или профилю');
    await reserveRepositories(existing, root);
    const known = declaredNames(existing, existing.repositories);
    // The workspace, its repositories and the pinned profile are the same, so
    // what the registry declares about them may still change afterwards: a joint
    // release gate did not exist at setup, a component splits one suite into a
    // gate per task as work is decomposed, and a runtime turns out to need a
    // credential from the environment. Identity stays pinned; the declaration
    // follows the registry, otherwise it stays frozen at first install and there
    // is no route to any of these but a fresh workspace.
    const declarationChanged =
      JSON.stringify(existing.workspaceGates) !== JSON.stringify(config.workspaceGates) ||
      JSON.stringify(existing.gates) !== JSON.stringify(config.gates) ||
      JSON.stringify(existing.repositories.map((r) => r.gates)) !==
        JSON.stringify(repos.map((r) => r.gates)) ||
      JSON.stringify(existing.environment) !== JSON.stringify(config.environment) ||
      // Новая роль ищется по множеству имён, а не сравнением привязок: конфигурация
      // хранит их уже нормализованными, и побайтовое сравнение объявляло бы
      // изменение на каждом запуске.
      declaredNames(config, repos).some((role) => !known.includes(role)) ||
      JSON.stringify(
        existing.contextPacks.map(({ id, version, files }) => ({ id, version, files })),
      ) !==
        JSON.stringify(
          config.contextPacks.map(({ id, version, files }) => ({ id, version, files })),
        );
    if (declarationChanged) {
      const contextPacks = withPins(existing.contextPacks, config.contextPacks);
      await writeFile(
        configPath,
        JSON.stringify(
          {
            ...existing,
            workspaceGates: config.workspaceGates,
            gates: config.gates,
            repositories: repos,
            contextPacks,
            environment: config.environment,
            roles: withDeclaredRoles(existing.roles, config.roles),
          },
          null,
          2,
        ),
      );
      return { status: 'declaration-updated', data: root, config: configPath };
    }
    return { status: 'preserved', data: root, config: configPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(root, { recursive: true });
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
