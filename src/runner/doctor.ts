import { access, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, type Config, type DevContourState, type Role } from '../core/model.ts';
import {
  codeReviewVendor,
  declaredRoles,
  expandGates,
  repositories,
  reviewerBinding,
  roleBinding,
} from '../core/repositories.ts';
import { DevContourExecutionStore, harnessVersion } from '../harness/index.ts';
import { projectionOptions } from '../harness/host.ts';
import { technicalReviewer } from '../harness/policy.ts';
import { checkoutPath, standaloneScope } from 'devcontour-harness';
import { isolationSupport } from './isolation.ts';
import { quickSetupMarks } from './quick.ts';
import { ATTENTION_NAMESPACE } from '../application/attention.ts';
import { ignoredComponentCopies } from './config.ts';
import { CheckoutRootError, checkoutRootFor } from './checkout-root.ts';
import { installProbe } from './install-probe.ts';
import { gateTimeoutSum, packageRegistryDomains } from './setup.ts';
import { validateWorkflow } from '../core/workflow.ts';
import { command, git } from './process.ts';
import { outdatedContextPacks } from './context-library.ts';
import { executionEnvironment, runSteps, withEnvironment } from './environment.ts';
import { withResources } from './resources.ts';
import { agentEnvironment, reviewerRunsChecks, toolProfileFor, writerRunsChecks } from './tools.ts';
import { taskContext } from './context.ts';
import {
  appliedCheck,
  budgetChecks,
  workspaceDeclaration,
  type DoctorCall,
} from './budget-doctor.ts';
import type { UsageRecord } from '../core/usage.ts';
import { forgeAdapter } from './forge.ts';
import {
  APPLIED_KEYS_KEY,
  APPLIED_KEYS_NAMESPACE,
  DevContour,
  supersededBy,
  type AppliedConfigKeys,
} from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import { artifactGuard, CONTINUATION, contractSize, thousands } from './agent-control.ts';
import { unguardedMessage } from './artifact-closure.ts';
import {
  Store,
  controllerRow,
  effectiveLeader,
  journalFiles,
  readOnlyLocation,
} from '../core/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/**
 * `degraded` — работать можно, но слабее, чем ожидает оператор, и не по его
 * явному выбору: например, claude-ревьюер без профиля инструментов только
 * читает, хотя codex-ревьюер на его месте запускал проверки. Готовность не
 * снимает, но называет исправление.
 */
type Check = {
  id: string;
  status: 'passed' | 'blocked' | 'not-checked' | 'degraded';
  detail: string;
};
/** Готовность снимает только `blocked`; `degraded` и `not-checked` её не снимают. */
const installVerbs = new Set(['ci', 'install', 'i', 'add']);
/** Шаг ставит зависимости npm, pnpm или yarn — глагол где угодно после менеджера. */
export function isInstallStep(command: string[] = []) {
  const names = command.map((part) => part.split('/').at(-1) ?? '');
  const at = names.findIndex((n) => n === 'npm' || n === 'pnpm' || n === 'yarn');
  if (at < 0) return false;
  const rest = names.slice(at + 1);
  if (rest.some((n) => installVerbs.has(n))) return true;
  // `yarn` без подкоманды — установка.
  return names[at] === 'yarn' && !rest.some((n) => !n.startsWith('-'));
}
/**
 * Установка зависимостей npm/pnpm/yarn идёт в песочнице проверок, а внешняя
 * сеть там открыта только доменам `isolation.domains`. Нет домена реестра,
 * который называет `.npmrc` компонента (или публичного, если своего нет), —
 * отказ прокси на первой задаче, а не на doctor.
 */
export async function installNetworkCheck(config: Config): Promise<Check | undefined> {
  if (config.isolation.mode !== 'os') return undefined;
  const allowed = new Set(config.isolation.domains);
  const missing = new Set<string>();
  const installs: string[] = [];
  for (const repo of repositories(config)) {
    const steps = [...repo.gates, ...(repo.prepare ?? [])].filter((step) =>
      isInstallStep(step.command),
    );
    if (!steps.length) continue;
    installs.push(...steps.map((step) => `${repo.id}:${step.id}`));
    const { domains } = await packageRegistryDomains(repo.path, {
      capabilities: ['npm'],
      gates: [],
    });
    for (const domain of domains) if (!allowed.has(domain)) missing.add(domain);
  }
  if (!installs.length || !missing.size) return undefined;
  return {
    id: 'isolation:network',
    status: 'degraded',
    detail: `Проверки установки зависимостей (${[...new Set(installs)].join(', ')}) идут в песочнице, а домена реестра пакетов нет в isolation.domains: ${[...missing].join(', ')}. Реестр будет закрыт прокси песочницы. Добавьте домен в isolation.domains и перезапустите сервер.`,
  };
}
/** Задача для справки о наборе проверок одной попытки (`gateTimeoutCheck`). */
type TimeoutTask = Pick<DevContourState['tasks'][number], 'id' | 'status' | 'repositoryId'> &
  Partial<Pick<DevContourState['tasks'][number], 'gates' | 'consumers'>>;

/**
 * Проверки идут по очереди в одной фазе, ограниченной `runTimeoutMs`. Порог
 * предупреждения — весь профиль компонента: его целиком исполняют проверка
 * перенесённой базы (base-check) и задача без области gates, а проверка
 * покрытия доски — все gates, не покрытые областями задач, вплоть до всего
 * профиля. Совместные проверки workspace — тоже целиком.
 *
 * Попытка задачи с областью исполняет меньше — область (`gates`, раскрытые
 * группы) с предпосылками (`standaloneScope`) и проверки потребителей. Это
 * только справка в тексте: наибольший такой набор среди открытых задач, а без
 * них — наибольшая группа `gateGroups`. Срок набора — сумма действующих сроков
 * (каждый не короче `gateTimeoutFloorMs`), без повтора проверки и шагов
 * подготовки: оценка снизу.
 */
