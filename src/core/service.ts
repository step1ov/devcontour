import { readFileSync, realpathSync } from 'node:fs';
import {
  developmentBinding,
  assertFeatureOf,
  assertTaskFeature,
  assertTaskPreparation,
} from './preparation.ts';
import { validateTaskContext, validateWorkflow } from './workflow.ts';
import { entityId } from './ids.ts';
import { createHash, randomUUID } from 'node:crypto';
import { reusableImplementation } from './reuse.ts';
import {
  repository,
  repositories,
  roleBinding,
  reviewerBinding,
  requiresContract,
  expandGates,
} from './repositories.ts';
import { Store } from './store.ts';
import { failureFingerprint, TaskFailure, type FailureKind } from './failure.ts';
import { taskEvidence, unprovenReason } from './proof.ts';
import { assertTaskProperties, effectiveChecks, type CheckDeclaration } from './checks.ts';
import {
  afterFailure,
  afterSuccess,
  blocksClaim,
  closeIfBasisChanged,
  episodeBasis,
  recoveryActions,
  type PropertyRecovery,
  type RecoveryDecision,
} from './property-recovery.ts';
import { planResult } from './plan.ts';
import { boardOwner, completion, receiptRecordBytes } from './sync-state.ts';
import { maxRecordBytes } from './sync-model.ts';
import { carriedTaskIds } from './work-status.ts';
import { blockingBudget, taskBudgets, usageRecords } from './budget.ts';
import { assertDag, descendants, readyTasks, latestTaskId, impactGraph } from './graph.ts';
import {
  DomainError,
  requireValue,
  taskInput,
  discoveryInput,
  type Contract,
  type ContractArtifact,
  type Reproduction,
  type Task,
  type DevContourState,
  type Config,
  type Evidence,
  type Run,
  type Approval,
} from './model.ts';
export const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
/** Область проверок задачи: её gates и потребители, как они записаны в постановке. */
export const scopeDigest = (t: Pick<Task, 'gates' | 'consumers'>) =>
  digest({ gates: t.gates ?? [], consumers: t.consumers ?? [] });
export const specDigest = (t: Task) =>
  digest({
    ...(t.preparation ? { preparation: t.preparation } : {}),
    ...(t.repositoryId && t.repositoryId !== 'main' ? { repositoryId: t.repositoryId } : {}),
    ...(t.requirements?.length ? { requirements: t.requirements } : {}),
    title: t.title,
    description: t.description,
    role: t.role,
    dependsOn: t.dependsOn,
    acceptance: t.acceptance,
    ...(t.scope === 'workspace'
      ? { scope: t.scope, relatedRepositories: t.relatedRepositories }
      : {}),
    contracts: t.contracts,
    contractDigests: t.contractDigests,
    ...(t.contextPacks?.length ? { contextPacks: t.contextPacks } : {}),
    ...(t.writePaths?.length ? { writePaths: t.writePaths } : {}),
    ...(t.resources?.length ? { resources: t.resources } : {}),
    ...(t.finding ? { finding: t.finding } : {}),
    // Область задачи в договоре проверки — часть утверждаемого: включение
    // механизма для задачи проходит обычное ревью плана.
    ...(t.properties?.length ? { properties: t.properties } : {}),
  });
/**
 * Digest контракта: документ и, если объявлены, нормативные артефакты —
 * путь, назначение и содержимое. Контракт без артефактов сохраняет прежний
 * digest текста, и утверждённые раньше задачи остаются действительными.
 */
export function contractDigest(
  content: string,
  artifacts: ContractArtifact[] | undefined,
  /**
   * Формула закрепления записи — всегда явно. Значение по умолчанию здесь
   * опасно: явно переданный undefined тоже получил бы его, и запись первой
   * формулы проверялась бы по второй.
   */
  pinVersion: 2 | undefined,
  /**
   * Договор проверки входит в digest, если объявлен: изменённое обязательство,
   * покрытие или политика расширения — другой договор. Без него формула
   * прежняя, и утверждённые раньше контракты остаются действительными.
   */
  checks?: CheckDeclaration,
) {
  if (checks)
    return digest({
      content,
      artifacts: (artifacts ?? []).map((a) => ({
        repositoryId: a.repositoryId,
        path: a.path,
        purpose: a.purpose,
        blob: a.blob,
        digest: a.digest,
      })),
      checks,
    });
  return artifacts?.length
    ? digest({
        content,
        artifacts: artifacts.map((a) => ({
          repositoryId: a.repositoryId,
          path: a.path,
          purpose: a.purpose,
          // Blob — часть закрепления: подменённый blob при прежнем digest
          // содержимого даёт другой digest контракта. Первая формула его не
          // включала; её записи сверяются с Git при импорте.
          ...(pinVersion === 2 ? { blob: a.blob } : {}),
          digest: a.digest,
        })),
      })
    : digest(content);
}
/**
 * Тот же ли это договор: текст и закреплённые файлы совпадают. Сравнение — по
 * blob, а не по digest: у записей разных формул digest разный при одном и том
 * же содержимом.
 */
export function samePin(
  c: Contract,
  content: string,
  artifacts: ContractArtifact[],
  checks?: CheckDeclaration,
) {
  const pinned = c.artifacts ?? [];
  return (
    c.content === content &&
    JSON.stringify(c.checks ?? null) === JSON.stringify(checks ?? null) &&
    pinned.length === artifacts.length &&
    pinned.every((a) =>
      artifacts.some(
        (b) =>
          b.path === a.path &&
          b.blob === a.blob &&
          b.purpose === a.purpose &&
          b.repositoryId === a.repositoryId,
      ),
    )
  );
}
/**
 * Более поздняя утверждённая редакция того же контракта. Каждое утверждение
 * создаёт новый id, и задача, привязанная к прежнему, проходила утверждение и
 * запускалась на старом тексте, хотя в дереве уже лежала новая редакция того
 * же файла. Редакции одного контракта — один источник в одном репозитории.
 */
export function supersededBy(contracts: Contract[], id: string): Contract | undefined {
  // Реестр только дополняется, поэтому порядок в нём — порядок утверждения;
  // отметки времени в пределах миллисекунды совпадают.
  const at = contracts.findIndex((x) => x.id === id);
  const c = contracts[at];
  if (!c?.source) return undefined;
  return contracts
    .slice(at + 1)
    .findLast(
      (x) => x.source === c.source && (x.repositoryId ?? 'main') === (c.repositoryId ?? 'main'),
    );
}
const now = () => new Date().toISOString();
const task = (s: DevContourState, id: string) =>
  requireValue(
    s.tasks.find((t) => t.id === id),
    `Задача ${id} не найдена`,
  );
const board = (s: DevContourState, id: string) =>
  requireValue(
    s.boards.find((b) => b.id === id),
    `Доска ${id} не найдена`,
  );
function activeRevision(s: DevContourState, id: string) {
  const b = board(s, id);
  const r = b.revisions.at(-1)!;
  if (r.status !== 'active') throw new DomainError('Доска принята. Создайте корректировку.');
  return r;
}
const HEARTBEAT_FAILED = 'Продление владения не удалось';
/**
 * То, что ревьюер видел о зависимости вне предложения: постановка, статус,
 * гейты и принятый SHA. Гейты в specDigest не входят — они часть политики, —
 * но ревьюер их видел, и их смена меняет то, на что опирается план.
 */
export const dependencyDigest = (t: Task) =>
  digest({ spec: specDigest(t), status: t.status, gates: t.gates, resultSha: t.resultSha });
/** Смысловые данные задачи, показанной ревью плана как контекст. */
export const contextDigest = (t: Task) =>
  digest({
    spec: specDigest(t),
    gates: t.gates,
    resultSha: t.resultSha,
    cancelled: t.status === 'cancelled',
  });
/**
 * Задача принятой ревизии неизменяема: следующий этап и корректировка несут
 * её как принятую работу. Вернуть её в работу (reopen, retry) значило бы
 * переписать принятое и заново отменять уже учтённое — повторная отмена
 * такой задачи выглядела бы исторической, и workflow её не замечал. Работа
 * возвращается в этап новой задачей.
 */
function assertNotAccepted(s: DevContourState, t: Task) {
  for (const b of s.boards)
    for (const r of b.revisions)
      if (r.status === 'accepted' && r.taskIds.includes(t.id))
        throw new DomainError(
          `${t.id} входит в принятую ревизию ${r.number} доски «${b.title}»; верните работу в этап новой задачей`,
          409,
        );
}
/**
 * Digest фактически загруженной конфигурации: главный `config.json`,
 * component config каждого компонента и разрешённые пути. Им сверяются
 * перезакрепление, запрос применения и действующая конфигурация процесса —
 * digest одного главного файла не закреплял бы gates компонентов.
 */
export const loadedDigest = (config: Config) => digest(config);
/**
 * Откуда конфигурация загружена: файлы (`config.json` и component config) —
 * путь в том виде, как его задали, разрешённая при загрузке цель и хэш именно
 * тех байтов, которые загрузчик разобрал, — и digest самой конфигурации в
 * момент загрузки. Ставит `loadConfig`; конфигурации, собранные в памяти,
 * источника не имеют.
 */
export type ConfigSourceFile = { path: string; real: string; sha: string; dir?: true };
export const configSources = new WeakMap<Config, { files: ConfigSourceFile[]; digest: string }>();
export const bytesDigest = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * Файлы, из которых загружена конфигурация, сейчас содержат ровно те байты,
 * что разобрал загрузчик. Сверяется содержимое, а не mtime и размер: их
 * сохраняют копирование и перезапись тем же размером.
 */
/**
 * Происхождение конфигурации процесса: источник, если объект при создании
 * процесса (или при `reconfigure`) совпадал со своим digest на момент
 * загрузки; иначе — причина, почему его нет. Фиксируется один раз: процесс
 * свою конфигурацию в памяти не меняет, а актуальность сверяется по digest,
 * снятому тогда же.
 */
function provenanceOf(config: Config): ConfigSource | string {
  const source = configSources.get(config);
  if (!source) return 'конфигурация собрана в памяти, источника нет';
  if (loadedDigest(config) !== source.digest)
    return 'конфигурация изменена в памяти после загрузки';
  return source;
}
type ConfigSource = { files: ConfigSourceFile[]; digest: string };
function sourceUnchanged(
  provenance: ConfigSource | string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof provenance === 'string') return { ok: false, reason: provenance };
  for (const file of provenance.files) {
    try {
      // Путь разрешается заново: переключённый symlink ведёт к другому файлу.
      if (realpathSync(file.path) !== file.real)
        return { ok: false, reason: `путь ${file.path} теперь ведёт к другому файлу` };
      if (file.dir) continue;
      if (bytesDigest(readFileSync(file.real, 'utf8')) !== file.sha)
        return { ok: false, reason: `файл ${file.path} изменился после загрузки` };
    } catch (error) {
      return { ok: false, reason: `файл ${file.path} не читается: ${String(error)}` };
    }
  }
  return { ok: true };
}
const staleMessage =
  'Процесс работает с устаревшей конфигурацией: контур уже применил другую; перезапустите процесс';

