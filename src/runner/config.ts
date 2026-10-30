import { selectedWorkspaceMode, assertControllerCheckout } from './workspace-mode.ts';
import { validateWorkflow } from '../core/workflow.ts';
import { readFileSync, realpathSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, dirname, join, sep } from 'node:path';
import { repositories } from '../core/repositories.ts';
import { packKey, resolveProfile } from './packs.ts';
import { checkoutRootFor } from './checkout-root.ts';
import { configSchema, type Config } from '../core/model.ts';
import {
  bytesDigest,
  configSources,
  loadedDigest,
  type ConfigSourceFile,
} from '../core/service.ts';
import { configuredSpellings } from '../core/check-store.ts';
/**
 * Загрузить конфигурацию. `text` — содержимое `config.json`, если его уже
 * прочли (или только собираются записать): так digest считается по тому
 * тексту, который проверили, а не по повторному чтению файла.
 */
export function loadConfig(path: string, text = readFileSync(path, 'utf8')): Config {
  const raw = JSON.parse(text);
  // Хэш ровно тех байтов, что разобраны: главного файла и component config.
  const sources: ConfigSourceFile[] = [
    { path: resolve(path), real: realpathSync(path), sha: bytesDigest(text) },
  ];
  if (raw.repositories?.length) {
    raw.repositories = raw.repositories.map((r: any) => readComponentConfig(r, sources));
    // Верхнеуровневые gates и protectedPaths при списке репозиториев —
    // производная копия первого компонента: исполнение берёт их из
    // компонента (`repositories(c)`). Копия, сохранённая в config.json,
    // устаревала после правки файла компонента, и панель с doctor показывали
    // список, по которому контур уже не работал. Действует то, что объявил
    // компонент.
    // Схема требует верхнеуровневые gates; действующее значение ставится ниже.
    raw.gates ??= raw.repositories[0].gates;
  }
  const c = configSchema.parse(raw);
  // Оба значения — после разбора: у компонента без своего списка
  // protectedPaths действует умолчание схемы компонента, а не прежняя копия.
  if (c.repositories.length) {
    c.gates = c.repositories[0].gates;
    c.protectedPaths = c.repositories[0].protectedPaths;
  }
  // Исходные написания нужны очистке диагностики до того, как их заменит realpath.
  configuredSpellings.set(
    c,
    [c.repository, c.workspaceRoot, ...c.repositories.map((r) => r.path)]
      .filter((x): x is string => !!x)
      .map((x) => resolve(x)),
  );
  // Заданные каталоги (корень, workspace, компоненты) и куда они ведут: их
  // переключённый symlink — другой источник, даже если config.json цел.
  for (const dir of configuredSpellings.get(c) ?? [])
    sources.push({ path: dir, real: realpathSync(dir), sha: '', dir: true });
  c.repository = realpathSync(resolve(c.repository));
  for (const repo of c.repositories) repo.path = realpathSync(resolve(repo.path));
  if (c.workspaceRoot) c.workspaceRoot = realpathSync(resolve(c.workspaceRoot));
  if (
    new Set(c.repositories.map((r) => r.id)).size !== c.repositories.length ||
    new Set(c.repositories.map((r) => r.path)).size !== c.repositories.length
  )
    throw new Error('IDs и пути репозиториев должны быть уникальны');
  if (c.workspaceRoot) {
    const selected = selectedWorkspaceMode(c.workspaceRoot);
    if (selected && selected !== (c.workspaceMode ?? 'separate'))
      throw new Error('Режим конфигурации не соответствует выбранному workspace');
    if (selected) assertControllerCheckout(c.workspaceRoot);
  }
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
  // Ревьюер того же вендора (runtime DevContour — вендор), что исполнитель, —
  // только явным правилом вендора роли или review.code.vendor.
  if (
    c.mode !== 'demo' &&
    Object.values(c.roles).some(
      (r) =>
        r.runtime === (r.reviewer ?? c.reviewer).runtime &&
        (r.reviewVendor ?? c.review?.code?.vendor) !== 'same-vendor-allowed',
    )
  )
    throw new Error(
      'Для каждого исполнителя выберите ревьюера другого вендора или явно разрешите review.code.vendor: same-vendor-allowed',
    );
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
    if (new Set(c.packs.map(packKey)).size !== c.packs.length)
      throw new Error('Повтор установленного профиля');
    for (const pack of c.packs) {
      const owner = pack.source
        ? repositories(c).find((r) => r.id === pack.source!.repositoryId)
        : undefined;
      if (pack.source && !owner) throw new Error('Неизвестный владелец профиля');
      const actual = resolveProfile(
        pack.source ? './' + pack.source.path : pack.id,
        owner?.path,
        owner?.id,
      );
      const matches =
        lock.packs?.filter((p: Config['packs'][number]) => packKey(p) === packKey(pack)) ?? [];
      const pinned = matches[0];
      const changedAtSameVersion =
        JSON.stringify(actual.capabilities) !== JSON.stringify(pack.capabilities) ||
        pinned?.digest !== actual.digest;
      // Lock и файл профиля называют один профиль: дальше отказ может сказать,
      // что делать. Только поднятая версия разрешает workspace-init переписать lock.
      if (matches.length === 1 && actual.id === pack.id && pinned.version === pack.version) {
        if (actual.version !== pack.version)
          throw new Error(
            `Профиль изменился после установки: ${pack.id}, версия ${pack.version} → ${actual.version}; примените обновление командой workspace-init`,
          );
        if (changedAtSameVersion)
          throw new Error(
            `Профиль изменился после установки: ${pack.id}, версия ${pack.version} прежняя; поднимите version этого профиля (правка вложенного не считается) и выполните workspace-init`,
          );
      } else
        throw new Error(
          'Профиль изменился после установки: ' + pack.id + '; проверьте обновление и lock-файл',
        );
    }
  }
  if (c.resourceDatabase && !isAbsolute(c.resourceDatabase))
    throw new Error('resourceDatabase требует абсолютный путь');
  if (c.checkoutRoot && !isAbsolute(c.checkoutRoot))
    throw new Error('checkoutRoot требует абсолютный путь');
  // Корень, который harness отклонит, — отказ загрузки с понятной причиной,
  // а не сбой первого запуска очереди.
  if (c.checkoutRoot) checkoutRootFor(c, dirname(resolve(path)), false);
  validateWorkflow(c);
  // Источник для проверки поколения: процесс, прочитавший эти байты, позже
  // узнаёт, лежат ли в файлах они же.
  configSources.set(c, { files: sources, digest: loadedDigest(c) });
  return c;
}