export function gateTimeoutCheck(
  config: Config,
  tasks: readonly TimeoutTask[] = [],
): Check | undefined {
  const floor = config.gateTimeoutFloorMs ?? 0;
  const min = (ms: number) => Math.round(ms / 6000) / 10 + ' мин';
  const repos = repositories(config);
  const byId = new Map(repos.map((r) => [r.id, r]));
  /** Gates профиля по ссылкам: группы раскрыты, предпосылки добавлены; при ошибке — весь профиль. */
  const gatesOf = (repo: (typeof repos)[number], refs?: string[]) => {
    let ids: string[];
    try {
      ids = standaloneScope(repo.gates, expandGates(repo, refs));
    } catch {
      ids = repo.gates.map((g) => g.id);
    }
    return repo.gates.filter((g) => ids.includes(g.id));
  };
  const open = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled' && byId.has(t.repositoryId),
  );
  const over = repos.flatMap((repo) => {
    const wholeMs = gateTimeoutSum(repo.gates, floor);
    if (wholeMs <= config.runTimeoutMs) return [];
    const candidates = open
      .filter((t) => t.repositoryId === repo.id && t.gates)
      .map((t) => {
        const gates = [
          ...gatesOf(repo, t.gates),
          ...(t.consumers ?? []).flatMap((c) => {
            const consumer = byId.get(c.repositoryId);
            return consumer ? gatesOf(consumer, c.gates) : [];
          }),
        ];
        return {
          source: `область задачи ${t.id}${t.consumers?.length ? ' с проверками потребителей' : ''}`,
          count: gates.length,
          ms: gateTimeoutSum(gates, floor),
        };
      });
    const unscoped = open.some((t) => t.repositoryId === repo.id && !t.gates);
    if (!candidates.length && !unscoped)
      for (const [name, refs] of Object.entries(repo.gateGroups ?? {})) {
        const gates = gatesOf(repo, refs);
        candidates.push({
          source: `наибольшая группа gates @${name}`,
          count: gates.length,
          ms: gateTimeoutSum(gates, floor),
        });
      }
    const largest = candidates.sort((a, b) => b.ms - a.ms)[0];
    const attempt =
      largest && largest.count < repo.gates.length
        ? ` (справочно: попытка задачи с областью исполняет меньше — ${largest.source} с предпосылками: gates ${largest.count}, до ${min(largest.ms)}${largest.ms > config.runTimeoutMs ? ', тоже больше срока фазы' : ''})`
        : '';
    return [
      `компонента ${repo.id} — весь профиль: gates ${repo.gates.length}, по очереди до ${min(wholeMs)}${attempt}`,
    ];
  });
  const joint = gateTimeoutSum(config.workspaceGates, floor);
  if (joint > config.runTimeoutMs)
    over.push(
      `workspace (совместные): gates ${config.workspaceGates.length}, по очереди до ${min(joint)}`,
    );
  if (!over.length) return undefined;
  return {
    id: 'gates:timeout',
    status: 'degraded',
    detail: `Проверки не укладываются в срок фазы runTimeoutMs ${min(config.runTimeoutMs)}: ${over.join('; ')}. Весь профиль компонента в одной фазе исполняют проверка перенесённой базы (base-check) и задача без области gates, а проверка покрытия доски — все gates, не покрытые областями задач; совместные проверки workspace идут целиком. Срок — сумма сроков timeoutMs, каждый не короче gateTimeoutFloorMs; долгая проверка оборвётся сроком фазы, и эти проверки упадут по таймауту. Это оценка снизу: повтор проверки на интеграции и шаги подготовки и окружения в неё не входят. Поднимите runTimeoutMs в config.json и перезапустите serve или сократите проверки.`,
  };
}
export const doctorReady = (checks: Pick<Check, 'status'>[]) =>
  !checks.some((c) => c.status === 'blocked');
const bindingLabel = (b: { runtime: string; model?: string }) =>
  b.model ? `${b.runtime} (${b.model})` : b.runtime;
export async function executable(file: string) {
  const candidates = file.includes('/')
    ? [file]
    : (process.env.PATH ?? '').split(delimiter).map((p) => join(p, file));
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* next PATH entry */
    }
  }
  throw new Error('Команда не найдена: ' + file);
}
/**
 * Версия движка исполнения и версии, записавшие состояние: перед обновлением
 * и откатом видно, какая версия последней писала базу. Живая роль controller
 * другой версии движка — блокировка: её процесс ещё работает.
 */
export function engineCheck(
  state: Pick<DevContourState, 'leader' | 'runs'>,
  now = Date.now(),
): Check {
  const leader: { owner: string; leaseUntil: number; engineVersion?: string } | undefined =
    state.leader;
  const versionOf = (r: unknown) => (r as { engineVersion?: string }).engineVersion;
  const attempts = [...new Set(state.runs.flatMap((r) => versionOf(r) ?? []))].sort();
  // Попытки ранних версий версию движка не записывали: они есть, но без версии.
  const unversioned = state.runs.filter((r) => !versionOf(r)).length;
  const recorded = !state.runs.length
    ? 'попыток нет'
    : [
        `попыток ${state.runs.length}`,
        ...(attempts.length ? [`записаны версиями: ${attempts.join(', ')}`] : []),
        ...(unversioned ? [`без записанной версии: ${unversioned}`] : []),
      ].join(', ');
  const live = !!leader && leader.leaseUntil > now;
  const controller = leader
    ? `роль controller ${leader.owner} (${leader.engineVersion ?? 'версия не записана'}${live ? ', живая' : ', истекла'})`
    : 'роли controller нет';
  const detail = `devcontour-harness ${harnessVersion}; ${controller}; ${recorded}`;
  if (live && leader.engineVersion !== harnessVersion)
    return {
      id: 'engine',
      status: 'blocked',
      detail: `${detail}. Состояние держит процесс другой версии движка: остановите его штатно или дождитесь истечения роли`,
    };
  return { id: 'engine', status: 'passed', detail };
}

/** Записи, которых не знает выпуск 0.4.0-alpha.17 — последний перед быстрым маршрутом. */
export interface NewStateInventory {
  quickIntakes: number;
  setupProposals: number;
  expansions: number;
  discussions: number;
  /** Решения за владельца (`kind: stand-in`) и решения владельца по ним (`ruling`). */
  standIns: number;
  rulings: number;
  attentionMarks: number;
  inputRequests: number;
  openInputRequests: number;
  quickSetupMarks: number;
}

/** Опись записей новых версий: только чтение базы и файла отметки setup. */
export function newStateInventory(
  store: Store,
  state: Pick<DevContourState, 'preparation'>,
  root: string,
): NewStateInventory {
  const changes = state.preparation?.changes ?? [];
  const requests = store.localEntries<{ lifecycle?: string }>('input-requests');
  return {
    quickIntakes: changes.filter((c) => c.intake).length,
    setupProposals: changes.reduce((n, c) => n + (c.setup?.length ?? 0), 0),
    expansions: changes.filter((c) => c.expanded).length,
    discussions: store.discussionCount(),
    ...store.standInCounts(),
    attentionMarks: store.localEntries(ATTENTION_NAMESPACE).length,
    inputRequests: requests.length,
    openInputRequests: requests.filter(
      (r) => r.value.lifecycle === 'pending' || r.value.lifecycle === 'answered',
    ).length,
    quickSetupMarks: Object.keys(quickSetupMarks(root)).length,
  };
}