/**
 * Gates профиля компонентов доски, не прошедшие integration ни в одной её
 * задаче. Задача, доказывающая себя всем профилем, покрывает его целиком;
 * пробел возникает, только когда задачи сузили область, — и тогда приёмка
 * доски его называет. Совместная проверка workspace к этому не относится: её
 * `workspaceGates` область задачи не сокращает.
 */
export function uncoveredGates(config: Config, s: DevContourState, tasks: Task[]) {
  const result: { repositoryId: string; gates: string[] }[] = [];
  for (const repositoryId of [...new Set(tasks.map((t) => t.repositoryId))]) {
    const own = tasks.filter((t) => t.repositoryId === repositoryId);
    // Покрытие — по фактическому собственному evidence на принятом SHA
    // задачи, для любой области: задача без явной области выполнялась
    // профилем своего времени, и gate, добавленный позже, ею не покрыт.
    // Evidence потребителя — проверка другого компонента и не в счёт.
    const covered = new Set(
      own.flatMap((t) =>
        taskEvidence(s, t)
          .filter(
            (e) =>
              e.phase === 'integration' &&
              e.passed &&
              e.gate &&
              !e.consumer &&
              (!t.resultSha || e.sha === t.resultSha),
          )
          .map((e) => e.gate),
      ),
    );
    const missing = repository(config, repositoryId)
      .gates.map((g) => g.id)
      .filter((id) => !covered.has(id));
    if (missing.length) result.push({ repositoryId, gates: missing });
  }
  return result;
}

/**
 * Размер receipt принятого результата. Попытка, receipt которой не строится
 * (прежняя без восстановимой policy), здесь не отклоняется: это ограничение
 * переноса, а не приёмки.
 */
