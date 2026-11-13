import { selectedWorkspaceMode, assertControllerCheckout } from './workspace-mode.ts';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import {
  HarnessError,
  applyFileWrites,
  checkDestination,
  inspectPath,
  listRegularFiles,
  planFileWrites,
  type FileIntent,
  type FilePlanEntry,
} from 'devcontour-harness';
import { configSchema, gateList, roles } from '../core/model.ts';
const builtinTitles: Record<string, string> = {
  architect: 'Архитектор',
  backend: 'Разработчик бэкенда',
  frontend: 'Разработчик интерфейса',
  qa: 'Тестировщик',
};
import { repositories } from '../core/repositories.ts';
import {
  componentConfigProblem,
  existingComponentFile,
  loadConfig,
  scopedConfig,
} from './config.ts';
import { profile, profileMetadata, profilePin, packKey } from './packs.ts';
import { git } from './process.ts';
import { guideCopies } from './guides.ts';

const templateRoot = fileURLToPath(new URL('../../templates/project/', import.meta.url));
const libraryRoot = fileURLToPath(new URL('../../packs/context/', import.meta.url));
const devcontourRoot = fileURLToPath(new URL('../../', import.meta.url));
// Чему учить роль, кроме её собственной инструкции: тестировщика — проверкам,
// тех, кто делает интерфейс, — дизайну, остальных — контрактам. Правило по виду
// роли, а не по списку имён: `qa-mobile` и `qa-web` — тоже тестировщики.
// Роль, явно объявленная без контракта (`requiresContract: false`, как
// `developer` быстрого изменения), правил контрактов не получает: правила
// общих API и versioned контекста библиотек противоречили бы её инструкции, и
// ревьюер плана требовал бы по ним контракт, которого у задачи нет и быть не
// должно. Решает объявление роли, а не её имя.
const companionContext = (role: string, binding?: { requiresContract?: boolean }) =>
  binding?.requiresContract === false
    ? undefined
    : role.startsWith('qa')
      ? 'testing'
      : ['frontend', 'mobile'].includes(role)
        ? 'design'
        : 'contracts';

export function defaultContextPacks(
  repositoryId = 'main',
  declared: string[] = [...roles],
  bindings: Record<string, { requiresContract?: boolean }> = {},
) {
  const prefix = repositoryId === 'main' ? '' : repositoryId + '-';
  return [
    {
      id: prefix + 'workflow',
      version: '1.0.0',
      repositoryId,
      roles: declared,
      files: ['.agents/context/workflow.md', '.agents/context/review.md'],
    },
    ...declared.map((role) => ({
      id: prefix + role,
      version: '1.0.0',
      repositoryId,
      roles: [role],
      files: [
        `.agents/roles/${role}.md`,
        ...(companionContext(role, bindings[role])
          ? [`.agents/context/${companionContext(role, bindings[role])}.md`]
          : []),
      ],
    })),
    {
      id: prefix + 'library-contracts',
      version: '1.0.0',
      repositoryId,
      roles: [],
      files: ['.agents/context/contracts.md'],
    },
    {
      id: prefix + 'mobile-maestro',
      version: '1.0.0',
      repositoryId,
      roles: [],
      files: ['.agents/context/mobile-maestro.md'],
    },
  ];
}
type Profile = Awaited<ReturnType<typeof profile>>;

/**
 * `runTimeoutMs` сохранённой конфигурации workspace: setup её не
 * перезаписывает, поэтому действует он (без ключа — умолчание схемы). Нет
 * файла — пусто; нечитаемый файл отклонит проверка конфигурации setup.
 */
async function existingRunTimeout(path: string): Promise<{ existingMs?: number }> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const value = (raw as { runTimeoutMs?: unknown }).runTimeoutMs;
    // Файл без ключа действует с умолчанием схемы.
    return { existingMs: typeof value === 'number' ? value : DEFAULT_RUN_TIMEOUT_MS };
  } catch {
    return {};
  }
}
export type ApprovalMode = 'agent' | 'operator';

/** Нижний предел срока проверок в новой конфигурации (`gateTimeoutFloorMs`). */
export const DEFAULT_GATE_TIMEOUT_FLOOR_MS = 60_000;

