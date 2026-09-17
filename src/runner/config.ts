import { validateWorkflow } from '../core/workflow.ts';
import { readFileSync, realpathSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, dirname, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { repositories } from '../core/repositories.ts';
import { configSchema, type Config } from '../core/model.ts';
export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (raw.repositories?.length) {
    raw.repositories = raw.repositories.map((r: any) => readComponentConfig(r));
    raw.gates ??= raw.repositories[0].gates;
    raw.protectedPaths ??= raw.repositories[0].protectedPaths;
  }
  const c = configSchema.parse(raw);
  c.repository = realpathSync(resolve(c.repository));
  for (const repo of c.repositories) repo.path = realpathSync(resolve(repo.path));
  if (c.workspaceRoot) c.workspaceRoot = realpathSync(resolve(c.workspaceRoot));
  if (
    new Set(c.repositories.map((r) => r.id)).size !== c.repositories.length ||
    new Set(c.repositories.map((r) => r.path)).size !== c.repositories.length
  )
    throw new Error('IDs и пути репозиториев должны быть уникальны');
  const gateSets = [
    ...repositories(c).map((r) => r.gates),
    ...(c.workspaceGates.length ? [c.workspaceGates] : []),
  ];
  for (const gates of gateSets) {
    if (new Set(gates.map((g) => g.id)).size !== gates.length)
      throw new Error('Gate ids должны быть уникальны');
    if (!gates.some((g) => g.kind === 'test' && g.report))
      throw new Error('Нужен test gate с JUnit');
    for (const g of gates) {
      if (g.kind === 'test' && !g.report) throw new Error('Нужен JUnit report');
      if (g.report && (isAbsolute(g.report.path) || g.report.path.split(/[\\/]/).includes('..')))
        throw new Error('Report должен быть внутри worktree');
    }
  }
  for (const gate of c.workspaceGates) {
    if (!repositories(c).some((r) => r.id === gate.repositoryId))
      throw new Error('Неизвестный repositoryId проверки workspace');
    if (gate.artifacts.some((p) => isAbsolute(p) || p.split(/[\\/]/).includes('..')))
      throw new Error('Artifact должен быть внутри worktree');
  }
  if (
    c.mode !== 'demo' &&
    (Object.values(c.roles).some((r) => r.runtime === 'demo' || r.reviewer?.runtime === 'demo') ||
      c.reviewer.runtime === 'demo')
  )
    throw new Error('Demo adapter разрешён только в demo mode');
  if (
    c.mode !== 'demo' &&
    Object.values(c.roles).some((r) => r.runtime === (r.reviewer ?? c.reviewer).runtime)
  )
    throw new Error('Для каждого исполнителя выберите другой runtime ревьюера');
  if (new Set(c.gates.map((g) => g.id)).size !== c.gates.length)
    throw new Error('Gate ids должны быть уникальны');
  if (!c.gates.some((g) => g.kind === 'test' && g.report))
    throw new Error('Нужен хотя бы один test gate с JUnit report');
  for (const g of c.gates) {
    if (g.kind === 'test' && !g.report) throw new Error(`Gate ${g.id}: обязателен JUnit report`);
    if (g.report && (isAbsolute(g.report.path) || g.report.path.split(/[\\/]/).includes('..')))
      throw new Error('Report path должен быть внутри worktree');
  }
  if (c.mode === 'local' && c.packs.length) {
    const lock = JSON.parse(readFileSync(join(dirname(path), 'packs.lock.json'), 'utf8'));
    for (const pack of c.packs) {
      if (!['react-vite-admin', 'next-product', 'go-api', 'mobile-maestro'].includes(pack.id))
        throw new Error('Неизвестный установленный профиль: ' + pack.id);
      const pinned = lock.packs?.find((p: { id: string }) => p.id === pack.id);
      const raw = readFileSync(
        new URL(`../../packs/profiles/${pack.id}.json`, import.meta.url),
        'utf8',
      );
      const expected = createHash('sha256').update(raw).digest('hex');
      if (!pinned || pinned.version !== pack.version || pinned.digest !== expected)
        throw new Error(
          'Профиль изменился после установки: ' + pack.id + '; проверьте обновление и lock-файл',
        );
    }
  }
  if (c.resourceDatabase && !isAbsolute(c.resourceDatabase))
    throw new Error('resourceDatabase требует абсолютный путь');
  validateWorkflow(c);
  return c;
}

export function readComponentConfig(entry: any) {
  if (!entry.configFile) return entry;
  const root = realpathSync(resolve(entry.path));
  const path = realpathSync(resolve(root, entry.configFile));
  if (!path.startsWith(root + sep))
    throw new Error('Component config должен находиться в репозитории');
  return {
    ...entry,
    ...JSON.parse(readFileSync(path, 'utf8')),
    id: entry.id,
    path: entry.path,
    dependsOn: entry.dependsOn,
    configFile: entry.configFile,
  };
}
export function scopedConfig(config: Config) {
  if (config.storage !== 'component') return config;
  const refs = repositories(config).map((repo) => {
    const { id, path, dependsOn, configFile, ...settings } = repo;
    const file = configFile ?? 'harness.component.json';
    const destination = resolve(path, file);
    if (
      !destination.startsWith(realpathSync(path) + sep) ||
      (existsSync(destination) && lstatSync(destination).isSymbolicLink())
    )
      throw new Error('Некорректный component config');
    const local = {
      ...settings,
      roles: repo.roles ?? config.roles,
      reviewer: repo.reviewer ?? config.reviewer,
    };
    if (!existsSync(destination))
      writeFileSync(destination, JSON.stringify(local, null, 2) + '\n', { flag: 'wx' });
    return { id, path, dependsOn, configFile: file };
  });
  const result: any = { ...config, repositories: refs };
  delete result.gates;
  delete result.protectedPaths;
  return result;
}