function receiptBytes(h: DevContour, s: DevContourState, t: Task) {
  let receipt;
  try {
    receipt = completion(h, s, t);
  } catch {
    return 0;
  }
  return receiptRecordBytes(receipt);
}
export class DevContour {
  constructor(
    readonly store: Store,
    /** Меняется только `reconfigure` — шагом операции, после drain. */
    public config: Config,
  ) {
    validateWorkflow(config);
    this.knownConfig = loadedDigest(config);
    this.provenance = provenanceOf(config);
  }
  /**
   * Применённая конфигурация в базе — единственный источник правды; у
   * процесса нет своего «поколения», которое мог бы рассинхронизировать
   * откат транзакции. Процесс текущий, только если его конфигурация совпадает
   * с применённой. Записать свою вместо применённой (перезапуск, CLI после
   * правки файла, когда сервера нет) он может, только если нет живого чужого
   * лидера и его файлы не менялись с загрузки — возврат файла к прежнему
   * содержимому тоже меняет mtime. Конфигурация без источника этого права не
   * имеет. Ошибка чтения файла не запоминается: следующая проверка повторит её.
   */
  private knownConfig: string;
  private provenance: ConfigSource | string;
  /** Digest конфигурации этого процесса. */
  get configDigest() {
    return this.knownConfig;
  }
  /** Owner, под которым этот процесс получил лидерство. */
  private ownLeader?: string;
  /** Может ли процесс записать свою конфигурацию как применённую (в транзакции). */
  private mayAdopt(s: DevContourState): { ok: true } | { ok: false; reason: string } {
    const leader = s.leader && s.leader.leaseUntil > Date.now() ? s.leader.owner : undefined;
    if (leader && leader !== this.ownLeader)
      return { ok: false, reason: `работает controller ${leader} с другой конфигурацией` };
    return sourceUnchanged(this.provenance);
  }
  private adoptConfig(s: DevContourState, by: string) {
    s.appliedConfig = {
      digest: this.knownConfig,
      generation: (s.appliedConfig?.generation ?? 0) + 1,
      at: now(),
      by,
    };
  }
  /** Процесс работает не с применённой конфигурацией и сменить её не вправе. */
  configStale(s: DevContourState) {
    const applied = s.appliedConfig;
    return !!applied && applied.digest !== this.knownConfig && !this.mayAdopt(s).ok;
  }
  /**
   * Применить новую конфигурацию в этом процессе. Только шаг операции
   * изменения контракта: она сверила digest, дождалась окончания работ и
   * держит паузу. Отличаться может только закрепление context packs — всё
   * остальное требует перезапуска процесса.
   */
  reconfigure(next: Config) {
    // Без перезапуска меняется только закрепление пакетов — их revision и
    // digest. Состав пакетов, их роли, файлы и версии — другая конфигурация.
    const rest = (c: Config) =>
      digest({
        ...c,
        contextPacks: c.contextPacks.map((pack) => ({
          ...pack,
          revision: undefined,
          digest: undefined,
        })),
      });
    if (rest(next) !== rest(this.config))
      throw new DomainError(
        'Новая конфигурация отличается не только закреплением context packs (revision и digest): примените её перезапуском сервера',
        409,
      );
    validateWorkflow(next);
    this.config = next;
    this.knownConfig = loadedDigest(next);
    this.provenance = provenanceOf(next);
  }
  /**
   * Пауза операции: ставится, только если очередь не остановлена, и
   * помечается операцией. Пауза человека не перезаписывается.
   */
  operationPause(operation: string) {
    return this.store.change('scheduler.paused', (s) => {
      if (s.paused) return;
      s.paused = true;
      s.pauseReason = 'reconfigure';
      s.pauseOperation = operation;
      s.pausedAt = now();
      return { paused: true, reason: 'reconfigure', operation };
    });
  }
  /**
   * Общий барьер принятия: в транзакции выдачи, завершения и приёмки
   * процесс сверяет свою конфигурацию с применённой контуром. Отставший
   * процесс не принимает ни попыток, ни совместных проверок, ни поставок, ни
   * планов — сравнение двух его же старых digest актуальности не доказывает.
   */
  assertCurrentConfig(s: DevContourState) {
    const applied = s.appliedConfig;
    if (!applied || applied.digest === this.knownConfig) return;
    const adoption = this.mayAdopt(s);
    if (!adoption.ok) throw new DomainError(`${staleMessage} (${adoption.reason})`, 409);
    // Первый процесс, действующий после законной правки файла без живого
    // controller: его конфигурация становится применённой в этой же
    // транзакции — откат отменит и её.
    this.adoptConfig(s, 'process');
  }
  /** Снять паузу операции — только свою; паузу человека она не трогает. */
  operationResume(operation: string) {
    return this.store.change('scheduler.started', (s) => {
      if (!s.paused || s.pauseReason !== 'reconfigure' || s.pauseOperation !== operation) return;
      s.paused = false;
      s.pauseReason = undefined;
      s.pauseOperation = undefined;
      s.pausedAt = undefined;
      return { paused: false, operation };
    });
  }
  /**
   * Запросить применение конфигурации с ожидаемым digest (идемпотентно).
   * Повтор той же операцией сбрасывает прежний отказ: файл могли исправить.
   */
  requestReconfigure(operation: string, configDigest: string) {
    return this.store.change('config.reconfigure-requested', (s) => {
      const current = s.reconfigure;
      if (current && current.operation === operation && current.digest === configDigest) {
        if (!current.error) return;
        s.reconfigure = { ...current, error: undefined };
        return { operation, digest: configDigest, retried: true };
      }
      if (current && current.operation !== operation && !current.appliedAt)
        throw new DomainError(
          `Конфигурацию уже применяет операция ${current.operation}; дождитесь её`,
          409,
        );
      s.reconfigure = { operation, digest: configDigest, requestedAt: now() };
      return { operation, digest: configDigest };
    });
  }
  /** Подтвердить применение или записать отказ с обоими digest. */
  settleReconfigure(operation: string, configDigest: string, by: string, error?: string) {
    return this.store.change('config.reconfigured', (s) => {
      const current = s.reconfigure;
      if (!current || current.operation !== operation || current.digest !== configDigest) return;
      if (current.appliedAt && !error) return;
      s.reconfigure = error
        ? { ...current, error }
        : { ...current, appliedAt: now(), appliedBy: by, error: undefined };
      if (!error)
        s.appliedConfig = {
          digest: configDigest,
          generation: (s.appliedConfig?.generation ?? 0) + 1,
          at: now(),
          by,
        };
      return { operation, digest: configDigest, ...(error ? { error } : { by }) };
    });
  }
  /**
   * Запуск процесса применяет его конфигурацию: перезапуск — штатный способ
   * сменить любые поля. Неприменённый запрос операции остаётся.
   */
  recordConfig(by: string) {
    return this.store.change('config.started', (s) => {
      // Только действующий controller: конкурирующий или неудачный запуск
      // не меняет применённую конфигурацию и не останавливает владельца.
      if (s.leader?.owner !== by || s.leader.leaseUntil <= Date.now()) return;
      if (s.appliedConfig?.digest === this.knownConfig) return;
      // Получение лидерства не узаконивает снимок, если файл менялся после
      // загрузки (например, операция уже применила новую конфигурацию):
      // такой процесс догоняет её, а не перезаписывает.
      if (s.appliedConfig && !this.mayAdopt(s).ok) return;
      this.adoptConfig(s, by);
      return { digest: this.knownConfig, by };
    });
  }
  /** Снять завершённый запрос операции. */
  clearReconfigure(operation: string) {
    return this.store.change('config.reconfigure-cleared', (s) => {
      if (s.reconfigure?.operation !== operation) return;
      s.reconfigure = undefined;
      return { operation };
    });
  }
  /**
   * Договор исполнения задачи. Изоляция входит в него: смена режима или
   * доменов посреди прогона — другие условия, и прежнее evidence не должно
   * выглядеть полученным в новых. `legacy` — тот же договор без изоляции,
   * как его считала прежняя версия; он нужен только чтобы восстановить
   * receipt уже завершённой задачи, не выдавая её за исполненную в песочнице.
   */
  /**
   * Договор исполнения попытки задачи: политика её компонента и, если задача
   * называет потребителей, политика каждого из них с раскрытым составом его
   * проверок. Смена команды или группы потребителя делает прежнюю попытку
   * устаревшей так же, как смена собственной.
   */
  taskPolicyDigest(t: Pick<Task, 'repositoryId' | 'consumers'>) {
    const own = this.policyDigest(t.repositoryId);
    if (!t.consumers?.length) return own;
    return digest({
      own,
      consumers: t.consumers.map((c) => ({
        repositoryId: c.repositoryId,
        policy: this.policyDigest(c.repositoryId),
        gates: expandGates(repository(this.config, c.repositoryId), c.gates),
      })),
    });
  }
  policyDigest(repositoryId = 'main', legacy = false) {
    const repo = repository(this.config, repositoryId);
    return digest({
      ...(legacy ? {} : { isolation: this.config.isolation }),
      ...(this.config.repositories.length
        ? { repositoryId, path: repo.path, targetBranch: repo.targetBranch }
        : {}),
      gates: repo.gates,
      // Определение групп входит в договор: изменённая группа — другой набор
      // проверок задачи, даже если её область не менялась.
      ...(repo.gateGroups ? { gateGroups: repo.gateGroups } : {}),
      execution: {
        environment: this.config.environment,
        toolProfiles: this.config.toolProfiles,
        lifecycle: repo.lifecycle,
        prepare: repo.prepare,
        repositoryEnvironment: repo.environment,
      },
      dependencies: repositories(this.config).map(
        ({
          id,
          path,
          targetBranch,
          dependsOn,
          dependencyBuild,
          dependencyArtifacts,
          environment,
        }) => ({
          id,
          path,
          targetBranch,
          dependsOn,
          dependencyBuild,
          dependencyArtifacts,
          environment,
        }),
      ),
      memoryPolicy: this.config.memoryPolicy,
      protectedPaths: repo.protectedPaths,
      roles: { ...this.config.roles, ...repo.roles },
      repositoryReviewer: repo.reviewer,
      reviewer: this.config.reviewer,
      mode: this.config.mode,
      ...(this.config.contextPacks.length ? { contextPacks: this.config.contextPacks } : {}),
      ...(this.config.resources.length
        ? { resources: this.config.resources, resourceDatabase: this.config.resourceDatabase }
        : {}),
      ...(repo.generatedPaths?.length ? { generatedPaths: repo.generatedPaths } : {}),
    });
  }
  /**
   * План без доски открывает новую доску. План с доской — следующий этап её
   * работы: ревизия N+1 принятой доски. Раньше каждая порция работы одного
   * релиза заводила свою доску, и наблюдатель видел россыпь «частей 1»,
   * похожих на параллельные потоки. Этап несёт прежние задачи, как и
   * корректировка: последняя ревизия — весь состав доски, её приёмка
   * проверяет и прежние результаты. Цель этапа хранится в причине ревизии.
   */
  importPlan(input: unknown, boardId?: string) {
    const plan = planResult.parse(input);
    const stage = boardId ? `Следующий этап: ${plan.title}\n\n${plan.description}`.trim() : '';
    if (stage.length > 5000)
      throw new DomainError('Цель этапа: название и описание вместе до 5000 символов', 400);
    return this.store.change('plan.imported', (s) => {
      const target = boardId ? board(s, boardId) : undefined;
      const previous = target?.revisions.at(-1);
      if (previous && previous.status !== 'accepted')
        throw new DomainError(
          'Следующий этап открывается после приёмки текущей ревизии; до неё добавляйте задачи в неё',
          409,
        );
      const ids = new Map<string, string>();
      for (const t of plan.tasks) {
        if (ids.has(t.key)) throw new DomainError('Ключи задач должны быть уникальны', 400);
        ids.set(t.key, entityId(s, 'T'));
      }
      const tasks = plan.tasks.map((item) => {
        const parsed = taskInput.parse({
          ...item,
          dependsOn: item.dependsOn.map((key) =>
            requireValue(
              ids.get(key) ?? s.tasks.find((t) => t.id === key)?.id,
              `Неизвестная зависимость плана ${key}`,
            ),
          ),
        });
        repository(this.config, parsed.repositoryId);
        validateTaskContext(this.config, parsed);
        const owner = target && boardOwner(target, s);
        if (owner && (parsed.repositoryId !== owner || parsed.scope === 'workspace'))
          throw new DomainError('Локальная доска принимает только задачи своего компонента');
        return {
          ...parsed,
          preparation: developmentBinding(s),
          assignee: parsed.assignee ?? s.team?.member,
          id: ids.get(item.key)!,
          status: 'draft' as const,
          attempt: 0,
          createdAt: now(),
          contractDigests: {},
        };
      });
      s.tasks.push(...tasks);
      assertDag(s.tasks);
      if (target && previous) {
        const revision = {
          number: previous.number + 1,
          status: 'active' as const,
          reason: stage,
          taskIds: [...previous.taskIds, ...tasks.map((t) => t.id)],
          createdAt: now(),
        };
        target.revisions.push(revision);
        return { boardId: target.id, revision: revision.number, tasks: tasks.length };
      }
      const b = {
        id: entityId(s, 'B'),
        title: plan.title,
        description: plan.description,
        revisions: [
          {
            number: 1,
            status: 'active' as const,
            reason: 'Утверждение предложенного плана',
            taskIds: tasks.map((t) => t.id),
            createdAt: now(),
          },
        ],
      };
      s.boards.push(b);
      return { boardId: b.id, tasks: tasks.length };
    });
  }
  /**
   * Название и цель доски правятся, пока её план не утверждён. Цель входит в
   * предложение, которое читает ревью плана: сузив план, ведущий обязан
   * сузить и обещание доски, а до этой правки её приходилось пересоздавать.
   * После утверждения цель — часть согласованного, и меняет её корректировка.
   * Между этапами, когда текущая ревизия принята, доска снова свободна: она
   * ведёт релиз, а цель следующего этапа ревью прочтёт уже в новой редакции.
   * Принятые снимки названия не хранят и от правки не меняются.
   */
  editBoard(id: string, input: { title?: string; description?: string }) {
    return this.store.change('board.edited', (s) => {
      const b = requireValue(
        s.boards.find((x) => x.id === id),
        'Доска не найдена',
      );
      const r = b.revisions.at(-1)!;
      const approved = s.tasks.filter(
        (t) => r.taskIds.includes(t.id) && t.status !== 'draft' && t.status !== 'cancelled',
      );
      if (r.status === 'active' && approved.length)
        throw new DomainError(
          'Цель доски меняется до утверждения плана или после приёмки ревизии',
          409,
        );
      const title = input.title?.trim() ?? b.title;
      if (title.length < 3 || title.length > 180)
        throw new DomainError('Название: от 3 до 180 символов', 400);
      b.title = title;
      if (input.description !== undefined) b.description = input.description;
      return { boardId: id, title: b.title, description: b.description };
    });
  }
  createBoard(title: string, description = '', repositoryId?: string) {
    if (repositoryId) repository(this.config, repositoryId);
    if (title.trim().length < 3 || title.length > 180)
      throw new DomainError('Название: от 3 до 180 символов', 400);
    return this.store.change('board.created', (s) => {
      const b = {
        id: entityId(s, 'B'),
        repositoryId,
        title: title.trim(),
        description,
        revisions: [
          {
            number: 1,
            status: 'active' as const,
            reason: 'Первый цикл',
            taskIds: [],
            createdAt: now(),
          },
        ],
      };
      s.boards.push(b);
      return b;
    });
  }
  addTask(boardId: string, input: unknown) {
    const parsed = taskInput.parse(input);
    repository(this.config, parsed.repositoryId);
    validateTaskContext(this.config, parsed);
    return this.store.change('task.created', (s) => {
      const r = activeRevision(s, boardId);
      const owner = board(s, boardId).repositoryId;
      if (owner && (parsed.repositoryId !== owner || parsed.scope === 'workspace'))
        throw new DomainError('Локальная доска принимает только задачи своего компонента');
      const t: Task = {
        ...parsed,
        preparation: developmentBinding(s),
        assignee: parsed.assignee ?? s.team?.member,
        id: entityId(s, 'T'),
        status: 'draft',
        attempt: 0,
        createdAt: now(),
        contractDigests: {},
      };
      s.tasks.push(t);
      assertDag(s.tasks);
      r.taskIds.push(t.id);
      return t;
    });
  }
  editTask(id: string, input: unknown, expectedDigest: string) {
    const parsed = taskInput.parse(input);
    repository(this.config, parsed.repositoryId);
    validateTaskContext(this.config, parsed);
    return this.store.change('task.edited', (s) => {
      const t = task(s, id);
      if (t.status !== 'draft')
        throw new DomainError(
          'Изменять можно только черновик. Для принятой задачи создайте корректировку.',
        );
      if (specDigest(t) !== expectedDigest)
        throw new DomainError('Задача изменилась. Обновите страницу.');
      const ownerBoard = s.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(t.id)));
      if (
        ownerBoard?.repositoryId &&
        (parsed.repositoryId !== ownerBoard.repositoryId || parsed.scope === 'workspace')
      )
        throw new DomainError('Локальная доска принимает только задачи своего компонента');
      Object.assign(t, parsed, { preparation: developmentBinding(s) });
      // Корпус договора, которого задача больше не касается, не переносится.
      if (t.checkVersion && !t.contracts.includes(t.checkVersion.suite.replace(/^KS-/, '')))
        t.checkVersion = undefined;
      assertDag(s.tasks);
      return t;
    });
  }
  contract(
    title: string,
    content: string,
    approval: Approval = { actor: 'operator' },
    repositoryId?: string,
    source?: string,
    artifacts?: ContractArtifact[],
    checks?: CheckDeclaration,
  ) {
    if (repositoryId) repository(this.config, repositoryId);
    if (!title.trim() || !content.trim() || content.length > 60000)
      throw new DomainError('Укажите название и содержимое контракта (до 60 000 символов)', 400);
    return this.store.change('contract.approved', (s) => {
      const c = {
        id: entityId(s, 'C'),
        repositoryId,
        title,
        content,
        source,
        ...(artifacts?.length ? { artifacts, pinVersion: 2 as const } : {}),
        ...(checks ? { checks } : {}),
        digest: contractDigest(content, artifacts, artifacts?.length ? 2 : undefined, checks),
        approvedAt: now(),
        approval,
      };
      s.contracts.push(c);
      return c;
    });
  }
  /**
   * Предусловия утверждения черновика; возвращает закреплённые digests его
   * контрактов. Ревью плана вызывает их до модели: иначе ревью тратилось и
   * одобряло план, который утверждение затем отвергало — например, из-за
   * контракта, заменённого новой редакцией того же файла.
   */
  approvable(s: DevContourState, t: Task): Record<string, string> {
    assertTaskPreparation(s, t);
    assertTaskFeature(s, t);
    validateTaskContext(this.config, t);
    if (requiresContract(this.config, t.role, t.repositoryId) && !t.contracts.length)
      throw new DomainError(`${t.id}: для ${t.role} сначала привяжите утверждённый контракт`);
    // Область задачи — раскрытый список: свойство может проверяться gate из группы.
    const repo = repository(this.config, t.repositoryId);
    assertTaskProperties(
      { ...t, gates: t.gates && expandGates(repo, t.gates) },
      s.contracts,
      repo.gates,
    );
    return Object.fromEntries(
      t.contracts.map((id) => {
        const c = requireValue(
          s.contracts.find((c) => c.id === id),
          `Контракт ${id} не утверждён`,
        );
        if (c.repositoryId && c.repositoryId !== t.repositoryId)
          throw new DomainError('Для межпроектного интерфейса нужен общий контракт');
        const newer = supersededBy(s.contracts, id);
        if (newer)
          throw new DomainError(
            `${t.id}: контракт ${id} заменён редакцией ${newer.id} того же файла ${newer.source}; привяжите её`,
          );
        return [id, c.digest];
      }),
    );
  }
  approve(
    boardId: string,
    taskIds?: string[],
    approval: Approval = { actor: 'operator' },
    expected?: {
      revision: number;
      taskIds: string[];
      tasks: Record<string, string>;
      reason?: string;
      /** Зависимости, показанные ревьюеру вне предложения: digest постановки и статус. */
      dependencies?: Record<string, string>;
      /** Задачи ревизии, показанные ревьюеру как контекст и не утверждаемые им. */
      context?: Record<string, string>;
      /** Политика исполнения по компонентам на момент ревью. */
      policies?: Record<string, string>;
      /** Область проверок утверждаемых задач (gates, потребители) на момент ревью. */
      scopes?: Record<string, string>;
    },
  ) {
    return this.store.change('board.approved', (s) => {
      this.assertCurrentConfig(s);
      developmentBinding(s);
      const r = activeRevision(s, boardId);
      if (!r.taskIds.length) throw new DomainError('Добавьте задачи перед утверждением');
      const selected = taskIds ?? r.taskIds;
      if (!selected.length || selected.some((id) => !r.taskIds.includes(id)))
        throw new DomainError('Выберите задачи этой ревизии', 400);
      if (
        expected &&
        (expected.revision !== r.number ||
          (expected.reason !== undefined && expected.reason !== r.reason) ||
          Object.entries(expected.dependencies ?? {}).some(
            ([id, pinned]) => dependencyDigest(task(s, id)) !== pinned,
          ) ||
          Object.entries(expected.context ?? {}).some(
            ([id, pinned]) => contextDigest(task(s, id)) !== pinned,
          ) ||
          Object.entries(expected.policies ?? {}).some(
            ([id, pinned]) => this.policyDigest(id) !== pinned,
          ) ||
          Object.entries(expected.scopes ?? {}).some(
            ([id, pinned]) => scopeDigest(task(s, id)) !== pinned,
          ) ||
          digest(expected.taskIds) !== digest(r.taskIds) ||
          selected.some((id) => {
            const current = task(s, id);
            return current.status !== 'draft' || expected.tasks[id] !== specDigest(current);
          }))
      )
        throw new DomainError('План изменился во время ревью; требуется повторная проверка');
      for (const id of selected) {
        const t = task(s, id);
        if (t.status !== 'draft') continue;
        t.contractDigests = this.approvable(s, t);
        t.approvedAt = now();
        t.approvedDigest = specDigest(t);
        t.approvedScope = scopeDigest(t);
        t.approval = approval;
        t.status = 'ready';
        closeIfBasisChanged(t);
      }
      return { boardId, revision: r.number, approval };
    });
  }
  impact(boardId: string, roots: string[]) {
    const s = this.store.read();
    const b = board(s, boardId);
    const r = b.revisions.at(-1)!;
    if (r.status !== 'accepted')
      throw new DomainError('Корректировка создаётся после приёмки текущей ревизии');
    if (!roots.length || roots.some((id) => !r.taskIds.includes(id)))
      throw new DomainError('Выберите принятые задачи этой доски', 400);
    // Отменённый потребитель — не результат: корректировать его нечего, а
    // требование done делало корректировку предшественника невозможной.
    // Обход через него к живым потребителям сохраняется.
    const ids = descendants(impactGraph(s.tasks), [
      ...new Set(roots.map((id) => latestTaskId(s.tasks, id))),
    ]).filter((id) => task(s, id).status !== 'cancelled');
    return {
      taskIds: ids,
      boards: s.boards
        .filter((b) => b.revisions.at(-1)!.taskIds.some((id) => ids.includes(id)))
        .map((b) => ({ id: b.id, title: b.title })),
    };
  }
  correct(
    boardId: string,
    roots: string[],
    reason: string,
    refresh?: { expected: string; requirements: Record<string, Task['requirements']> },
  ) {
    if (reason.trim().length < 10 || reason.length > 5000)
      throw new DomainError('Опишите корректировку: от 10 до 5000 символов', 400);
    // Recompute the entire impact inside the write transaction; preview is never authoritative.
    return this.store.change('board.corrected', (s) => {
      const b = board(s, boardId);
      if (refresh && digest(b) !== refresh.expected)
        throw new DomainError('Доска изменилась во время чтения требований');
      const previous = b.revisions.at(-1)!;
      if (previous.status !== 'accepted') throw new DomainError('Сначала примите текущую ревизию');
      if (!roots.length || roots.some((id) => !previous.taskIds.includes(id)))
        throw new DomainError('Выберите задачи текущей принятой ревизии', 400);
      const impacted = descendants(impactGraph(s.tasks), [
        ...new Set(roots.map((id) => latestTaskId(s.tasks, id))),
      ]).filter((id) => task(s, id).status !== 'cancelled');
      if (impacted.some((id) => task(s, id).status !== 'done'))
        throw new DomainError(
          'В затронутой цепочке есть незавершённые задачи. Сначала завершите их.',
        );
      const currentIds = new Map(s.tasks.map((t) => [t.id, latestTaskId(s.tasks, t.id)]));
      const currentRoots = roots.map((id) => currentIds.get(id)!);
      const map = new Map(impacted.map((id) => [id, entityId(s, 'T')]));
      for (const id of impacted) {
        const original = task(s, id);
        const requirements = refresh?.requirements[id] ?? original.requirements;
        validateTaskContext(this.config, { ...original, requirements });
        s.tasks.push({
          ...original,
          preparation: developmentBinding(s),
          requirements,
          sharedCompletion: undefined,
          id: map.get(id)!,
          description:
            original.description +
            `\n\nКорректировка: ${reason}\n${currentRoots.includes(id) ? 'Измените результат согласно корректировке.' : 'Повторно проверьте и при необходимости адаптируйте результат к новым зависимостям.'}`,
          dependsOn: original.dependsOn.map(
            (d) => map.get(currentIds.get(d)!) ?? currentIds.get(d)!,
          ),
          supersedes: id,
          status: 'draft',
          createdAt: now(),
          attempt: 0,
          approvedAt: undefined,
          approvedDigest: undefined,
          approvedScope: undefined,
          approval: undefined,
          activeRunId: undefined,
          resultSha: undefined,
          failure: undefined,
          contractDigests: {},
        });
      }
      const revision = {
        number: previous.number + 1,
        status: 'active' as const,
        reason,
        taskIds: [
          ...new Set([
            ...previous.taskIds.map((id) => map.get(currentIds.get(id)!) ?? id),
            ...map.values(),
          ]),
        ],
        createdAt: now(),
      };
      b.revisions.push(revision);
      assertDag(s.tasks);
      return { boardId, revision: revision.number, replacements: Object.fromEntries(map) };
    });
  }
  accept(
    boardId: string,
    headSha: string,
    approval: Approval = { actor: 'operator' },
    expectedDigest?: string,
    repositories?: Record<string, string>,
  ) {
    return this.store.change('board.accepted', (s) => {
      this.assertCurrentConfig(s);
      const r = activeRevision(s, boardId);
      if (expectedDigest && digest(r) !== expectedDigest)
        throw new DomainError('Ревизия изменилась во время приёмки');
      // Отменённая задача — явное решение с причиной в журнале, а не
      // незавершённая работа. Раньше она делала ревизию непринимаемой навсегда:
      // убрать её из ревизии было нечем. Объём приёмки — выполненные задачи;
      // хотя бы одна обязательна.
      const tasks = r.taskIds
        .map((id) => task(s, id))
        .filter((t) => t.status !== 'cancelled')
        .map((t) => structuredClone(t));
      if (!tasks.length || tasks.some((t) => t.status !== 'done'))
        throw new DomainError('Приёмка доступна, когда все задачи прошли интеграцию и проверки');
      // Перенесённые из принятой ревизии задачи уже проверены её приёмкой.
      const carried = carriedTaskIds(board(s, boardId), s.tasks);
      const work = tasks.filter((t) => !carried.has(t.id));
      work.forEach((t) => assertTaskPreparation(s, t));
      for (const t of work) {
        const unproven = unprovenReason(t.requirements, taskEvidence(s, t), t.resultSha);
        if (unproven) throw new DomainError(unproven);
      }
      const uncovered = uncoveredGates(this.config, s, tasks);
      if (uncovered.length)
        throw new DomainError(
          'Полный набор проверок не пройден: ' +
            uncovered.map((u) => `${u.repositoryId}: ${u.gates.join(', ')}`).join('; ') +
            ' — ни одна задача доски не прошла их на integration. Добавьте задачу, чья область их включает',
        );
      r.status = 'accepted';
      r.acceptedAt = now();
      r.acceptance = approval;
      r.snapshot = {
        tasks,
        sha: headSha,
        ...(repositories ? { repositories } : {}),
        digest: digest({ tasks, sha: headSha, ...(repositories ? { repositories } : {}) }),
      };
      return { boardId, revision: r.number, snapshot: r.snapshot.digest, approval };
    });
  }
  pause(value: boolean, reason: 'operator' | 'shutdown' = 'operator') {
    return this.store.change(value ? 'scheduler.paused' : 'scheduler.started', (s) => {
      if (!value) developmentBinding(s);
      // Штатная остановка поверх паузы человека её не подменяет; поверх паузы
      // операции — забирает её: иначе операция сняла бы и остановку.
      if (s.paused && value && reason === 'shutdown' && s.pauseReason !== 'reconfigure')
        return { paused: true, reason: s.pauseReason };
      s.paused = value;
      s.pauseReason = value ? reason : undefined;
      // Решение человека заменяет паузу операции: снять её операция уже не
      // сможет — пауза теперь человека.
      s.pauseOperation = undefined;
      s.pausedAt = value ? now() : undefined;
      // Продолжение очереди — решение после проверки базы: её ожидание снято.
      // Ожидание перезакрепления контекста держит операция, а не очередь.
      if (!value && s.waits?.length) {
        s.waits = s.waits.filter((w) => w.kind !== 'base-check');
        if (!s.waits.length) s.waits = undefined;
      }
      // Класс отказа принадлежит конкретной паузе: пережив её, он разрешил бы
      // снять следующую паузу, к которой не имеет отношения. Эта операция —
      // решение человека или штатная остановка, и класса у неё нет.
      s.pauseFailures = undefined;
      return { paused: value, reason: s.pauseReason };
    });
  }
  // Карта продукта считает готовность по связи задачи с фичей. Задачи,
  // выпущенные без неё, исправляются здесь — в том числе принятые: связь не
  // входит в постановку, и приёмку она не затрагивает.
  bindFeature(id: string, featureId: string) {
    return this.store.change('task.feature', (s) => {
      const t = task(s, id);
      if (t.status === 'cancelled') throw new DomainError('Отменённая задача не относится к фиче');
      if (!t.preparation)
        throw new DomainError('Задача не связана с изменением продукта; фичу ей назначить нельзя');
      assertFeatureOf(s, t.preparation.changeId, featureId);
      const previous = t.featureId;
      t.featureId = featureId;
      return { taskId: t.id, featureId, previous };
    });
  }
  // Перенос базы устраняет причину, по которой диспетчер встал, но очередь не
  // запускает: сначала человек проверяет базу гейтами. Пауза переходит к нему,
  // а прежний сбой перестаёт называться причиной — иначе экран продолжал
  // советовать уже выполненный base-update. Событие оставляет перенос в журнале.
  baseUpdated(updated: { repositoryId: string; from: string; to: string }[]) {
    return this.store.change('base.updated', (s) => {
      if (!s.paused) throw new DomainError('Перенос базы выполняется на остановленной очереди');
      // Пауза человека остаётся его паузой; иначе очередь ждёт проверки базы —
      // это техническое ожидание, а не решение человека.
      if (s.pauseReason !== 'operator') s.pauseReason = 'base-check';
      s.pausedAt = now();
      s.pauseFailures = undefined;
      s.waits = [
        ...(s.waits ?? []).filter((w) => w.kind !== 'base-check'),
        {
          kind: 'base-check',
          detail: `База прогонов перенесена (${updated.map((u) => u.repositoryId).join(', ')}): проверьте её гейтами и продолжите очередь`,
          at: now(),
        },
      ];
      return { updated };
    });
  }
  /** Техническое ожидание операции: видно отдельно от паузы и её не трогает. */
  waitFor(kind: 'context-lock', operation: string, detail: string) {
    return this.store.change('wait.started', (s) => {
      s.waits = [
        ...(s.waits ?? []).filter((w) => !(w.kind === kind && w.operation === operation)),
        { kind, detail, operation, at: now() },
      ];
      return { kind, operation };
    });
  }
  clearWait(kind: 'context-lock', operation: string) {
    return this.store.change('wait.cleared', (s) => {
      const left = (s.waits ?? []).filter((w) => !(w.kind === kind && w.operation === operation));
      if (left.length === (s.waits ?? []).length) return;
      s.waits = left.length ? left : undefined;
      return { kind, operation };
    });
  }
  /** Передать удержание задач от одной операции другой без окна выдачи. */
  transferHold(from: string, to: string, reason: string) {
    return this.store.change('task.hold-transferred', (s) => {
      const moved = s.tasks.filter((t) => t.hold?.operation === from);
      for (const t of moved) t.hold = { operation: to, reason };
      return moved.map((t) => t.id);
    });
  }
  /** Снять удержание операции с перечисленных задач; чужие не трогаются. */
  releaseTasks(operation: string, ids: string[]) {
    return this.store.change('task.released', (s) => {
      const released = s.tasks.filter((t) => ids.includes(t.id) && t.hold?.operation === operation);
      for (const t of released) t.hold = undefined;
      return released.map((t) => t.id);
    });
  }
  assign(id: string, member: string) {
    const assignee = taskInput.shape.assignee.unwrap().parse(member);
    return this.store.change('task.assigned', (s) => {
      const t = task(s, id);
      if (t.activeRunId) throw new DomainError('Дождитесь завершения активной попытки');
      t.assignee = assignee;
      return { taskId: id, assignee };
    });
  }
  private awaitsOperator(t: Task) {
    // Корпус хранится у компонента-владельца договора, не обязательно у
    // компонента задачи: смотрим всех владельцев, как CheckCorpus.all().
    const owners = this.config.repositories.length
      ? this.config.repositories.map((r) => r.id)
      : ['main'];
    return owners
      .flatMap((owner) =>
        Object.values(
          this.store.localRecords<{
            pending: { tasks: string[]; status: string; awaitingOperator?: boolean }[];
          }>('check-suites', owner),
        ),
      )
      .some((suite) =>
        suite.pending.some(
          (p) => p.status === 'waiting' && p.awaitingOperator && p.tasks.includes(t.id),
        ),
      );
  }
  claim(owner: string): Run | undefined {
    return this.store.change('run.claimed', (s) => {
      if (
        s.paused ||
        // Пока операция применяет конфигурацию, попытки не выдаются, даже если
        // человек снял паузу: попытка под прежней конфигурацией не нужна.
        (s.reconfigure && !s.reconfigure.appliedAt) ||
        // Процесс со старой конфигурацией не выдаёт попыток: их условия
        // разошлись бы с применённой контуром конфигурацией.
        (() => {
          try {
            this.assertCurrentConfig(s);
            return false;
          } catch {
            return true;
          }
        })() ||
        s.changeSets.some((c) =>
          c.deliveries?.some((d) => d.status === 'active' && d.leaseUntil > Date.now()),
        ) ||
        s.changeSets.some((c) =>
          c.verifications.some((v) => v.status === 'active' && v.leaseUntil > Date.now()),
        )
      )
        return;
      if (s.runs.filter((r) => r.status === 'active').length >= this.config.concurrency) return;
      for (const ready of readyTasks(s)) closeIfBasisChanged(ready);
      // Бюджеты считаются по сохранённым записям вызовов: сброс попыток и
      // перезапуск их не уменьшают. Остановленная бюджетом задача несёт
      // причину, пока бюджет не позволит снова.
      if (this.config.budgets) {
        const records = usageRecords(this);
        for (const ready of readyTasks(s)) {
          const blocking = blockingBudget(this, taskBudgets(this, s, ready, records));
          if (blocking) {
            if (ready.budgetBlock?.reason !== blocking.reason)
              ready.budgetBlock = { reason: blocking.reason!, at: now() };
          } else delete ready.budgetBlock;
        }
      } else
        // Бюджеты выключены: бюджетное удержание снимается, остальные
        // условия выдачи (пауза, удержание операции) самостоятельны.
        for (const ready of readyTasks(s)) delete ready.budgetBlock;
      const eligible = readyTasks(s).filter(
        (t) =>
          t.attempt < this.config.maxAttempts &&
          (!s.team || t.assignee === s.team.member) &&
          // Два содержательных отказа по одному свойству: третья выдача —
          // только после разбора. Независимые задачи выдаются как обычно.
          !blocksClaim(t) &&
          !t.budgetBlock &&
          // Принятие корпуса, ждущее оператора, удерживает выдачу, даже если
          // его собственное удержание не было поставлено (задача была занята
          // другим) или снято принятием соседнего запроса.
          !this.awaitsOperator(t),
      );
      const t = eligible[0];
      if (!t) return;
      assertTaskPreparation(s, t);
      validateTaskContext(this.config, t);
      if (t.approvedDigest !== specDigest(t))
        throw new DomainError('Спецификация изменилась после утверждения');
      if (t.approvedScope && t.approvedScope !== scopeDigest(t))
        throw new DomainError('Область проверок задачи изменилась после утверждения');
      const dependencyDates = t.dependsOn.map((id) => {
        const dependency = s.tasks.find((x) => x.id === id)!;
        return (
          s.runs.findLast((r) => r.taskId === id && r.status === 'succeeded')?.finishedAt ??
          dependency.sharedCompletion?.receipt.finishedAt
        );
      });
      const readyAt =
        t.approvedAt && dependencyDates.every(Boolean)
          ? [t.approvedAt, ...(dependencyDates as string[])].sort().at(-1)
          : undefined;
      const candidates = eligible.map((t) => ({
        taskId: t.id,
        repositoryId: t.repositoryId,
        attempt: t.attempt,
      }));
      const run: Run = {
        dispatch: {
          policy: 'fifo-ready-v1',
          at: now(),
          eligible: candidates,
          activeCount: s.runs.filter((r) => r.status === 'active').length,
          concurrency: this.config.concurrency,
          inputDigest: digest(candidates),
        },
        wait: { approvedAt: t.approvedAt, readyAt },
        requiredGates: [
          // Задача доказывает себя своей областью, если она объявлена; иначе —
          // всем профилем, как раньше.
          // Группы раскрыты: в попытке записан явный список.
          ...expandGates(repository(this.config, t.repositoryId), t.gates),
          ...(t.requirements?.length ? ['requirement-source'] : []),
        ],
        ...(t.consumers?.length
          ? {
              consumers: t.consumers.map((c) => ({
                repositoryId: c.repositoryId,
                gates: expandGates(repository(this.config, c.repositoryId), c.gates),
              })),
            }
          : {}),
        id: randomUUID(),
        taskId: t.id,
        repositoryId: t.repositoryId,
        attempt: ++t.attempt,
        token: randomUUID(),
        owner,
        runtime: roleBinding(this.config, t.role, t.repositoryId).runtime,
        reviewer: reviewerBinding(this.config, t.role, t.repositoryId).runtime,
        model: roleBinding(this.config, t.role, t.repositoryId).model,
        reviewerModel: reviewerBinding(this.config, t.role, t.repositoryId).model,
        effort: roleBinding(this.config, t.role, t.repositoryId).effort,
        reviewerEffort: reviewerBinding(this.config, t.role, t.repositoryId).effort,
        policyDigest: this.taskPolicyDigest(t),
        // Версия проверок закрепляется при выдаче: принятие нового корпуса
        // посередине попытки ждёт её окончания, и evidence этой попытки
        // относится к этой версии.
        checks: {
          effective: effectiveChecks(t, this.taskPolicyDigest(t)),
          ...(t.checkVersion ? { corpus: t.checkVersion } : {}),
        },
        status: 'active',
        phase: 'running',
        startedAt: now(),
        leaseUntil: Date.now() + this.config.leaseMs,
        evidence: [],
        callsRecorded: true,
      };
      run.episodeBasis = episodeBasis(t);
      if (t.recovery?.status === 'retry') {
        // Разрешённый разбором повтор выдан: второй раз он не выдаётся.
        t.recovery.status = 'retrying';
        t.recovery.retryRun = run.id;
        t.recovery.version++;
        t.recovery.history.push({ at: now(), event: 'retry-claimed', detail: run.id });
      }
      t.status = 'running';
      t.activeRunId = run.id;
      t.failure = undefined;
      s.runs.push(run);
      return run;
    });
  }
  withRun<T>(
    id: string,
    token: string,
    type: string,
    fn: (run: Run, t: Task, s: DevContourState) => T,
  ): T {
    return this.store.change(type, (s) => {
      const r = requireValue(
        s.runs.find((r) => r.id === id),
        'Попытка не найдена',
      );
      const t = task(s, r.taskId);
      assertTaskPreparation(s, t);
      this.assertCurrentConfig(s);
      if (r.policyDigest !== this.taskPolicyDigest(t))
        throw new DomainError('Политика проверок изменилась; нужна новая попытка');
      if (
        r.status !== 'active' ||
        r.token !== token ||
        r.leaseUntil <= Date.now() ||
        t.activeRunId !== r.id
      )
        throw new DomainError('Устаревшая попытка: владение утрачено');
      return fn(r, t, s);
    });
  }
  /**
   * Записывает основания реализации и решает, брать ли кандидата предыдущей
   * попытки. Решение принимается в той же транзакции, что и запись: между
   * чтением и записью предыдущую попытку никто не подменит.
   */
  implementationBasis(id: string, token: string, basis: string, reuse: boolean) {
    return this.withRun(id, token, 'run.implementation-basis', (r, t, s) => {
      r.implementationBasis = basis;
      const decision = reuse
        ? reusableImplementation(s, t, r.id, basis)
        : ({ reuse: false, reason: 'переиспользование выключено' } as const);
      if (decision.reuse)
        r.reusedFrom = { runId: decision.from.id, candidateSha: decision.candidateSha };
      return decision.reuse
        ? { runId: id, basis, reusedFrom: r.reusedFrom }
        : { runId: id, basis, reuse: decision.reason };
    });
  }
  /** Черновик реализации, оборванной по времени (см. Run.partial). */
  recordPartial(id: string, token: string, partial: NonNullable<Run['partial']>) {
    return this.withRun(id, token, 'run.partial', (r) => {
      r.partial = partial;
      return { runId: id, files: partial.files, digest: partial.digest };
    });
  }
  /** Попытка начала с черновика предыдущей (см. Run.continuedFrom). */
  continuation(id: string, token: string, from: NonNullable<Run['continuedFrom']>) {
    return this.withRun(id, token, 'run.continuation', (r) => {
      r.continuedFrom = from;
      return {
        runId: id,
        draftOf: from.runId,
        kind: from.kind,
        applied: from.applied,
        files: from.files,
      };
    });
  }
  heartbeat(id: string, token: string) {
    this.withRun(id, token, 'heartbeat', (r) => {
      r.leaseUntil = Date.now() + this.config.leaseMs;
    });
  }
  /**
   * Продление владения не удалось. Планировщик прерывал попытку молча, и
   * снаружи оставалось только «истёк срок владения» — причину (сменившаяся
   * политика, привязка к подготовке, сбой хранилища) узнать было неоткуда.
   * Причина записывается в попытку; истечение её не затирает.
   */
  heartbeatFailed(id: string, token: string, reason: string) {
    return this.store.change('run.heartbeat-failed', (s) => {
      const r = s.runs.find((r) => r.id === id);
      // Истёкший срок допустим — ради него запись и делается, — но смена
      // токена означает нового владельца: прежний не пишет в его попытку.
      // Записывается первая причина: следующие — её следствия.
      if (r?.status !== 'active' || r.token !== token || r.error?.startsWith(HEARTBEAT_FAILED))
        return;
      r.error = `${HEARTBEAT_FAILED}: ${reason.slice(0, 500)}`;
      return { runId: id, error: r.error };
    });
  }
  phase(
    id: string,
    token: string,
    phase: 'running' | 'verifying' | 'reviewing' | 'integrating',
    data: Partial<Pick<Run, 'baseSha' | 'candidateSha' | 'integrationSha' | 'worktree'>> = {},
  ) {
    this.withRun(id, token, 'run.phase', (r, t) => {
      if (!['running', 'verifying', 'reviewing', 'integrating'].includes(phase))
        throw new DomainError('Недопустимая фаза');
      r.phase = phase;
      t.status = phase;
      Object.assign(r, data);
      return { runId: id, taskId: t.id, phase, ...data };
    });
  }
  /**
   * Записать воспроизведения из находок ревью прогона. Одно свойство на одном
   * входе — одна запись: повтор добавляет прогон, а не новую запись.
   */
  reproductions(
    id: string,
    token: string,
    sha: string,
    items: Omit<Reproduction, 'id' | 'key' | 'taskId' | 'inputHash' | 'runs' | 'status'>[],
  ) {
    return this.withRun(id, token, 'reproduction.recorded', (r, t, s) => {
      s.reproductions ??= [];
      const at = now();
      const touched = items.map((item) => {
        const inputHash = digest(item.input);
        const key = digest({ taskId: t.id, property: item.property, inputHash });
        const run = { runId: r.id, sha, contracts: t.contractDigests, at };
        const existing = s.reproductions!.find((x) => x.key === key);
        if (existing) {
          if (!existing.runs.some((x) => x.runId === r.id)) existing.runs.push(run);
          // Подтверждение контура не отменяется последующим неподтверждённым.
          // Гипотеза, подтверждённая запуском, получает команду и id этого
          // запуска вместе: иначе запись связывала бы действительный запуск с
          // командой, которая не запускалась.
          if (item.observed && !existing.observed) {
            existing.observed = true;
            existing.run = item.run;
            existing.command = item.command;
          }
          existing.claimed ||= item.claimed;
          return existing;
        }
        const created: Reproduction = {
          ...item,
          id: randomUUID(),
          key,
          taskId: t.id,
          inputHash,
          runs: [run],
          status: 'proposed',
        };
        s.reproductions!.push(created);
        return created;
      });
      // Реестр ограничен: старые записи вытесняются, а не копятся без предела.
      s.reproductions = s.reproductions.slice(-500);
      return touched;
    });
  }
  evidence(id: string, token: string, evidence: Omit<Evidence, 'id' | 'runId' | 'createdAt'>) {
    return this.withRun(id, token, 'evidence.recorded', (r) => {
      // Evidence относится к версии проверок попытки. Чужая версия не
      // записывается: старое evidence не выдаётся за проверку новой.
      if (evidence.checks !== undefined && evidence.checks !== r.checks?.effective)
        throw new DomainError('Evidence другой версии проверок, чем у попытки');
      const e = {
        ...evidence,
        ...(r.checks ? { checks: r.checks.effective } : {}),
        id: randomUUID(),
        runId: id,
        createdAt: now(),
      };
      r.evidence.push(e);
      return e;
    });
  }
  finish(id: string, token: string, sha: string, publish?: () => void) {
    return this.withRun(id, token, 'task.done', (r, t, s) => {
      if (r.phase !== 'integrating' || !r.candidateSha || r.integrationSha !== sha)
        throw new DomainError('Нет интеграционного коммита');
      // Принять можно только под той версией проверок, под которой шла
      // попытка: новый корпус, принятый задачей, требует новой попытки.
      if (r.checks && effectiveChecks(t, this.taskPolicyDigest(t)) !== r.checks.effective)
        throw new DomainError('Версия проверок задачи изменилась; нужна новая попытка');
      // Evidence потребителя закрывает только проверку потребителя: его gate
      // `unit` — не собственный `unit` задачи.
      const last = (
        kind: Evidence['kind'],
        phase: Evidence['phase'],
        sha: string,
        gate: string,
        consumer?: string,
      ) =>
        r.evidence.findLast(
          (e) =>
            e.kind === kind &&
            e.phase === phase &&
            e.sha === sha &&
            e.gate === gate &&
            e.consumer === consumer &&
            (!r.checks || e.checks === r.checks.effective),
        )?.passed === true;
      // Доказательства требуются по области доказательства прогона — той же,
      // по которой гейты и запускались. Требовать весь набор профиля значит
      // требовать от задачи зелени по проверкам соседних, ещё не сделанных
      // задач; полный набор остаётся обязательным при приёмке доски и релиза.
      const required = r.requiredGates ?? [
        ...repository(this.config, t.repositoryId).gates.map((g) => g.id),
        ...(t.requirements?.length ? ['requirement-source'] : []),
      ];
      for (const gate of required)
        for (const phase of ['candidate', 'integration'] as const)
          if (!last('test', phase, phase === 'candidate' ? r.candidateSha : sha, gate))
            throw new DomainError(`Нет PASS: ${phase}/${gate}`);
      for (const phase of ['candidate', 'integration'] as const)
        if (
          !last('review', phase, phase === 'candidate' ? r.candidateSha : sha, 'independent-review')
        )
          throw new DomainError(`Нет независимого ревью: ${phase}`);
      // Проверки потребителей — на integration, против интегрированного
      // результата задачи.
      for (const consumer of r.consumers ?? []) {
        for (const gate of consumer.gates)
          if (!last('test', 'integration', sha, gate, consumer.repositoryId))
            throw new DomainError(
              `Нет PASS проверки потребителя: ${consumer.repositoryId}/${gate}`,
            );
        // Что проверено, обязано быть записано: иначе результат нельзя
        // перенести, и проверку потребителя не с чем сверить.
        const provider = consumer.checked?.dependencies.find(
          (d) => d.repositoryId === t.repositoryId,
        );
        if (provider?.sha !== sha)
          throw new DomainError(
            `Проверка потребителя ${consumer.repositoryId} не записала снимок с интегрированным результатом`,
          );
      }
      // Названный сценарий предъявляется до публикации: опубликованный
      // результат сразу становится входом зависимых задач, и отказ при
      // приёмке доски был бы уже поздним. Задачи без testId проходят на
      // прежнем уровне.
      const unproven = unprovenReason(t.requirements, r.evidence, sha);
      if (unproven) throw new TaskFailure('gate', unproven);
      r.status = 'succeeded';
      r.finishedAt = now();
      afterSuccess(t);
      t.status = 'done';
      t.resultSha = sha;
      t.activeRunId = undefined;
      // Принятый результат переносим: receipt, который чтение состояния из Git
      // отвергло бы по размеру, отклоняется до публикации, а не после done.
      const bytes = receiptBytes(this, s, t);
      if (bytes > maxRecordBytes)
        throw new DomainError(
          `Запись receipt задачи ${t.id} занимает ${bytes} байт при пределе ${maxRecordBytes}: ` +
            'сократите dependencyArtifacts или область проверок',
        );
      publish?.();
      return { taskId: t.id, runId: id, sha };
    });
  }
  fail(
    id: string,
    token: string,
    error: string,
    blocked = false,
    kind: FailureKind = 'unknown',
    /** Первая причина неудавшегося продления, известная планировщику. */
    heartbeatCause?: string,
    /** Свойства, с которыми связан отказ: объявленные и только названные. */
    properties?: { bound: string[]; unbound: string[] },
  ) {
    return this.withRun(id, token, 'run.failed', (r, t, s) => {
      // Класс и отпечаток записываются вместе с отказом: решение о починке
      // принимается позже, возможно после перезапуска, и восстанавливать
      // причину из текста сообщения тогда уже нечем.
      const fingerprint = failureFingerprint(kind, error);
      // Отказ после неудавшегося продления — его следствие («попытка
      // прервана»); причина продления остаётся впереди, иначе снова видно
      // только следствие.
      const prefix = r.error?.startsWith(HEARTBEAT_FAILED)
        ? r.error
        : heartbeatCause
          ? `${HEARTBEAT_FAILED}: ${heartbeatCause.slice(0, 500)}`
          : undefined;
      const shown = prefix ? `${prefix}. ${error}` : error;
      r.status = 'failed';
      r.error = shown;
      r.blocked = blocked || undefined;
      r.failureKind = kind;
      r.failureFingerprint = fingerprint;
      r.finishedAt = now();
      t.status = 'failed';
      t.failure = shown;
      t.failureKind = kind;
      t.failureFingerprint = fingerprint;
      t.activeRunId = undefined;
      // Свойство отказа — только объявленное задачей: неизвестное сохраняется
      // для разбора, но счётчик эпизода не выбирает.
      if (properties?.bound.length) r.properties = [...new Set(properties.bound)];
      if (properties?.unbound.length) r.unboundProperties = [...new Set(properties.unbound)];
      // Отказ окружения задачу не пробовал: попытка возвращается, иначе бюджет
      // сгорает на неполадках контура и задача блокируется, ни разу не дойдя
      // до исполнителя.
      if (blocked && t.attempt > 0) t.attempt--;
      const recovery = afterFailure(s, t, r);
      return {
        taskId: t.id,
        runId: id,
        error,
        blocked,
        kind,
        ...(r.properties ? { properties: r.properties } : {}),
        ...(recovery ? { recovery: { id: recovery.id, status: recovery.status } } : {}),
      };
    });
  }
  discoveries(id: string, token: string, sha: string, input: unknown) {
    const findings = discoveryInput.array().max(20).parse(input);
    if (!findings.length) return [];
    return this.withRun(id, token, 'findings.recorded', (run, source, s) => {
      const created: string[] = [];
      for (const finding of findings) {
        const fingerprint = digest({
          repositoryId: source.repositoryId,
          path: finding.path,
          observation: finding.observation,
        });
        if (
          s.tasks.some(
            (t) =>
              t.finding?.fingerprint === fingerprint &&
              t.status !== 'done' &&
              t.status !== 'cancelled',
          )
        )
          continue;
        let inbox = s.boards.find(
          (b) => b.title === 'Находки агентов' && b.revisions.at(-1)?.status === 'active',
        );
        if (!inbox) {
          inbox = {
            id: entityId(s, 'B'),
            title: 'Находки агентов',
            description:
              'Непроверенные дефекты и техдолг. Ведущий агент проверяет воспроизведение и приоритет до утверждения.',
            revisions: [
              {
                number: 1,
                status: 'active',
                reason: 'Сбор находок',
                taskIds: [],
                createdAt: now(),
              },
            ],
          };
          s.boards.push(inbox);
        }
        const t: Task = {
          ...taskInput.parse({
            repositoryId: source.repositoryId,
            role: source.role,
            title: finding.title,
            description: `${finding.observation}\nПоследствие: ${finding.consequence}\nВоспроизведение: ${finding.reproduction}\nИсточник: ${finding.path}:${finding.line} @ ${sha}. Находка не подтверждена.`,
            acceptance: [
              'Воспроизвести находку и сохранить доказательство до изменения кода.',
              'После исправления выполнить регрессионный сценарий и обязательные проверки.',
            ],
            finding: {
              ...finding,
              fingerprint,
              sourceTaskId: source.id,
              sourceRunId: run.id,
              sourceSha: sha,
              verification: 'proposed',
            },
          }),
          id: entityId(s, 'T'),
          assignee: s.team?.member,
          status: 'draft',
          attempt: 0,
          createdAt: now(),
          contractDigests: {},
        };
        // Находка относится к той же постановке и фиче, что и задача, в которой
        // её нашли. Без привязки черновик блокировал утверждение всей доски
        // находок сообщением, которое не называло задачу.
        if (source.preparation) {
          try {
            t.preparation = developmentBinding(s, source.preparation.changeId);
          } catch {
            /* Постановка сменилась: привязку даст правка черновика ведущим. */
          }
          if (source.featureId) t.featureId = source.featureId;
        }
        s.tasks.push(t);
        inbox.revisions.at(-1)!.taskIds.push(t.id);
        created.push(t.id);
      }
      return created;
    });
  }
  /**
   * Учесть разбор ведущего до вызова модели. Один автоматический разбор на
   * эпизод: повторная регистрация, рестарт или дубликат события бесплатного
   * вызова не получают. Исчерпанные попытки задачи — решение пользователя.
   */
  recoveryReserve(taskId: string, recoveryId: string) {
    return this.store.change('recovery.reserved', (s) => {
      const t = task(s, taskId);
      const r = t.recovery;
      if (!r || r.id !== recoveryId) throw new DomainError('Эпизод восстановления не найден', 404);
      if (r.status !== 'awaiting-lead')
        throw new DomainError(`Эпизод ${r.id} не ждёт разбора: ${r.status}`, 409);
      const at = now();
      if (r.calls >= 1) {
        r.status = 'awaiting-user';
        r.reason = 'Автоматический разбор эпизода уже использован; повторный вызов не выполняется.';
      } else if (t.attempt >= this.config.maxAttempts) {
        r.status = 'awaiting-user';
        r.reason =
          'Попытки задачи исчерпаны: разрешённого повтора не осталось, сброс — решение человека.';
      } else {
        r.calls++;
        r.status = 'analyzing';
      }
      r.version++;
      r.history.push({
        at,
        event: r.status === 'analyzing' ? 'analysis-reserved' : 'refused',
        detail: r.reason,
      });
      return { taskId, recovery: r.id, status: r.status, reason: r.reason };
    });
  }
  /**
   * Записать решение разбора — ведущего (автоматического) или ручное через
   * API — и перевести эпизод в состояние разрешённого действия. Ручное
   * решение сверяет версию записи: устаревшее не применяется.
   */
  recoveryDecide(
    taskId: string,
    recoveryId: string,
    decision: RecoveryDecision,
    expectedVersion?: number,
  ): PropertyRecovery {
    if (!recoveryActions.includes(decision.action))
      throw new DomainError('Неизвестное действие восстановления', 400);
    if (decision.reason.trim().length < 10)
      throw new DomainError('Решение требует причины не короче 10 символов', 400);
    this.store.change('recovery.decided', (s) => {
      const t = task(s, taskId);
      const r = t.recovery;
      if (!r || r.id !== recoveryId) throw new DomainError('Эпизод восстановления не найден', 404);
      if (expectedVersion !== undefined && r.version !== expectedVersion)
        throw new DomainError('Эпизод изменился; прочитайте его заново', 409);
      const manual = decision.source.kind === 'operator';
      if (!manual && r.status !== 'analyzing')
        throw new DomainError(`Эпизод ${r.id} не в разборе: ${r.status}`, 409);
      if (manual && !['awaiting-lead', 'awaiting-user', 'stopped', 'analyzing'].includes(r.status))
        throw new DomainError(`Эпизод ${r.id} уже исполняет решение: ${r.status}`, 409);
      if (t.status === 'cancelled') throw new DomainError('Задача отменена', 409);
      const at = now();
      r.decision = decision;
      const retryable = t.attempt < this.config.maxAttempts;
      switch (decision.action) {
        case 'add-cases':
          if (!decision.cases?.length) throw new DomainError('add-cases без случаев', 400);
          r.status = 'applying';
          break;
        case 'new-approach':
          if (!decision.hypothesis?.trim() || !decision.plan?.trim())
            throw new DomainError('Новый подход требует гипотезы и плана проверки', 400);
          r.status = retryable ? 'retry' : 'awaiting-user';
          if (!retryable)
            r.reason = 'Попытки задачи исчерпаны: повтор с новой гипотезой невозможен.';
          break;
        case 'strengthen-checker':
        case 'split-task':
          if (!decision.proposal?.trim())
            throw new DomainError('Предложение для обычного ревью обязательно', 400);
          r.status = 'stopped';
          r.reason = `Подготовлено предложение (${decision.action}); оно проходит обычное ревью или перепланирование и автоматически не применяется.`;
          break;
        case 'clarify-obligation':
          r.status = 'awaiting-user';
          r.reason = `Нужно решение пользователя: ${decision.conflict ?? decision.reason}`;
          break;
        case 'environment':
          r.status = 'stopped';
          r.reason = `Причина в среде или не установлена: ${decision.reason}`;
          break;
      }
      r.version++;
      r.history.push({
        at,
        event: 'decided',
        detail: `${decision.action}: ${decision.reason.slice(0, 300)}`,
      });
      return { taskId, recovery: r.id, status: r.status, action: decision.action };
    });
    return structuredClone(task(this.store.read(), taskId).recovery!);
  }
  /** Итог добавления случаев: подтверждённый случай разрешает один повтор. */
  recoveryApplied(
    taskId: string,
    recoveryId: string,
    outcomes: { outcome: string; reason: string }[],
  ) {
    this.store.change('recovery.applied', (s) => {
      const t = task(s, taskId);
      const r = t.recovery;
      if (!r || r.id !== recoveryId || r.status !== 'applying')
        throw new DomainError('Эпизод не исполняет добавление случаев', 409);
      const confirmed = outcomes.filter((o) => o.outcome === 'confirmed').length;
      if (confirmed && t.attempt < this.config.maxAttempts) r.status = 'retry';
      else {
        r.status = 'stopped';
        r.reason = confirmed
          ? 'Случаи подтверждены, но попытки задачи исчерпаны.'
          : 'Ни один предложенный случай не подтверждён эталоном: ' +
            outcomes
              .map((o) => o.reason)
              .join('; ')
              .slice(0, 800);
      }
      r.version++;
      r.history.push({
        at: now(),
        event: 'applied',
        detail: `${confirmed} из ${outcomes.length} подтверждено`,
      });
      return { taskId, recovery: r.id, status: r.status };
    });
    return structuredClone(task(this.store.read(), taskId).recovery!);
  }
  /** Разбор прервался без решения: вызов учтён, повтор не бесплатен. */
  recoveryInterrupted(taskId: string, recoveryId: string, reason: string) {
    return this.store.change('recovery.interrupted', (s) => {
      const t = task(s, taskId);
      const r = t.recovery;
      if (!r || r.id !== recoveryId || !['analyzing', 'applying'].includes(r.status)) return;
      r.status = 'awaiting-user';
      r.reason = reason.slice(0, 1000);
      r.version++;
      r.history.push({ at: now(), event: 'interrupted', detail: r.reason });
      return { taskId, recovery: r.id };
    });
  }
  // Причина отмены остаётся в журнале: отменённая находка без неё неотличима
  // от забытой. Панель отменяет без причины, ведущий агент — с ней.
  cancel(id: string, reason?: string) {
    return this.store.change('task.cancelled', (s) => {
      const t = task(s, id);
      if (t.status === 'done')
        throw new DomainError('Принятый результат нельзя отменить; создайте корректировку');
      const r = s.runs.find((r) => r.id === t.activeRunId);
      if (r) {
        r.status = 'cancelled';
        r.finishedAt = now();
      }
      t.status = 'cancelled';
      t.activeRunId = undefined;
      return reason ? { taskId: id, reason } : { taskId: id };
    });
  }
  /**
   * Повтор после сбоя. Бюджет попыток защищает от задачи, которая крутится
   * вхолостую, но у оператора, устранившего причину, не было никакого способа
   * вернуть задачу в работу: лимит упирался в тупик, и единственным выходом
   * оставалась правка базы руками. Сброс возможен, он явный и с причиной —
   * она попадает в журнал рядом с попытками, которые сбрасываются.
   */
  /**
   * Вернуть в черновик задачу, которая ничего не произвела.
   *
   * Утверждённая постановка неизменна — и правильно: под неё уже велась работа.
   * Но пока задача не дала принятого результата, менять её бывает необходимо:
   * контракт исправлен до того, как доска принята, и переписывать под старый
   * контракт нечего. Штатного пути не было: `correct` требует принятой ревизии
   * и завершённых задач, `edit-task` — черновика. Оставался тупик, из которого
   * выходили правкой базы руками.
   *
   * Возврат разрешён только задаче без принятого результата. Прогоны остаются
   * в истории; утверждение снимается, и доску нужно провести через ревью плана
   * заново — иначе это был бы обход независимого согласования.
   */
  reopen(id: string, reason: string) {
    if (reason.trim().length < 10 || reason.length > 5000)
      throw new DomainError('Опишите причину возврата: от 10 до 5000 символов', 400);
    return this.store.change('task.reopened', (s) => {
      const t = task(s, id);
      if (t.resultSha)
        throw new DomainError('Задача дала принятый результат; нужна корректировка доски');
      if (t.activeRunId) throw new DomainError('Дождитесь завершения текущей попытки');
      assertNotAccepted(s, t);
      // Черновик тоже возвращается: снятое утверждение могло оставить за собой
      // digest контрактов, и задача продолжала бы закреплять одну редакцию,
      // ссылаясь на другую. Операция идемпотентна.
      const approved = t.approvedDigest;
      t.status = 'draft';
      t.approvedDigest = undefined;
      t.approvedScope = undefined;
      t.approval = undefined;
      // Digest контрактов принадлежит снятому утверждению. Оставить его значит
      // сказать, что задача закрепляет одну редакцию контракта, а ссылается на
      // другую: исполнитель получил бы противоречащие обязательства.
      t.contractDigests = {};
      t.failure = undefined;
      return { taskId: id, reason: reason.trim(), wasApproved: Boolean(approved) };
    });
  }
  /**
   * Удержать задачи от выдачи на время изменения их контракта. Задача,
   * удерживаемая другой операцией, — конфликт: две операции не меняют одну
   * задачу одновременно. Повтор той же операции ничего не меняет.
   */
  hold(ids: string[], operation: string, reason: string) {
    return this.store.change('task.held', (s) => {
      const tasks = ids.map((id) => task(s, id));
      const busy = tasks.filter((t) => t.hold && t.hold.operation !== operation);
      if (busy.length)
        throw new DomainError(
          'Задачи удерживает другая операция: ' +
            busy.map((t) => `${t.id} (${t.hold!.operation})`).join(', '),
          409,
        );
      for (const t of tasks) t.hold = { operation, reason };
      return tasks.map((t) => t.id);
    });
  }
  /** Снять удержание операции. Чужие удержания не трогаются. */
  release(operation: string) {
    return this.store.change('task.released', (s) => {
      const released = s.tasks.filter((t) => t.hold?.operation === operation);
      for (const t of released) t.hold = undefined;
      return released.map((t) => t.id);
    });
  }
  /**
   * Перепривязать задачи с прежних редакций контракта на новую. Задача
   * возвращается в черновик: её утверждение относилось к прежнему договору и
   * требует нового ревью плана. Выданные прогону и принятые задачи не
   * трогаются — первые дожидаются, вторые меняются корректировкой.
   */
  rebind(ids: string[], from: string[], to: string) {
    return this.store.change('task.rebound', (s) => {
      requireValue(
        s.contracts.find((c) => c.id === to),
        'Новая редакция контракта не найдена',
      );
      const rebound: string[] = [];
      for (const id of ids) {
        const t = task(s, id);
        if (t.activeRunId || t.resultSha || !['draft', 'ready', 'failed'].includes(t.status))
          continue;
        if (!t.contracts.some((c) => from.includes(c))) continue;
        t.contracts = [...new Set(t.contracts.map((c) => (from.includes(c) ? to : c)))];
        // Корпус принадлежит прежнему договору и его основанию эталона: новая
        // редакция начинает со своего корпуса. История принятий остаётся в
        // корпусе прежнего договора. Корпус другого, не заменённого договора
        // задачи остаётся обязательным.
        if (t.checkVersion && !t.contracts.includes(t.checkVersion.suite.replace(/^KS-/, '')))
          t.checkVersion = undefined;
        t.status = 'draft';
        t.approvedDigest = undefined;
        t.approvedScope = undefined;
        t.approval = undefined;
        t.contractDigests = {};
        t.failure = undefined;
        rebound.push(t.id);
      }
      return rebound;
    });
  }
  retry(id: string, reset?: { reason: string }) {
    return this.store.change('task.retry', (s) => {
      const t = task(s, id);
      // Задача на потолке попыток стоит в ready и молча не выдаётся: диспетчер
      // её не берёт, а повтор отказывал, потому что она не «сбой». Сброс
      // доступен из любого состояния, кроме идущей попытки: тупик одинаков.
      const exhaustedReady = t.attempt >= this.config.maxAttempts && !t.activeRunId;
      if (!['failed', 'cancelled'].includes(t.status) && !exhaustedReady)
        throw new DomainError('Повтор доступен после сбоя или отмены');
      assertNotAccepted(s, t);
      const spent = t.attempt;
      // Сбрасывать нечего, пока бюджет не исчерпан: сообщать о сбросе, которого
      // не было, значит записать в журнал неправду.
      const exhausted = t.attempt >= this.config.maxAttempts;
      if (exhausted) {
        if (!reset?.reason.trim())
          throw new DomainError(
            'Исчерпан лимит попыток. Устраните причину и повторите со сбросом, указав его причину',
          );
        t.attempt = 0;
      }
      t.status = t.approvedDigest ? 'ready' : 'draft';
      // Вместе с текстом отказа снимаются класс и отпечаток: пережив повтор,
      // они решали бы судьбу следующего отказа по причине предыдущего.
      t.failure = undefined;
      t.failureKind = undefined;
      t.failureFingerprint = undefined;
      return exhausted && reset
        ? { taskId: id, reset: { spent, reason: reset.reason.trim() } }
        : { taskId: id };
    });
  }
  expire(at = Date.now()) {
    return this.store.change('runs.expired', (s) => {
      const ids: string[] = [];
      for (const r of s.runs)
        if (r.status === 'active' && r.leaseUntil <= at) {
          r.status = 'expired';
          r.finishedAt = now();
          r.error =
            (r.error?.startsWith(HEARTBEAT_FAILED) ? r.error + '. ' : '') +
            'Истёк срок владения. Проверьте worktree и повторите явно.';
          // Потерянное владение — отказ окружения: исполнитель не довёл работу
          // не потому, что не справился. Класс ставится здесь, иначе решение о
          // починке прочитает класс прошлой попытки и починит не то.
          r.failureKind = 'environment';
          r.failureFingerprint = failureFingerprint('environment', r.error);
          const t = task(s, r.taskId);
          if (t.activeRunId === r.id) {
            t.status = 'failed';
            t.failure = r.error;
            t.failureKind = r.failureKind;
            t.failureFingerprint = r.failureFingerprint;
            t.activeRunId = undefined;
          }
          ids.push(r.id);
        }
      return ids;
    });
  }
  adopt(id: string, owner: string) {
    return this.store.change('run.recovered', (s) => {
      const r = requireValue(
        s.runs.find((r) => r.id === id),
        'Попытка не найдена',
      );
      if (r.status !== 'active' || r.leaseUntil > Date.now())
        throw new DomainError('Попытка ещё принадлежит worker');
      r.token = randomUUID();
      r.owner = owner;
      r.leaseUntil = Date.now() + this.config.leaseMs;
      return r;
    });
  }
  leader(owner: string) {
    const acquired = this.store.change('heartbeat', (s) => {
      if (s.leader && s.leader.owner !== owner && s.leader.leaseUntil > Date.now()) return false;
      s.leader = { owner, leaseUntil: Date.now() + this.config.leaseMs };
      return true;
    });
    if (acquired) this.ownLeader = owner;
    return acquired;
  }
}