/** Срок фазы попытки (`runTimeoutMs`) по умолчанию: setup не ставит меньше. */
export const DEFAULT_RUN_TIMEOUT_MS = 900_000;
/** Верхний предел срока, который setup выводит сам (предел `runTimeoutMs` профиля). */
export const MAX_DERIVED_RUN_TIMEOUT_MS = 7_200_000;
/** Срок gate без `timeoutMs` — умолчание схемы. */
const DEFAULT_GATE_TIMEOUT_MS = 120_000;

export interface RunTimeoutChoice {
  ms: number;
  /**
   * Откуда значение: сохранённая конфигурация workspace, профиль, оценка
   * фазы по проверкам или умолчание.
   */
  source: 'existing' | 'profile' | 'gates' | 'default';
  /** Сумма действующих сроков проверок (каждая не короче нижнего предела). */
  gatesMs: number;
  /**
   * Оценка фазы интеграции: шаги подготовки, все проверки по очереди и один
   * повтор самой долгой проверки. Проверки потребителей не учтены.
   */
  phaseMs: number;
  reason: string;
}

const minutes = (ms: number) => {
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} мин`;
};
const timeoutOf = (step: { timeoutMs?: unknown }, fallback: number) =>
  typeof step.timeoutMs === 'number' && step.timeoutMs > 0 ? step.timeoutMs : fallback;

/** Сумма действующих сроков gates: каждый не короче `gateTimeoutFloorMs`. */
export function gateTimeoutSum(gates: readonly { timeoutMs?: unknown }[], floorMs = 0) {
  return gates.reduce(
    (sum, g) => sum + Math.max(timeoutOf(g, DEFAULT_GATE_TIMEOUT_MS), floorMs),
    0,
  );
}

/**
 * Срок фазы попытки (`runTimeoutMs`) для конфигурации setup. Каждая фаза
 * попытки ограничена этим сроком, и самая долгая из них — интеграция: шаги
 * подготовки (prepare, запуск окружения), все gates по очереди, один повтор
 * проверки, упавшей на интеграции и прошедшей на кандидате, и проверки
 * потребителей. Длинные реальные проверки (установка зависимостей,
 * typecheck и тесты монорепозитория) не укладывались в прежние постоянные
 * 15 минут.
 *
 * Уже заданное значение сохраняется: сохранённая конфигурация workspace
 * (setup её не перезаписывает) или `runTimeoutMs` профиля. Иначе срок —
 * оценка фазы интеграции (сроки шагов подготовки, сумма сроков gates и
 * повтор самого долгого gate; проверки потребителей setup не знает) с
 * запасом 25%, не меньше 2 минут, до минуты; не меньше 15 минут и не больше
 * 2 часов. Тот же срок ограничивает вызовы моделей и срок ревью: большой
 * срок позже прерывает зависший вызов — причина это называет.
 */
export function chooseRunTimeout(input: {
  gates: readonly { timeoutMs?: unknown }[];
  /** Шаги подготовки фазы (prepare, setup/ready окружения) с известными сроками. */
  steps?: readonly { timeoutMs?: unknown }[];
  floorMs?: number;
  profileMs?: number;
  existingMs?: number;
}): RunTimeoutChoice {
  const floor = input.floorMs ?? 0;
  const gatesMs = gateTimeoutSum(input.gates, floor);
  const recheckMs = Math.max(
    0,
    ...input.gates.map((g) => Math.max(timeoutOf(g, DEFAULT_GATE_TIMEOUT_MS), floor)),
  );
  const stepsMs = (input.steps ?? []).reduce(
    (sum, s) => sum + timeoutOf(s, DEFAULT_GATE_TIMEOUT_MS),
    0,
  );
  const phaseMs = stepsMs + gatesMs + recheckMs;
  const estimate =
    `оценка фазы интеграции ${minutes(phaseMs)}: ` +
    (stepsMs ? `подготовка ${minutes(stepsMs)}, ` : '') +
    `проверки по очереди ${minutes(gatesMs)} и повтор самой долгой ${minutes(recheckMs)}; проверки потребителей не учтены`;
  const shortfall = (ms: number) =>
    phaseMs > ms ? `; ${estimate} — больше этого срока, поднимите runTimeoutMs` : '';
  const models = (ms: number) =>
    `. Тот же срок ограничивает вызовы моделей и ревью: зависший вызов прервётся через ${minutes(ms)}`;
  if (input.existingMs !== undefined)
    return {
      ms: input.existingMs,
      source: 'existing',
      gatesMs,
      phaseMs,
      reason: `сохранён из существующей конфигурации workspace${shortfall(input.existingMs)}`,
    };
  if (input.profileMs !== undefined)
    return {
      ms: input.profileMs,
      source: 'profile',
      gatesMs,
      phaseMs,
      reason: `задан профилем${shortfall(input.profileMs)}`,
    };
  const margin = Math.max(120_000, Math.ceil(phaseMs * 0.25));
  const derived = Math.ceil((phaseMs + margin) / 60_000) * 60_000;
  if (derived <= DEFAULT_RUN_TIMEOUT_MS)
    return {
      ms: DEFAULT_RUN_TIMEOUT_MS,
      source: 'default',
      gatesMs,
      phaseMs,
      reason: `умолчание: ${estimate}, с запасом укладывается`,
    };
  const ms = Math.min(derived, MAX_DERIVED_RUN_TIMEOUT_MS);
  return {
    ms,
    source: 'gates',
    gatesMs,
    phaseMs,
    reason:
      (derived > MAX_DERIVED_RUN_TIMEOUT_MS
        ? `${estimate}; с запасом больше предела — ограничен ${minutes(ms)}, сократите проверки или задайте runTimeoutMs вручную`
        : `${estimate}; запас ${minutes(ms - phaseMs)}`) + models(ms),
  };
}

export function projectConfig(
  repository: string,
  selected: Profile,
  approvalMode: ApprovalMode = 'agent',
) {
  return configSchema.parse({
    version: 1,
    name: basename(repository),
    repository,
    mode: 'local',
    approvalMode,
    // Встроенные роли — умолчание для профиля, которому роли безразличны.
    // Профиль, объявивший свои, заменяет их целиком: иначе рядом с точными
    // ролями продукта навсегда остаются четыре чужие, без области записи и без
    // задач, и каждая проверка честно сообщает, что они не ограничены ничем.
    roles: Object.keys(selected.roles).length
      ? { ...selected.roles }
      : Object.fromEntries(
          roles.map((role) => [
            role,
            {
              runtime: 'claude',
              title: builtinTitles[role],
              ...(['backend', 'frontend'].includes(role) ? { requiresContract: true } : {}),
            },
          ]),
        ),
    reviewer: { runtime: 'codex' },
    concurrency: selected.concurrency ?? 2,
    ...(selected.runTimeoutMs ? { runTimeoutMs: selected.runTimeoutMs } : {}),
    // Короткий срок быстрой проверки под нагрузкой хоста срывается и сжигает
    // попытку: новая конфигурация исполняет каждую проверку не короче минуты.
    gateTimeoutFloorMs: DEFAULT_GATE_TIMEOUT_FLOOR_MS,
    // Панель и вопросы исполнителя — на русском: подсказки шага ведущему тоже.
    hintLocale: 'ru',
    gates: selected.gates,
    prepare: selected.prepare,
    environment: selected.environment,
    lifecycle: selected.lifecycle,
    generatedPaths: selected.generatedPaths,
    protectedPaths: [
      ...selected.protectedPaths,
      'AGENTS.md',
      'CLAUDE.md',
      '.agents/',
      '.github/',
      '.githooks/',
      'devcontour.config.json',
      'devcontour.component.json',
      'devcontour.workspace.json',
      'docs/journal/',
      '.devcontour-local/',
      '.devcontour/',
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
    ],
    packs: [profileMetadata(selected)],
  });
}

export const profileLock = (selected: Profile) => ({
  version: 1,
  packs: [profilePin(selected)],
});

// Bootstrap a single component without turning its environment into workspace-wide defaults.
export function componentProfileConfig(
  config: ReturnType<typeof projectConfig>,
  workspaceRoot: string,
) {
  const mode = selectedWorkspaceMode(workspaceRoot) ?? 'separate';
  if (mode === 'embedded' && config.repository !== workspaceRoot)
    throw new Error('Embedded workspace должен совпадать с корнем единственного репозитория');
  return {
    ...config,
    workspaceRoot,
    workspaceMode: mode,
    storage: mode === 'embedded' ? ('central' as const) : ('component' as const),
    repositories: [{ ...repositories(config)[0], environment: config.environment }],
    environment: undefined,
    lifecycle: undefined,
    prepare: undefined,
    generatedPaths: [],
  };
}

/**
 * Домены реестра пакетов для песочницы проверок. Песочница закрывает внешнюю
 * сеть всему, чего нет в `isolation.domains`, и установка зависимостей npm или
 * pnpm падала отказом прокси, хотя doctor и план setup молчали. Реестр берётся
 * из `.npmrc` репозитория (`registry=` и `@scope:registry=`); без своего
 * `registry=` — публичный `registry.npmjs.org`. Адрес с подстановкой
 * переменной окружения заранее не известен и не добавляется. Локальные
 * адреса (`localhost`, `.local`, IP-литералы) автоматически не открываются:
 * loopback открыл бы песочнице панель DevContour. Они возвращаются в
 * `skipped`, и план предлагает добавить их вручную, если это намеренно.
 */
const localHost = (host: string) =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host.endsWith('.local') ||
  host.startsWith('[') ||
  isIP(host) !== 0;
export async function packageRegistryDomains(
  repository: string,
  selected: { capabilities?: string[]; gates: { command?: string[] }[] },
) {
  const managers = ['npm', 'pnpm', 'npx'];
  if (
    !selected.capabilities?.some((c) => c === 'npm' || c === 'pnpm') &&
    !selected.gates.some((g) => managers.includes(basename(g.command?.[0] ?? '')))
  )
    return { domains: [] as string[], skipped: [] as string[] };
  const host = (value: string) => {
    if (value.includes('${')) return undefined;
    try {
      return new URL(value.trim()).hostname.replace(/\.+$/, '') || undefined;
    } catch {
      return undefined;
    }
  };
  let text = '';
  try {
    text = await readFile(join(repository, '.npmrc'), 'utf8');
  } catch {
    /* Нет своего .npmrc — публичный реестр. */
  }
  let primary: string | undefined | null = null;
  const scoped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(@[^:=\s]+:)?registry\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const domain = host(match[2]);
    if (match[1]) {
      if (domain) scoped.push(domain);
    } else primary = domain;
  }
  const all = [
    ...new Set([
      ...(primary === null ? ['registry.npmjs.org'] : primary ? [primary] : []),
      ...scoped,
    ]),
  ];
  return { domains: all.filter((d) => !localHost(d)), skipped: all.filter(localHost) };
}

/** Файл компонента, который setup сохраняет вместо своей конфигурации компонента. */
export const componentFileName = 'devcontour.component.json';

type BindingRef = { runtime?: unknown; toolProfile?: unknown; reviewer?: BindingRef };
/**
 * Профили инструментов, на которые ссылаются роли сохранённого файла
 * компонента. Новый config.json начинается без `toolProfiles`, и ссылка роли
 * на профиль, которого нет, делала конфигурацию неприменимой. Профиль по
 * умолчанию — только runtime привязки: те же инструменты, что без профиля.
 * Имя, на которое ссылаются привязки разных runtime, не создаётся: такую
 * ссылку называет doctor.
 */
export function referencedToolProfiles(file: { roles?: unknown; reviewer?: unknown }) {
  const bindings: BindingRef[] = [];
  const add = (b: unknown) => {
    if (!b || typeof b !== 'object') return;
    const binding = b as BindingRef;
    bindings.push(binding);
    add(binding.reviewer);
  };
  if (file.roles && typeof file.roles === 'object')
    for (const role of Object.values(file.roles)) add(role);
  add(file.reviewer);
  const runtimes = new Map<string, Set<'claude' | 'codex'>>();
  for (const b of bindings)
    if (typeof b.toolProfile === 'string' && (b.runtime === 'claude' || b.runtime === 'codex'))
      runtimes.set(b.toolProfile, (runtimes.get(b.toolProfile) ?? new Set()).add(b.runtime));
  return Object.fromEntries(
    [...runtimes]
      .filter(([, set]) => set.size === 1)
      .map(([name, set]) => [name, { runtime: [...set][0] }]),
  );
}

// Файловая часть подготовки — общая операция harness: план назначений
// (symlink и не-каталог на пути, не обычный файл, сверка сохранённого
// профиля) и create-only применение с продолжением после прерывания. Хост
// задаёт состав файлов, порядок (config последним) и прежние тексты отказов.
const conflictText = (entry: FilePlanEntry) => {
  const at = entry.conflictPath ?? entry.path;
  switch (entry.conflict) {
    case 'symlink':
      return `Setup не пишет через symlink: ${at}`;
    case 'ancestor-not-directory':
      return `Родитель не является каталогом: ${at}`;
    default:
      return `Ожидался обычный файл: ${entry.path}`;
  }
};

async function runSetup(options: {
  repository: string;
  profile: string;
  brief?: string;
  data?: string;
  workspace?: string;
  approvalMode?: ApprovalMode;
  /**
   * Быстрое изменение существующего репозитория: поручение и критерий живут в
   * подготовке workspace, поэтому `docs/spec.md` не требуется.
   */
  quick?: boolean;
  /** Gates предложения ведущего агента вместо gates профиля. */
  gates?: unknown[];
  /** Только план: какие файлы будут созданы, сохранены или отклонены. */
  plan?: boolean;
}) {
  const repository = await realpath(resolve(options.repository));
  if (repository === (await realpath(devcontourRoot)))
    throw new Error('Укажите отдельный каталог продукта, а не исходники DevContour');
  let brief: string | undefined;
  if (!options.quick || (await inspectPath(join(repository, 'docs')))) {
    const docs = await realpath(join(repository, 'docs'));
    if (docs !== join(repository, 'docs')) throw new Error('docs должен быть внутри продукта');
    if (!options.quick) {
      brief = await realpath(resolve(repository, options.brief ?? 'docs/spec.md'));
      const briefRelative = relative(docs, brief);
      if (
        isAbsolute(briefRelative) ||
        briefRelative.startsWith('..' + sep) ||
        briefRelative === '..' ||
        !brief.endsWith('.md')
      )
        throw new Error('ТЗ должно быть Markdown-файлом внутри docs продукта');
      if (!(await readFile(brief, 'utf8')).trim()) throw new Error('ТЗ пустое');
    }
  }
  let gitRoot: string | undefined;
  try {
    gitRoot = await git(repository, 'rev-parse', '--show-toplevel');
  } catch {
    /* A new product may contain only docs/spec.md; the agent initializes Git later. */
  }
  if (gitRoot && (await realpath(gitRoot)) !== repository)
    throw new Error('Продукт находится внутри другого Git-репозитория; выберите его корень');

  const pinned = await profile(options.profile, repository);
  // Профиль закрепляется как есть; gates предложения заменяют только gates конфигурации.
  const selected = options.gates ? { ...pinned, gates: gateList.parse(options.gates) } : pinned;
  if (options.workspace && options.data) throw new Error('Используйте workspace или data, не оба');
  let workspaceRoot: string | undefined;
  if (options.workspace) {
    if (!isAbsolute(options.workspace)) throw new Error('workspace требует абсолютный путь');
    await checkDestination(options.workspace);
    workspaceRoot = (await inspectPath(options.workspace))
      ? await realpath(options.workspace)
      : resolve(options.workspace);
    const toolRoot = await realpath(devcontourRoot);
    const mode = selectedWorkspaceMode(workspaceRoot) ?? 'separate';
    if (workspaceRoot === toolRoot || workspaceRoot.startsWith(toolRoot + sep))
      throw new Error('Workspace должен находиться вне каталога DevContour');
    if (
      mode === 'embedded'
        ? workspaceRoot !== repository
        : workspaceRoot === repository || workspaceRoot.startsWith(repository + sep)
    )
      throw new Error(
        mode === 'embedded'
          ? 'Embedded workspace должен совпадать с корнем репозитория'
          : 'Separate workspace должен находиться вне репозитория продукта',
      );
    if (await inspectPath(workspaceRoot)) assertControllerCheckout(workspaceRoot);
  }
  const data = workspaceRoot
    ? join(workspaceRoot, '.devcontour-local')
    : options.data
      ? resolve(options.data)
      : join(repository, '.devcontour-local');
  // С workspace конфигурация компонента живёт в файле репозитория, а
  // config.json только ссылается на него. Уже закоммиченный файл setup не
  // перезаписывает, и его проверки и роли действуют вместо предложения: план
  // называет это прямо и показывает действующие проверки.
  const existing = workspaceRoot ? existingComponentFile(repository) : undefined;
  const componentPath = existing?.path;
  const componentFile = existing?.state === 'file' ? existing.content : undefined;
  const componentError =
    existing?.state === 'invalid'
      ? `Файл компонента ${existing.path} не читается: ${existing.reason}`
      : undefined;
  const gateSummary = (gates: unknown) =>
    (Array.isArray(gates) ? gates : []).flatMap((g: unknown) => {
      if (!g || typeof g !== 'object') return [];
      const gate = g as { id?: unknown; kind?: unknown; command?: unknown };
      return typeof gate.id === 'string'
        ? [
            {
              id: gate.id,
              ...(typeof gate.kind === 'string' ? { kind: gate.kind } : {}),
              ...(Array.isArray(gate.command) ? { command: gate.command.map(String) } : {}),
            },
          ]
        : [];
    });
  const component = componentPath
    ? componentFile
      ? {
          path: componentPath,
          action: 'preserve' as const,
          precedence: true,
          gates: gateSummary(componentFile.gates),
          roles:
            componentFile.roles && typeof componentFile.roles === 'object'
              ? Object.keys(componentFile.roles)
              : [],
          note: `${componentFileName} уже есть в репозитории и сохраняется без изменений: действуют его проверки и роли, а не проверки и роли этого предложения. Чтобы применить предложение, измените файл компонента отдельным коммитом.`,
        }
      : componentError
        ? undefined
        : { path: componentPath, action: 'create' as const, precedence: false }
    : undefined;
  // Профили инструментов, которые называют роли сохранённого файла компонента.
  const toolProfiles = componentFile ? referencedToolProfiles(componentFile) : {};
  const registryDomains = await packageRegistryDomains(repository, selected);
  // Срок фазы попытки — по проверкам, которые будут действовать после setup.
  // Действующие после setup gates и шаги подготовки — один источник для
  // плана и срока фазы: сохранённый файл компонента, если он действует
  // (без массива gates — без проверок), иначе предложение или профиль.
  const objects = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter(
      (item): item is { timeoutMs?: unknown } => !!item && typeof item === 'object',
    );
  const effectiveGateSource: readonly { timeoutMs?: unknown }[] = component?.precedence
    ? objects(componentFile?.gates)
    : selected.gates;
  const lifecycleOf = (value: unknown) => {
    const l = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return [...objects(l.setup), ...objects(l.ready)];
  };
  const effectiveSteps = component?.precedence
    ? [...objects(componentFile?.prepare), ...lifecycleOf(componentFile?.lifecycle)]
    : [...objects(selected.prepare), ...lifecycleOf(selected.lifecycle)];
  const runTimeout = chooseRunTimeout({
    gates: effectiveGateSource,
    steps: effectiveSteps,
    floorMs: DEFAULT_GATE_TIMEOUT_FLOOR_MS,
    ...(selected.runTimeoutMs ? { profileMs: selected.runTimeoutMs } : {}),
    ...(await existingRunTimeout(join(data, 'config.json'))),
  });
  const files = new Map<string, string>();
  // Инструкции стека приезжают из библиотеки DevContour по объявлению профиля,
  // а не лежат в каждом проекте заранее: подтвердили мобильное приложение —
  // приехали мобильные инструкции, и только они.
  // Пакеты конфигурации — умолчания ролей и пакеты профиля; тот же список
  // уходит в config.json. Их правила и справка приезжают сейчас, в том же
  // create-only плане: context-lock после bootstrap закрепляет файлы дерева.
  const configuredPacks = [
    ...new Map(
      [
        ...(() => {
          const declared = projectConfig(repository, selected, options.approvalMode).roles;
          return defaultContextPacks('main', Object.keys(declared), declared);
        })(),
        ...selected.contextPacks,
      ].map((pack) => [pack.id, pack]),
    ).values(),
  ];
  const references = (pack: object) =>
    'references' in pack && Array.isArray(pack.references) ? (pack.references as string[]) : [];
  for (const pack of configuredPacks)
    for (const file of [...pack.files, ...references(pack)]) {
      const source = join(libraryRoot, file);
      if (files.has(join(repository, file))) continue;
      try {
        files.set(join(repository, file), await readFile(source, 'utf8'));
      } catch {
        /* Пакет вправе ссылаться на файл, который пишет сам продукт. */
      }
    }
  for (const name of await listRegularFiles(templateRoot))
    files.set(join(repository, name), await readFile(join(templateRoot, name), 'utf8'));
  files.set(
    join(repository, '.gitignore'),
    '.devcontour-local/\n.reports/\nnode_modules/\ndist/\n.venv/\n__pycache__/\n.pytest_cache/\n.ruff_cache/\n.expo/\n.env*\n!.env.example\n',
  );
  if (workspaceRoot && workspaceRoot !== repository)
    files.set(join(workspaceRoot, '.gitignore'), '.devcontour-local/\n.env*\n!.env.example\n');
  // Руководства DevContour — с меткой digest: guides-refresh позже отличит
  // устаревшую копию от изменённой в продукте (guides.ts).
  for (const [name, content] of await guideCopies())
    files.set(join(repository, 'docs', name), content);
  files.set(join(data, 'packs.lock.json'), JSON.stringify(profileLock(pinned), null, 2) + '\n');
  const profilePath = join(data, 'profiles', selected.id + '.json');
  const profileContent = selected.raw;
  files.set(profilePath, profileContent);
  // Publish config last so an interrupted copy can resume without an incomplete policy.
  files.set(
    join(data, 'config.json'),
    JSON.stringify(
      {
        ...(workspaceRoot
          ? componentProfileConfig(
              projectConfig(repository, selected, options.approvalMode),
              workspaceRoot,
            )
          : projectConfig(repository, selected, options.approvalMode)),
        runTimeoutMs: runTimeout.ms,
        ...(registryDomains.domains.length
          ? { isolation: { mode: 'os', domains: registryDomains.domains } }
          : {}),
        ...(Object.keys(toolProfiles).length ? { toolProfiles } : {}),
        // Пакеты строятся по объявленным ролям: роль без своей инструкции
        // осталась бы с одним общим контекстом и не знала бы своего дела.
        // Пакеты профиля приезжают вместе со стеком и уточняют умолчания.
        contextPacks: configuredPacks,
      },
      null,
      2,
    ) + '\n',
  );

  // Сохранённый файл компонента проверяется схемой и правилами конфигурации
  // сейчас, а не первой загрузкой после применения.
  const componentProblem =
    componentFile && componentPath
      ? componentConfigProblem(
          JSON.parse(files.get(join(data, 'config.json'))!) as Parameters<
            typeof componentConfigProblem
          >[0],
          componentFile,
        )
      : undefined;
  // План до любой записи; существующие файлы, включая политику пользователя,
  // сохраняются. Сохранённый снимок профиля обязан совпадать байтово.
  const intents: FileIntent[] = [...files].map(([path, content]) =>
    path === profilePath ? { path, content, onExisting: 'require-identical' } : { path, content },
  );
  // Отказы применения; план называет их данными, а не бросает.
  const refusals = async (plan: Awaited<ReturnType<typeof planFileWrites>>) => {
    const unsafe = plan.entries.find(
      (e) => e.action === 'conflict' && e.conflict !== 'content-differs',
    );
    if (unsafe)
      throw new HarnessError('PATH_CONFLICT', conflictText(unsafe), [
        { path: [unsafe.conflictPath ?? unsafe.path], message: unsafe.conflict! },
      ]);
    let approvalMode = options.approvalMode ?? 'agent';
    if (await inspectPath(join(data, 'config.json'))) {
      const existing = loadConfig(join(data, 'config.json'));
      if (
        (workspaceRoot && existing.workspaceRoot !== workspaceRoot) ||
        existing.repository !== repository ||
        existing.mode !== 'local' ||
        !existing.packs.some((p) => packKey(p) === packKey(selected))
      )
        throw new Error('Существующая конфигурация относится к другому продукту или профилю');
      if (options.approvalMode && existing.approvalMode !== options.approvalMode)
        throw new Error('Setup не меняет установленный режим согласования; измените его явно');
      approvalMode = existing.approvalMode;
    } else if (await inspectPath(join(data, 'packs.lock.json'))) {
      const existing = JSON.parse(await readFile(join(data, 'packs.lock.json'), 'utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(profileLock(pinned)))
        throw new Error('Существующий packs.lock.json не соответствует выбранному профилю');
    }
    if (plan.conflicts)
      throw new Error('Сохранённый профиль изменён; требуется явная сверка версии');
    if (componentError) throw new Error(componentError);
    if (componentProblem)
      throw new Error(
        `Файл компонента ${componentPath} не подходит конфигурации: ${componentProblem}. Исправьте его отдельным коммитом и повторите setup`,
      );
    return approvalMode;
  };
  const plan = await planFileWrites({ files: intents });
  // Что setup добавляет в config.json сверх профиля: оператор видит сетевую
  // политику песочницы и профили инструментов до применения.
  const generated = {
    isolation: {
      domains: registryDomains.domains,
      ...(registryDomains.skipped.length
        ? {
            skipped: registryDomains.skipped,
            note: `Локальные адреса реестра не открыты песочнице автоматически: ${registryDomains.skipped.join(', ')}. Если это намеренно, добавьте их в isolation.domains вручную.`,
          }
        : {}),
    },
    toolProfiles,
    runTimeout,
  };
  // Проверки, которые будут действовать после setup.
  const effectiveGates = gateSummary(effectiveGateSource);
  if (options.plan) {
    let refusal: string | undefined;
    try {
      await refusals(plan);
    } catch (error) {
      refusal = (error as Error).message;
    }
    return {
      status: 'plan' as const,
      repository,
      workspace: workspaceRoot,
      data,
      profile: pinned.id,
      files: [
        ...plan.entries.map((e) => ({
          path: e.path,
          action: e.action,
          ...(e.conflict ? { conflict: e.conflict } : {}),
        })),
        // Файл компонента пишет не план файлов, а применение конфигурации;
        // в плане он назван своим действием, чтобы сохранённый файл был виден.
        ...(component ? [{ path: component.path, action: component.action }] : []),
      ],
      conflicts: plan.conflicts,
      gates: effectiveGates,
      ...(component ? { component } : {}),
      ...generated,
      ...(refusal ? { refusal } : {}),
    };
  }
  const approvalMode = await refusals(plan);
  const { created, preserved } = await applyFileWrites(plan, intents);
  if (workspaceRoot) {
    const configPath = join(data, 'config.json');
    const config = loadConfig(configPath);
    if (config.storage === 'component' || config.workspaceMode === 'embedded')
      await writeFile(configPath, JSON.stringify(scopedConfig(config), null, 2) + '\n');
  }
  return {
    status: 'needs-agent-bootstrap' as const,
    repository,
    brief,
    workspace: workspaceRoot,
    data,
    profile: selected.id,
    approvalMode,
    created: component?.action === 'create' ? [...created, component.path] : created,
    preserved: component?.action === 'preserve' ? [...preserved, component.path] : preserved,
    ...(component ? { gates: effectiveGates, component } : {}),
    ...(registryDomains.domains.length ||
    registryDomains.skipped.length ||
    Object.keys(toolProfiles).length
      ? generated
      : { runTimeout }),
    next: [
      ...(component?.precedence ? [component.note] : []),
      'Ведущий агент продолжает по START.md: каркас, настройки, реальные gates и исходный Git-коммит.',
      'Сохранённые пользовательские AGENTS.md и .gitignore нужно согласовать с новыми правилами без потери данных.',
      'После bootstrap-коммита выполните context-lock: инструкции закрепляются по Git SHA и digest.',
      'Контракты и план проходят независимое ревью; при approvalMode=agent подтверждение оператора не требуется.',
      'После запуска ведущий агент разбирает сбои, ведёт следующие этапы и принимает только проверенные доски.',
    ],
  };
}

type SetupOptions = Omit<Parameters<typeof runSetup>[0], 'plan'>;
type SetupOutcome = Awaited<ReturnType<typeof runSetup>>;

export async function setupProject(options: SetupOptions) {
  return (await runSetup(options)) as Exclude<SetupOutcome, { status: 'plan' }>;
}

/** План setup без записи: файлы с действием и отказ, которым закончилось бы применение. */
export async function planSetup(options: SetupOptions) {
  return (await runSetup({ ...options, plan: true })) as Extract<SetupOutcome, { status: 'plan' }>;
}