const ROLLBACK =
  'Откат к 0.4.0-alpha.17 — восстановлением копии всех баз и каталога данных, снятой до обновления, вместе с прежней версией (docs/upgrade.md, «Откат»)';

/**
 * Какие записи новых версий есть в состоянии, какая версия их читает и как
 * откатиться. Только сведения: проверка не блокирует, откат решает оператор.
 */
export function newStateCheck(inventory: NewStateInventory): Check {
  const i = inventory;
  const parts: string[] = [];
  if (i.quickIntakes || i.setupProposals || i.expansions)
    parts.push(
      `быстрый маршрут: поручений ${i.quickIntakes}, предложений setup ${i.setupProposals}, переходов на полный маршрут ${i.expansions} — читает DevContour после 0.4.0-alpha.17 с движком 0.1.0-alpha.36 и новее; 0.4.0-alpha.17 строгой схемой отклоняет запись состояния, Git sync записи подготовки у участника этой версии останавливается`,
    );
  if (i.discussions)
    parts.push(
      `обсуждения задач: сообщений ${i.discussions} — читает DevContour после 0.4.0-alpha.17 с движком 0.1.0-alpha.36 и новее; 0.4.0-alpha.17 таблицу не читает: после отката обсуждения не видны, после повторного обновления видны снова`,
    );
  if (i.standIns || i.rulings)
    parts.push(
      `решения за владельца: ${i.standIns}, решений владельца по ним ${i.rulings} — читает DevContour после 0.4.0-alpha.33; 0.4.0-alpha.33 строгой схемой отклоняет такие сообщения: не открывается тред задачи с решением за владельца или его подтверждением, а после отмены владельцем (обращение к ведущему с полем ruling) — ещё discussion_inbox, session_handoff и весь центр внимания`,
    );
  if (i.attentionMarks)
    parts.push(
      `отметки центра внимания: ${i.attentionMarks} — читает DevContour после 0.4.0-alpha.17 с движком 0.1.0-alpha.37; 0.4.0-alpha.17 их не читает, на работу они не влияют`,
    );
  if (i.inputRequests)
    parts.push(
      `вопросы исполнителя: запросов ${i.inputRequests}, открытых ${i.openInputRequests} — читает DevContour после 0.4.0-alpha.17 с движком 0.1.0-alpha.37; 0.4.0-alpha.17 записи не читает, а попытки и задачи с полями вопросов отклоняет строгой схемой`,
    );
  if (i.quickSetupMarks)
    parts.push(
      `отметка quick-setup.json каталога данных: изменений ${i.quickSetupMarks} — читает DevContour после 0.4.0-alpha.17; файл вне базы и в backup не входит: копируйте его вместе с базами`,
    );
  return {
    id: 'compat:new-state',
    status: 'passed',
    detail: parts.length
      ? `${parts.join('; ')}. ${ROLLBACK}`
      : 'Записей быстрого маршрута, обсуждений задач, решений за владельца, отметок центра внимания, вопросов исполнителя и отметки quick-setup.json нет',
  };
}