export function readComponentConfig(entry: any, sources?: ConfigSourceFile[]) {
  if (!entry.configFile) return entry;
  const declared = { path: String(entry.path), file: String(entry.configFile) };
  const root = realpathSync(resolve(declared.path));
  const path = realpathSync(resolve(root, declared.file));
  if (!path.startsWith(root + sep))
    throw new Error('Component config должен находиться в репозитории');
  const text = readFileSync(path, 'utf8');
  sources?.push({
    path: resolve(declared.path, declared.file),
    real: path,
    sha: bytesDigest(text),
  });
  const file = JSON.parse(text) as {
    roles?: Record<string, unknown>;
  };
  // Роли складываются по ключам, а не заменяются целиком: компонент уточняет
  // привязку своей роли, но роли, пришедшие из его профиля, при перезагрузке
  // конфигурации обязаны остаться — иначе mobile и qa-mobile исчезали у
  // компонента, который их и объявил.
  const roles = entry.roles || file.roles ? { ...entry.roles, ...file.roles } : undefined;
  return {
    ...entry,
    ...file,
    ...(roles ? { roles } : {}),
    id: entry.id,
    path: entry.path,
    dependsOn: entry.dependsOn,
    configFile: entry.configFile,
  };
}
export function scopedConfig(config: Config) {
  if (config.storage !== 'component' && config.workspaceMode !== 'embedded') return config;
  const refs = repositories(config).map((repo) => {
    const { id, path, dependsOn, configFile, ...settings } = repo;
    const file = configFile ?? 'devcontour.component.json';
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
