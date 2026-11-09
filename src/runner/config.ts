import { selectedWorkspaceMode, assertControllerCheckout } from './workspace-mode.ts';
import { validateWorkflow } from '../core/workflow.ts';
import { readFileSync, realpathSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, dirname, join, sep } from 'node:path';
import { repositories } from '../core/repositories.ts';
import { packKey, resolveProfile } from './packs.ts';
import { checkoutRootFor } from './checkout-root.ts';
import { configSchema, repositorySchema, type Config } from '../core/model.ts';
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
  let ignoredCopies: IgnoredComponentCopy[] = [];
  // Хэш ровно тех байтов, что разобраны: главного файла и component config.
  const sources: ConfigSourceFile[] = [
    { path: resolve(path), real: realpathSync(path), sha: bytesDigest(text) },
  ];
  if (raw.repositories?.length) {
    const ignored: IgnoredComponentCopy[] = [];
    raw.repositories = raw.repositories.map((r: any) =>
      readComponentConfig(r, sources, false, ignored),
    );
    ignoredCopies = ignored;
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
  if (ignoredCopies.length) ignoredComponentCopies.set(c, ignoredCopies);
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
  for (const gates of gateSets) checkGateSet(gates);
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
            `Профиль изменился после установки: ${pack.id}, версия ${pack.version} → ${actual.version}; примените обновление командой workspace-init --file <реестр workspace.json>; после setup реестр создаётся вручную`,
          );
        if (changedAtSameVersion)
          throw new Error(
            `Профиль изменился после установки: ${pack.id}, версия ${pack.version} прежняя; поднимите version этого профиля (правка вложенного не считается) и выполните workspace-init --file <реестр workspace.json>; после setup реестр создаётся вручную`,
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

/**
 * Поля записи репозитория, которыми владеет общая конфигурация, а не файл
 * компонента: топология (`id`, `path`, `dependsOn`, `configFile`) и роли,
 * пришедшие из профиля компонента (они складываются с ролями файла).
 */
export const registryOwnedKeys = ['id', 'path', 'dependsOn', 'configFile', 'roles'] as const;
const registryOwned = new Set<string>(registryOwnedKeys);
/** Поле компонента, копия которого в config.json не применяется: действует файл. */
export type IgnoredComponentCopy = { repositoryId: string; file: string; keys: string[] };
/** Расхождения копий, проигнорированных при загрузке: их называет doctor. */
export const ignoredComponentCopies = new WeakMap<Config, IgnoredComponentCopy[]>();
/** Запись репозитория для config.json: при `configFile` — только поля общей записи. */
export function componentRef<T extends { configFile?: string }>(repo: T): Partial<T> {
  if (!repo.configFile) return repo;
  return Object.fromEntries(
    Object.entries(repo).filter(([k, v]) => registryOwned.has(k) && v !== undefined),
  ) as Partial<T>;
}
/** Есть ли в записи config.json копии полей, которыми владеет файл компонента. */
export const hasComponentCopies = (entry: Record<string, unknown>) =>
  !!entry.configFile && Object.keys(entry).some((k) => !registryOwned.has(k));
/**
 * Запись репозитория вместе с его файлом компонента.
 *
 * `inherit` — объявление реестра (`workspace.json`): файл уточняет то, что
 * объявил реестр, а недостающее берётся из реестра. Для рабочей
 * `config.json` (`inherit` = false) поля компонента берутся только из файла:
 * прежняя версия записывала в общую запись полную копию компонента, и поле,
 * удалённое из файла, продолжало действовать из устаревшей копии. Такие
 * расхождения складываются в `ignored`.
 */
export function readComponentConfig(
  entry: any,
  sources?: ConfigSourceFile[],
  inherit = true,
  ignored?: IgnoredComponentCopy[],
) {
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
  const file = JSON.parse(text) as Record<string, unknown> & {
    roles?: Record<string, unknown>;
  };
  // Роли складываются по ключам, а не заменяются целиком: компонент уточняет
  // привязку своей роли, но роли, пришедшие из его профиля, при перезагрузке
  // конфигурации обязаны остаться — иначе mobile и qa-mobile исчезали у
  // компонента, который их и объявил.
  const roles = entry.roles || file.roles ? { ...entry.roles, ...file.roles } : undefined;
  if (!inherit && ignored) {
    // Сравнение в нормализованной форме: копия записана после разбора схемой,
    // и без этого умолчания схемы выглядели бы расхождением.
    const shape = repositorySchema.shape as Record<
      string,
      { safeParse(v: unknown): { success: boolean; data?: unknown } }
    >;
    const normalized = (k: string, v: unknown) => {
      const parsed = shape[k]?.safeParse(v);
      return JSON.stringify(parsed?.success ? parsed.data : v);
    };
    const stored = entry as Record<string, unknown>;
    const keys = Object.keys(stored)
      .filter(
        (k) =>
          !registryOwned.has(k) &&
          stored[k] !== undefined &&
          normalized(k, stored[k]) !== normalized(k, file[k]),
      )
      .sort();
    if (keys.length) ignored.push({ repositoryId: String(stored.id), file: declared.file, keys });
  }
  return {
    ...(inherit ? (entry as Record<string, unknown>) : {}),
    ...file,
    ...(roles ? { roles } : {}),
    id: entry.id,
    path: entry.path,
    dependsOn: entry.dependsOn,
    configFile: entry.configFile,
  };
}
/**
 * Уже лежащий в репозитории файл компонента — его прочитает `scopedConfig`
 * вместо записи своего. `absent` — файла нет, и setup его создаст.
 */
export function existingComponentFile(
  repositoryPath: string,
  file = 'devcontour.component.json',
):
  | { state: 'absent'; path: string }
  | { state: 'file'; path: string; content: Record<string, unknown> }
  | { state: 'invalid'; path: string; reason: string } {
  const path = resolve(repositoryPath, file);
  if (!existsSync(path) && !isSymlink(path)) return { state: 'absent', path };
  const stat = lstatSync(path);
  if (!stat.isFile()) return { state: 'invalid', path, reason: 'не обычный файл' };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { state: 'invalid', path, reason: 'ожидался JSON-объект' };
    return { state: 'file', path, content: parsed as Record<string, unknown> };
  } catch (error) {
    return { state: 'invalid', path, reason: (error as Error).message };
  }
}
const isSymlink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
function checkGateSet(gates: Config['gates']) {
  if (new Set(gates.map((g) => g.id)).size !== gates.length)
    throw new Error('Gate ids должны быть уникальны');
  if (!gates.some((g) => g.kind === 'test' && g.report)) throw new Error('Нужен test gate с JUnit');
  for (const g of gates) {
    if (g.kind === 'test' && !g.report) throw new Error('Нужен JUnit report');
    if (g.report && (isAbsolute(g.report.path) || g.report.path.split(/[\\/]/).includes('..')))
      throw new Error('Report должен быть внутри worktree');
  }
}
/**
 * Причина, по которой конфигурация с сохранённым файлом компонента не
 * загрузится: схема, проверки gates и согласованность ролей с профилями —
 * без записи файлов. `config` — объект config.json до выноса компонента.
 */
export function componentConfigProblem(
  config: { repositories?: Record<string, unknown>[] } & Record<string, unknown>,
  file: Record<string, unknown>,
): string | undefined {
  try {
    const entry = config.repositories?.[0];
    if (!entry) return undefined;
    const fileRoles = file.roles as Record<string, unknown> | undefined;
    const entryRoles = entry.roles as Record<string, unknown> | undefined;
    const repository: Record<string, unknown> = {
      ...file,
      ...(entryRoles || fileRoles ? { roles: { ...entryRoles, ...fileRoles } } : {}),
      id: entry.id,
      path: entry.path,
      dependsOn: entry.dependsOn,
    };
    const raw = {
      ...Object.fromEntries(
        Object.entries(config).filter(([key]) => key !== 'gates' && key !== 'protectedPaths'),
      ),
      repositories: [repository],
      gates: repository.gates,
    };
    const parsed = configSchema.safeParse(raw);
    if (!parsed.success)
      return parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    const c = parsed.data;
    c.gates = c.repositories[0].gates;
    checkGateSet(c.repositories[0].gates);
    validateWorkflow(c);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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