/** Опись новых записей без отказа: сбой чтения — `not-checked`, готовность не снимается. */
function newStateOf(store: Store, state: DevContourState, root: string): Check {
  try {
    return newStateCheck(newStateInventory(store, state, root));
  } catch (e) {
    return {
      id: 'compat:new-state',
      status: 'not-checked',
      detail: `Опись записей новых версий не прочитана: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Проверка совместимости данных: только хранение и формат. Каждая база
 * (центральная или coordinator и базы компонентов) открывается соединением
 * только для чтения до любого доступа на запись: без проекций, журнала,
 * начальных строк и присвоения владельца. Проверяются версия каждого
 * исходного документа, владение баз компонентов, версия движка и роль
 * controller, документ исполнения строгими схемами harness и конфигурация
 * штатного загрузчика. Модели, CLI, песочница и live-проверки не проверяются:
 * результат не означает готовность среды — её подтверждает полный `doctor`
 * на хосте.
 */
export function dataDoctor(config: Config, root: string) {
  const checks: Check[] = [];
  const check = (id: string, action: () => string) => {
    try {
      checks.push({ id, status: 'passed', detail: action() });
      return true;
    } catch (e) {
      checks.push({ id, status: 'blocked', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  const result = () => ({
    scope: 'data-compatibility',
    compatible: !checks.some((c) => c.status === 'blocked'),
    checks,
    note: 'Проверка совместимости данных: модели, CLI, песочница и live-проверки не проверялись. Готовность среды подтверждает полный devcontour doctor на хосте после установки, до возобновления writers.',
  });
  check('config', () => {
    validateWorkflow(config);
    return 'Конфигурация загружена штатным загрузчиком, принадлежит workspace и согласована';
  });
  let store: Store | undefined;
  // Без файлов журнала база WAL читается как неизменяемая (Store, только
  // чтение): ни `-wal`, ни `-shm` проверка не создаёт. Появились файлы
  // журнала или изменился сам файл базы (writer открыл, записал, перенёс
  // журнал в базу и закрылся) — прочитанное могло устареть.
  const file = join(root, 'state.sqlite');
  const journal = journalFiles(file);
  const print = () => {
    try {
      const s = statSync(file);
      return JSON.stringify([s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    } catch {
      return 'missing';
    }
  };
  const quiet = !journal.some((f) => existsSync(f));
  const before = print();
  const settled = () => {
    if (quiet && (journal.some((f) => existsSync(f)) || print() !== before))
      checks.push({
        id: 'storage-quiet',
        status: 'blocked',
        detail:
          'Во время проверки базу менял другой процесс (файлы журнала SQLite или файл базы): остановите writers и повторите проверку',
      });
  };
  if (
    !check('storage', () => {
      store = new Store(
        join(root, 'state.sqlite'),
        config.storage === 'component' ? repositories(config) : undefined,
        false,
        undefined,
        true,
      );
      return config.storage === 'component'
        ? `Базы компонентов существуют и принадлежат этому coordinator: ${repositories(config)
            .map((r) => r.id)
            .join(', ')}; открыты только для чтения`
        : 'Центральная база существует; открыта только для чтения';
    })
  )
    return result();
  try {
    let state: DevContourState | undefined;
    if (
      !check('state', () => {
        state = store!.read();
        return 'Версии исходных документов поддерживаются (stateVersion 1)';
      })
    )
      return result();
    checks.push(engineCheck(state!));
    checks.push(newStateOf(store!, state!, root));
    check('execution-state', () => {
      const h = new DevContour(store!, config);
      const execution = new DevContourExecutionStore(h.store, projectionOptions(h));
      const counts = execution.read((v) => {
        v.control();
        v.controller();
        return {
          graphs: v.graphs().length,
          works: v.works().length,
          attempts: v.attempts().length,
          verifications: v.verifications().length,
        };
      });
      return `Документ исполнения читается строгими схемами devcontour-harness ${harnessVersion} (stateVersion ${execution.stateVersion}): графов ${counts.graphs}, работ ${counts.works}, попыток ${counts.attempts}, совместных проверок ${counts.verifications}`;
    });
  } finally {
    store!.close();
  }
  settled();
  return result();
}

/**
 * Состояние для полного `doctor` — только чтением, как в проверке данных:
 * без PRAGMA режима журнала, DDL, начальных строк и владельца баз
 * компонентов. Полный doctor не становится writer: таблицы и строки, которых
 * нет в базе прежней версии, создаёт первый writer (`serve`, `run`).
 *
 * База WAL без файлов журнала читается как неизменяемая. Если за время чтения
 * появились файлы журнала или изменился файл базы, прочитанное могло
 * устареть — чтение повторяется (теперь с журналом, обычным соединением).
 *
 * Базы ещё нет (центральной — пустое состояние, как у новой базы; базы
 * компонента — проверка `state` not-checked): doctor её не создаёт.
 */
export function doctorState(
  config: Config,
  root: string,
): {
  state?: DevContourState;
  engine?: Pick<DevContourState, 'leader' | 'runs' | 'contracts'>;
  check?: Check;
  /** Записи вызовов моделей всех владельцев — для проверки тарифов. */
  calls?: DoctorCall[];
  /** Опись записей новых версий (`compat:new-state`). */
  newState?: Check;
  /** Digest ключей применённой конфигурации, если сервер их записал. */
  appliedKeys?: AppliedConfigKeys;
} {
  const file = join(root, 'state.sqlite');
  if (!existsSync(file)) return { state: emptyState() };
  const components = config.storage === 'component' ? repositories(config) : undefined;
  const missing = (components ?? []).filter(
    (r) => !existsSync(join(r.path, '.devcontour-local', 'state.sqlite')),
  );
  const print = () => {
    try {
      const s = statSync(file);
      return JSON.stringify([s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    } catch {
      return 'missing';
    }
  };
  // Чтение, которому не помешал writer: база WAL без файлов журнала читается
  // неизменяемой, и если за это время появились файлы журнала или изменился
  // файл базы, чтение повторяется (уже с журналом).
  const settledRead = <T>(read: () => T): { value?: T; failure?: unknown; settled: boolean } => {
    for (let attempt = 1; ; attempt++) {
      const journal = journalFiles(file);
      const quiet = !journal.some((f) => existsSync(f));
      const before = print();
      let value: T | undefined;
      let failure: unknown;
      try {
        value = read();
      } catch (e) {
        failure = e;
      }
      const settled = !quiet || (!journal.some((f) => existsSync(f)) && print() === before);
      if (settled || attempt === 3) return { value, failure, settled };
    }
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const restless = 'Базу непрерывно меняет другой процесс: состояние не прочитано согласованно';
  if (missing.length) {
    // Без баз компонентов полное состояние не собрать, но роль controller,
    // попытки и контракты без владельца-компонента хранит центральная база:
    // проверки `engine` и закрепления контрактов по ней не пропускаются.
    const pending = `Базы компонентов ещё не созданы: ${missing.map((r) => r.id).join(', ')}. Doctor баз не создаёт — их создаст первый writer (serve или run)`;
    const {
      value: central,
      failure,
      settled,
    } = settledRead(() => {
      const db = new DatabaseSync(readOnlyLocation(file), { readOnly: true });
      try {
        const row = db.prepare('SELECT data FROM main.state WHERE id=1').get() as
          { data: string } | undefined;
        if (!row) throw new Error('В базе нет состояния: ' + file);
        const document = JSON.parse(row.data) as Partial<DevContourState>;
        if (document.version !== 1) throw new Error('Unsupported state version');
        // Роль controller — своя строка базы; прежние версии хранили её в документе.
        return { ...document, leader: effectiveLeader(document.leader, controllerRow(db)) };
      } finally {
        db.close();
      }
    });
    if (!central || !settled)
      return {
        check: {
          id: 'state',
          status: 'blocked',
          detail: `${pending}; центральная база не читается: ${settled ? message(failure) : restless}`,
        },
      };
    // Записи компонентов в центральной базе — ссылки на их базы: остаются
    // только контракты, которые лежат в ней самой.
    const contracts = (central.contracts ?? []).filter(
      (c) => c && typeof c === 'object' && !('$devcontourComponentObject' in c),
    );
    return {
      engine: { leader: central.leader, runs: central.runs ?? [], contracts },
      check: {
        id: 'state',
        status: 'not-checked',
        detail: `${pending}; проверены только роль controller, попытки и контракты центральной базы`,
      },
    };
  }
  const {
    value: state,
    failure,
    settled,
  } = settledRead(() => {
    const store = new Store(file, components, false, undefined, true);
    try {
      const state = store.read();
      return {
        state,
        newState: newStateOf(store, state, root),
        appliedKeys: store.localRecord<AppliedConfigKeys>(
          APPLIED_KEYS_NAMESPACE,
          undefined,
          APPLIED_KEYS_KEY,
        ),
        calls: store
          .localEntries<UsageRecord>('usage')
          .map(({ value: { runtime, model, startedAt, costSource, outcome } }) => ({
            runtime,
            model,
            startedAt,
            costSource,
            outcome,
          })),
      };
    } finally {
      store.close();
    }
  });
  if (state && settled) return state;
  return {
    check: {
      id: 'state',
      status: 'blocked',
      detail: settled ? `Состояние не читается: ${message(failure)}` : restless,
    },
  };
}

export async function doctor(
  config: Config,
  root: string,
  probe = false,
  state?: Pick<DevContourState, 'leader' | 'runs'> &
    Partial<Pick<DevContourState, 'contracts' | 'appliedConfig' | 'tasks'>> & {
      /** Digest ключей применённой конфигурации — `doctorState`. */
      appliedKeys?: AppliedConfigKeys;
    },
  stateCheck?: Check,
  calls?: DoctorCall[],
  newState?: Check,
) {
  const checks: Check[] = [];
  if (stateCheck) checks.push(stateCheck);
  if (state) checks.push(engineCheck(state));
  if (newState) checks.push(newState);
  const check = async (id: string, action: () => Promise<string>) => {
    try {
      checks.push({ id, status: 'passed', detail: await action() });
    } catch (e) {
      checks.push({ id, status: 'blocked', detail: e instanceof Error ? e.message : String(e) });
    }
  };
  await check('config', async () => {
    validateWorkflow(config);
    return 'Графы и профили согласованы';
  });
  // config.json прежней версии хранил рядом со ссылкой на файл компонента
  // полную копию его полей. Теперь действует только файл, и значение, которое
  // раньше молча бралось из копии, оператор должен увидеть.
  for (const copy of ignoredComponentCopies.get(config) ?? [])
    checks.push({
      id: `component-copy:${copy.repositoryId}`,
      status: 'degraded',
      detail: `config.json хранит копию полей компонента, которая расходится с ${copy.file} и не применяется: ${copy.keys.join(', ')}. Действует файл компонента. Чтобы вернуть прежнее поведение, впишите эти ключи в файл компонента (значения — из копии в config.json) или объявите их для репозитория в workspace.json; значения профиля workspace-init дописывает в файл сам при обновлении профиля (поднятая version). Затем выполните workspace-init --file <реестр workspace.json>: он уберёт копию.`,
    });
  // Роли берутся объявленные, а не только workspace-уровня: роль, добавленную
  // компонентом, doctor иначе не проверил бы вовсе.
  const bindings = repositories(config).flatMap((repo) =>
    declaredRoles(config, repo.id).flatMap((role) =>
      [false, true].map((review) => ({
        repo,
        role,
        review,
        binding: review
          ? reviewerBinding(config, role, repo.id)
          : roleBinding(config, role, repo.id),
      })),
    ),
  );
  // Назначение ролей: кто пишет, кто проверяет и по какому правилу вендора.
  // Ревьюер того же вендора возможен только явным разрешением — doctor
  // называет его прямо, а не подразумевает «другой вендор».
  for (const repo of repositories(config))
    for (const role of declaredRoles(config, repo.id)) {
      const writer = roleBinding(config, role, repo.id),
        reviewer = reviewerBinding(config, role, repo.id);
      const rule = codeReviewVendor(config, role, repo.id);
      const same = writer.runtime === reviewer.runtime;
      checks.push({
        id: `role:${repo.id}:${role}`,
        status:
          same && rule !== 'same-vendor-allowed' && config.mode !== 'demo' ? 'blocked' : 'passed',
        detail:
          `writer ${bindingLabel(writer)} → reviewer ${bindingLabel(reviewer)}; правило вендора: ${rule}` +
          (same ? ' (ревью тем же вендором)' : ''),
      });
    }
  // Тарифы и бюджеты: что действует и где стоимость останется неизвестной.
  checks.push(...budgetChecks(config, calls, workspaceDeclaration(config)));
  const pending = appliedCheck(config, state);
  if (pending) checks.push(pending);
  for (const kind of ['plan', 'contract'] as const)
    checks.push({
      id: `review:${kind}`,
      status: 'passed',
      detail: (['codex', 'claude'] as const)
        .map((author) => {
          const chosen = technicalReviewer(config, kind, author);
          return `автор ${author} → ${chosen ? chosen.runtime + (chosen.sameVendor ? ' (тот же вендор)' : '') : 'отказ правила вендора'}`;
        })
        .join('; '),
    });
  // Независимое ревью, которое может только читать diff, слабее ревью,
  // которое может запустить проверки. Право даётся профилем инструментов, и
  // разойтись оно может незаметно: раньше codex-ревьюер получал shell по
  // умолчанию, а claude-ревьюер — нет. Doctor называет это прямо.
  for (const { repo, role, review, binding } of bindings.filter((b) => b.review)) {
    const profile = toolProfileFor(config, binding.runtime, role, review, repo.id);
    const runsChecks = reviewerRunsChecks(binding.runtime, profile);
    // Профиля нет вовсе — это не выбор оператора, а умолчание: codex-ревьюер
    // без профиля получает shell, claude-ревьюер — нет. Смена ревьюера с codex
    // на claude молча ослабляла ревью, поэтому строка называет исправление.
    const implicit = !profile && binding.runtime === 'claude';
    const name = binding.toolProfile ?? `${binding.runtime}-review`;
    const fix =
      binding.runtime === 'claude'
        ? implicit
          ? `Объявите toolProfiles["${name}"] = { "runtime": "claude", "claudeTools": ["Read", "Glob", "Grep", "Bash"] } или задайте ревьюеру toolProfile с Bash в claudeTools.`
          : `Если отказ не намеренный, добавьте Bash в claudeTools профиля ${name}.`
        : `Если отказ не намеренный, уберите codexShell: false в профиле ${name}.`;
    checks.push({
      id: `reviewer:${repo.id}:${role}`,
      status: runsChecks ? 'passed' : implicit ? 'degraded' : 'not-checked',
      detail: runsChecks
        ? `${binding.runtime} может выполнить проверки при ревью — в песочнице ОС без сети и без записи в проверяемый каталог`
        : `${binding.runtime} проверяет только чтением: ${implicit ? 'профиля инструментов ревьюера нет, а без него claude не получает Bash (codex-ревьюер на его месте запускал бы проверки)' : 'профиль не даёт запускать команды'}. Ревью не обнаружит то, что видно лишь прогоном. ${fix}`,
    });
  }
  // Исполнитель без shell пишет вслепую: не запускает ни тесты, ни проверку
  // типов и узнаёт о провале только от гейтов после попытки. На пилоте так
  // прошли все попытки сложной задачи — таймауты и круги находок ревью, хотя
  // каждую из них исполнитель поймал бы сам первым же прогоном теста.
  for (const { repo, role, binding } of bindings.filter((b) => !b.review)) {
    if (binding.runtime === 'demo') continue;
    const profile = toolProfileFor(config, binding.runtime, role, false, repo.id);
    // То же правило, что у адаптера: shell по умолчанию есть, явный отказ
    // профиля соблюдается. Раньше codex-исполнитель считался способным
    // запускать команды всегда, хотя codexShell: false выключал ему shell.
    const runsChecks = writerRunsChecks(binding.runtime, profile);
    const fix =
      binding.runtime === 'codex'
        ? 'уберите codexShell: false'
        : 'добавьте Bash в claudeTools или уберите claudeTools, чтобы действовал набор по умолчанию';
    checks.push({
      id: `writer:${repo.id}:${role}`,
      status: runsChecks ? 'passed' : 'not-checked',
      detail: runsChecks
        ? `${binding.runtime} может запускать тесты и проверки во время реализации — в песочнице ОС`
        : `${binding.runtime} пишет код вслепую: профиль инструментов явно не даёт shell, и тесты исполнитель не запустит. Если отказ не намеренный, ${fix} в профиле ${binding.toolProfile ?? binding.runtime}.`,
    });
  }
  const runtimes = new Set(bindings.map((b) => b.binding.runtime));
  for (const runtime of ['git', ...runtimes].filter((s) => s !== 'demo'))
    await check('cli:' + runtime, async () => {
      await executable(runtime);
      const r = await command([runtime, '--version'], config.repository, { timeoutMs: 10000 });
      if (r.code) throw new Error('CLI --version завершился с ошибкой');
      return r.stdout.trim().slice(0, 200);
    });
  // `--version` проходит и у неавторизованного CLI: он доказывает, что файл
  // на месте, а не что им можно работать. Отказ авторизации выяснялся только
  // на первой выданной задаче — прогоном, который тратил время и попытку.
  // Проверяется то самое окружение, которое получит исполнитель.
  if (probe)
    for (const runtime of [...runtimes].filter((s) => s !== 'demo'))
      await check('auth:' + runtime, async () => {
        const execution = agentEnvironment(config, toolProfileFor(config, runtime));
        const argv =
          runtime === 'claude'
            ? ['claude', '--print', '--setting-sources', '', 'ping']
            : ['codex', 'exec', '--sandbox', 'read-only', '-c', 'approval_policy="never"', 'ping'];
        const r = await command(argv, config.repository, { ...execution, timeoutMs: 120000 });
        const output = r.stdout + r.stderr;
        if (
          r.code ||
          /not logged in|please run \/login|invalid api key|credit balance/i.test(output)
        )
          throw new Error(
            `Runtime не авторизован в окружении прогона: ${output.trim().slice(-200) || 'код ' + r.code}`,
          );
        return 'Авторизован в том окружении, которое получит исполнитель';
      });
  // Область записи — пересечение роли и задачи. Роль без неё не ограничивает
  // ничего, и всё держится на том, что область указана у каждой задачи. Роль,
  // владеющая сквозными решениями, оказывается при этом самой широкой — это
  // стоит видеть, а не обнаруживать по принятому diff.
  // Инструкция, по которой написан код, — часть договора. Библиотека DevContour
  // живёт своей жизнью: её пакет обновляется, а копия в проекте остаётся. Молча
  // подменять нельзя, молчать о расхождении — тоже: проект узнал бы о нём на
  // ревью, когда код уже не отвечает правилам.
  // Проверки исполняются в песочнице ОС. Без её механизма они не запустятся —
  // об этом лучше узнать здесь, а не на первой задаче.
  await check('isolation', async () => {
    if (config.isolation.mode === 'none')
      return 'Изоляция проверок снята явно (isolation.mode: none): проверки идут процессом хоста';
    const support = isolationSupport();
    if (!support.ok) throw new Error(support.detail + '. Или явно задайте isolation.mode: none');
    return (
      'Проверки, исполнитель и ревьюер — в песочнице ОС' +
      (support.detail ? `; ${support.detail}` : '')
    );
  });
  const network = await installNetworkCheck(config);
  if (network) checks.push(network);
  const gateTimeouts = gateTimeoutCheck(config, state?.tasks ?? []);
  if (gateTimeouts) checks.push(gateTimeouts);
  checks.push(checkoutsCheck(config, root));
  // Механизм на месте ещё не значит, что gate установки в нём пройдёт:
  // песочница всегда закрывает часть путей и внутри worktree. Проба ставит
  // зависимость с каталогом IDE на чистом дереве в той же песочнице.
  if (probe && config.isolation.mode === 'os' && isolationSupport().ok)
    checks.push({
      id: 'isolation:install',
      // Сбой самой пробы (tar, запуск песочницы) — тоже отказ проверки, а не
      // падение всего doctor.
      ...(await installProbe(config, root).catch((e: unknown) => ({
        status: 'blocked' as const,
        detail:
          'Проба установки в песочнице не выполнилась: ' +
          (e instanceof Error ? e.message : String(e)),
      }))),
    });
  if (config.preview)
    await check('preview', async () => {
      const docker = await command(['docker', 'info', '--format', '{{.ServerVersion}}'], root);
      if (docker.code !== 0)
        throw new Error(
          'Docker недоступен: preview не соберётся и не запустится. ' +
            docker.stderr.trim().slice(0, 200),
        );
      const compose = await command(['docker', 'compose', 'version', '--short'], root);
      if (compose.code !== 0) throw new Error('Нет docker compose: preview собирается через него');
      return `Docker ${docker.stdout.trim()}, compose ${compose.stdout.trim()}; URL http://127.0.0.1:${config.preview!.port}`;
    });
  await check('context-library', async () => {
    const stale = (
      await Promise.all(
        repositories(config).map((repo) =>
          outdatedContextPacks(
            repo.path,
            config.contextPacks.filter((pack) => pack.repositoryId === repo.id),
          ),
        ),
      )
    ).flat();
    if (!stale.length) return 'Пакеты контекста совпадают с библиотекой';
    return `Библиотека ушла вперёд: ${stale
      .map((p) => `${p.id} ${p.version} → ${p.library}`)
      .join('; ')}. Решите: остаться на своей версии или перейти — context-adopt --pack <id>`;
  });
  await check('write-scope', async () => {
    const open = bindings
      .filter((b) => !b.review && !roleBinding(config, b.role, b.repo.id)?.writePaths?.length)
      .map((b) => `${b.repo.id}:${b.role}`);
    if (open.length)
      return `Область записи задаётся только задачами у ролей: ${[...new Set(open)].join(', ')}`;
    return 'У каждой роли объявлена область записи';
  });
  await check('environment', async () => {
    executionEnvironment([config.environment]);
    return 'Обязательные переменные заданы; значения скрыты';
  });
  for (const { repo, role, review, binding } of bindings)
    await check(`tools:${repo.id}:${role}:${review ? 'review' : 'write'}`, async () => {
      const profile = toolProfileFor(config, binding.runtime, role, review, repo.id);
      agentEnvironment(config, profile);
      for (const server of Object.values(profile?.mcp ?? {}))
        if (server.command) await executable(server.command);
      return profile
        ? 'Профиль и переменные MCP доступны; соединение проверяет project preflight'
        : 'Штатный CLI без явно заданного профиля MCP';
    });
  for (const repo of repositories(config)) {
    await check('repository:' + repo.id, async () => {
      if (
        (await realpath(repo.path)) !==
        (await realpath(await git(repo.path, 'rev-parse', '--show-toplevel')))
      )
        throw new Error('Ожидается корень Git');
      await git(repo.path, 'rev-parse', '--verify', 'HEAD');
      await git(repo.path, 'check-ref-format', '--branch', repo.targetBranch);
      const common = resolve(repo.path, await git(repo.path, 'rev-parse', '--git-common-dir'));
      try {
        const owner = JSON.parse(await readFile(join(common, 'devcontour-owner.json'), 'utf8'));
        if (
          owner.owner !== (await realpath(root)) ||
          owner.repositoryId !== repo.id ||
          owner.targetBranch !== repo.targetBranch
        )
          throw new Error('Репозиторий принадлежит другому workspace');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (
        (await git(repo.path, 'worktree', 'list', '--porcelain'))
          .split('\n')
          .includes(`branch refs/heads/${repo.targetBranch}`)
      )
        throw new Error('Ветка интеграции открыта в worktree');
      executionEnvironment([config.environment, repo.environment]);
      for (const step of [
        ...repo.gates,
        ...(repo.prepare ?? []),
        ...(repo.dependencyBuild ?? []),
        ...(repo.preflight ?? []),
        ...(repo.lifecycle?.setup ?? []),
        ...(repo.lifecycle?.ready ?? []),
        ...(repo.lifecycle?.teardown ?? []),
      ])
        if (!step.command[0].includes('/') || isAbsolute(step.command[0]))
          await executable(step.command[0]);
      return 'Git, окружение и исполняемые команды доступны';
    });
    if (repo.forge)
      await check('forge:' + repo.id, async () => {
        await git(repo.path, 'check-ref-format', '--branch', repo.forge!.targetBranch);
        await git(repo.path, 'remote', 'get-url', repo.forge!.remote);
        const connection = config.forgeConnections[repo.forge!.connection];
        if (!connection) throw new Error('Не настроен forge connection');
        if (connection.tokenEnv && !process.env[connection.tokenEnv])
          throw new Error('Не задан read-only token: ' + connection.tokenEnv);
        if (probe) {
          const store = new Store(':memory:');
          try {
            await forgeAdapter(connection, new DevContour(store, config)).observe(
              repo,
              'devcontour-doctor-nonexistent',
              AbortSignal.timeout(30000),
            );
          } finally {
            store.close();
          }
        }
        return probe
          ? 'Read-only forge доступен; запись не выполнялась'
          : 'Конфигурация доступна; сеть не проверена';
      });
    if (probe && repo.preflight?.length)
      await check('probe:' + repo.id, async () => {
        // Рабочее дерево пробы — под корнем рабочих деревьев workspace (в
        // embedded-размещении каталог состояния внутри репозитория);
        // журналы окружения и preflight — в каталоге состояния.
        const runId = randomUUID(),
          dir = join(root, 'doctor', runId),
          cwd = checkoutPath(
            checkoutRootFor(config, root),
            join(dir, repo.id),
            repo.id,
            'doctor',
            runId,
          );
        await mkdir(dir, { recursive: true });
        await mkdir(dirname(cwd), { recursive: true });
        const sha = await git(repo.path, 'rev-parse', 'HEAD');
        await git(repo.path, 'worktree', 'add', '--detach', cwd, sha);
        try {
          await withResources(
            config,
            repo.gates.flatMap((g) => g.resources ?? []),
            `doctor:${runId}`,
            AbortSignal.timeout(config.runTimeoutMs),
            async (signal, resources) => {
              const execution = executionEnvironment([config.environment, repo.environment], {
                DEVCONTOUR_REPOSITORY_ID: repo.id,
                DEVCONTOUR_RUN_ID: runId,
                DEVCONTOUR_RESOURCES_JSON: JSON.stringify(resources),
              });
              await withEnvironment(
                repo.lifecycle,
                cwd,
                join(dir, 'environment'),
                execution,
                signal,
                () => runSteps(repo.preflight!, cwd, join(dir, 'preflight'), execution, signal),
              );
            },
          );
          return 'Project preflight прошёл в отдельном worktree';
        } finally {
          // Keep failed environments for explicit cleanup instead of deleting their scripts.
          let clean = true;
          try {
            clean =
              JSON.parse(await readFile(join(dir, 'environment', 'environment.json'), 'utf8'))
                .status === 'cleaned';
          } catch {
            /* no lifecycle */
          }
          if (clean) await git(repo.path, 'worktree', 'remove', '--force', cwd);
        }
      });
  }
  // Утверждённые контракты не отзываются задним числом: незащищённый helper
  // закреплённой приёмки — предупреждение, а не блокировка. Новая редакция
  // с ним отклоняется до ревью (review-contract, contract-change).
  checks.push(...(await contractClosureChecks(config, state?.contracts ?? [])));
  checks.push(...contractSizeChecks(state?.contracts ?? []));
  // Состояние прочитано не полностью: контракты баз компонентов не видны, и
  // отсутствие находок закрепления ничего не доказывает.
  if (stateCheck)
    checks.push({
      id: 'contract-closure:unread',
      status: 'not-checked',
      detail:
        'Состояние прочитано не полностью (проверка state): закрепление контрактов, которых doctor не прочитал, не проверено',
    });
  if (config.contextPacks.length)
    await check('context', async () => {
      for (const role of declaredRoles(config))
        await taskContext(config, {
          role,
          contextPacks: config.contextPacks.map((p) => p.id),
        } as Parameters<typeof taskContext>[1]);
      return 'Закреплённые инструкции доступны и совпадают с digest';
    });
  for (const dir of [
    join(root, 'artifacts'),
    join(root, 'workspace-checks'),
    join(root, 'doctor'),
    ...(config.storage === 'component'
      ? repositories(config).map((r) => join(r.path, '.devcontour-local/artifacts'))
      : []),
  ]) {
    let files: string[] = [];
    try {
      files = await readdir(dir, { recursive: true });
    } catch {
      /* no receipts */
    }
    for (const file of files.filter((p) => p.endsWith('environment.json')))
      await check(`cleanup:${dir}/${file}`, async () => {
        const receipt = JSON.parse(await readFile(join(dir, file), 'utf8'));
        if (receipt.status !== 'cleaned')
          throw new Error(
            'Есть незавершённое окружение; проверьте владельца и выполните environment-cleanup',
          );
        return 'Окружение очищено';
      });
  }
  checks.push({
    id: 'live-models',
    status: 'not-checked',
    detail:
      'Модели не вызываются. Авторизация и реальная работа инструментов подтверждаются отдельным пилотом.',
  });
  // Компоненты без preflight: с --probe подсказка называет их, а не тот же
  // запуск doctor --probe, который уже выполнен.
  const unprobed = repositories(config)
    .filter((r) => !r.preflight?.length)
    .map((r) => r.id);
  if (!probe || unprobed.length)
    checks.push({
      id: 'project-probes',
      status: 'not-checked',
      detail: probe
        ? `doctor --probe выполнен, но у компонентов без preflight проверять нечего: ${unprobed.join(', ')}. Настройте для них preflight команд установки/доступов/MCP и повторите doctor --probe. Отсутствующие проверки не считаются PASS.`
        : 'Настройте preflight команд установки/доступов/MCP и выполните doctor --probe. Отсутствующие проверки не считаются PASS.',
    });
  const result = {
    scope: probe ? 'configured-probes' : 'static',
    ready: doctorReady(checks),
    checks,
  };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'doctor.json'), JSON.stringify(result, null, 2));
  return result;
}

/**
 * Где лежат рабочие деревья попыток и проверок (`checkout-root.ts`). Каталог
 * состояния закрыт песочнице целиком: checkout внутри него (или внутри
 * репозитория) упирает инструменты, которые ищут конфигурацию вверх по
 * дереву, в EPERM. Кэш на другом томе, чем репозиторий, оставляет деревья на
 * прежнем месте — работать можно, но этот EPERM остаётся; исправление —
 * `checkoutRoot` на томе репозитория. Корень, который harness отклоняет
 * (внутри репозитория, каталога состояния или закрытого пути), — блокировка:
 * исполнение с ним не начнётся.
 */
export function checkoutsCheck(config: Config, root: string): Check {
  let choice;
  try {
    // Диагностика каталогов кэша не создаёт.
    choice = checkoutRootFor(config, root, false);
  } catch (error) {
    if (!(error instanceof CheckoutRootError)) throw error;
    return { id: 'checkouts', status: 'blocked', detail: error.message };
  }
  // Прежнее место с пояснением — кэш пользователя отклонён (другой том,
  // ссылка, чужой владелец, кэш внутри закрытого пути).
  if (choice.placement === 'cross-volume' || (choice.placement === 'in-place' && choice.note))
    return {
      id: 'checkouts',
      status: 'degraded',
      detail: `Рабочие деревья остаются в каталоге состояния: ${choice.note ?? 'кэш пользователя на другом томе'}. Инструменты, ищущие конфигурацию вверх по дереву (browserslist, Metro, postcss, tsconfig), в песочнице получат EPERM. Задайте checkoutRoot (абсолютный путь на томе репозитория) в config.json.`,
    };
  return {
    id: 'checkouts',
    status: 'passed',
    detail:
      choice.placement === 'cache'
        ? `Рабочие деревья попыток и проверок — вне дерева, в кэше пользователя ${choice.root}`
        : choice.placement === 'configured'
          ? `Рабочие деревья попыток и проверок — в заданном checkoutRoot ${choice.root}`
          : `Рабочие деревья попыток и проверок — в каталоге состояния ${root}`,
  };
}

/**
 * Действующие контракты у предела размера документа. Контракт растёт
 * поправками от этапа к этапу, а предел обнаруживался только отказом
 * следующей редакции на review-contract. Предупреждение — с порога
 * `contractSize`; готовность не снимает.
 */
export function contractSizeChecks(contracts: DevContourState['contracts']): Check[] {
  return (
    contracts
      // doctor читает состояние до разбора схемой: запись без текста документа
      // (незавершённая или чужой формы) не мерится, а не роняет весь doctor.
      .filter((c) => typeof c.content === 'string' && !supersededBy(contracts, c.id))
      .flatMap((c) => {
        const size = contractSize(c.content);
        // Текст отказа регистрации («не будет зарегистрирован») здесь неверен:
        // контракт уже зарегистрирован и действует, отказ получит следующая
        // редакция.
        const detail = size.refusal
          ? `документ — ${thousands(size.chars)} знаков при пределе ${thousands(size.max)}, длиннее на ${thousands(size.chars - size.max)}. Контракт зарегистрирован и действует, но следующая его редакция будет отклонена до ревью. ${CONTINUATION}.`
          : size.warning;
        return detail
          ? [
              {
                id: `contract-size:${c.id}`,
                status: 'degraded' as const,
                detail: `Контракт ${c.id} (${c.title}${c.source ? `, ${c.source}` : ''}): ${detail}`,
              },
            ]
          : [];
      })
  );
}

/**
 * Локальные зависимости закреплённых артефактов действующих контрактов,
 * которые не закреплены и не защищены: правкой их исполнитель ослабил бы
 * приёмку без нового ревью. Проверяется ревизия закрепления; защита —
 * текущие protectedPaths компонента.
 */
export async function contractClosureChecks(
  config: Config,
  contracts: DevContourState['contracts'],
): Promise<Check[]> {
  const out: Check[] = [];
  let checked = 0;
  for (const c of contracts) {
    if (!c.artifacts?.length || supersededBy(contracts, c.id)) continue;
    const byRepo = new Map<string, typeof c.artifacts>();
    for (const a of c.artifacts)
      byRepo.set(a.repositoryId, [...(byRepo.get(a.repositoryId) ?? []), a]);
    for (const [repositoryId, artifacts] of byRepo) {
      let detail: string | undefined;
      try {
        const { unguarded } = await artifactGuard(
          repository(config, repositoryId),
          artifacts,
          c.underTest ?? [],
        );
        if (unguarded.length) detail = unguardedMessage(unguarded);
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e);
      }
      checked++;
      if (detail)
        out.push({
          id: `contract-closure:${c.id}:${repositoryId}`,
          status: 'not-checked',
          detail: `Контракт ${c.id} (${c.title}) утверждён, но закрепление неполно. ${detail}. Исправление — новая редакция через contract-change.`,
        });
    }
  }
  if (checked && !out.length)
    out.push({
      id: 'contract-closure',
      status: 'passed',
      detail: `Локальные зависимости закреплённых артефактов закреплены или защищены (${checked})`,
    });
  return out;
}
