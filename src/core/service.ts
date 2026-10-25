import { domain, executionOf } from '../harness/execution.ts';
import { readFileSync, realpathSync } from 'node:fs';
import {
  developmentBinding,
  assertFeatureOf,
  assertTaskFeature,
  assertTaskPreparation,
} from './preparation.ts';
import { validateTaskContext, validateWorkflow } from './workflow.ts';
import { entityId } from './ids.ts';
import { createHash } from 'node:crypto';
import { repository, repositories, requiresContract, expandGates } from './repositories.ts';
import { Store } from './store.ts';
import { type FailureKind } from './failure.ts';
import { needsRecheck, taskChecks, taskEvidence, unprovenReason } from './proof.ts';
import { assertTaskProperties, type CheckDeclaration } from './checks.ts';
import {
  draftIssues,
  recoveryActions,
  uncoveredGates as harnessUncoveredGates,
  type CodedIssue,
  type PropertyRecovery,
} from 'devcontour-harness';
import { closeEpisodeIfBasisChanged } from '../harness/host.ts';
import { planResult } from './plan.ts';
import { boardOwner, completion, receiptHolds, receiptRecordBytes } from './sync-state.ts';
import { carriedTaskIds } from './work-status.ts';
import { assertDag, descendants, latestTaskId, impactGraph } from './graph.ts';
import {
  DomainError,
  requireValue,
  taskInput,
  discoveryInput,
  type Contract,
  type ContractArtifact,
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

/**
 * Gates профиля компонентов доски, не прошедшие integration ни в одной её
 * задаче. Задача, доказывающая себя всем профилем, покрывает его целиком;
 * пробел возникает, только когда задачи сузили область, — и тогда приёмка
 * доски его называет. Совместная проверка workspace к этому не относится: её
 * `workspaceGates` область задачи не сокращает.
 *
 * Wrapper без правил: правило покрытия — harness. DevContour выбирает только
 * evidence задачи под действующим договором (`taskEvidence`): успешной
 * попытки этого clone или receipt другого (для любой области: задача без
 * явной области выполнялась профилем своего времени, и gate, добавленный или
 * изменённый позже, ею не покрыт).
 */
export function uncoveredGates(h: DevContour, s: DevContourState, tasks: Task[]) {
  const ids = [...new Set(tasks.map((t) => t.repositoryId))];
  return harnessUncoveredGates(
    ids.map((id) => ({ id, gates: repository(h.config, id).gates })),
    tasks.map((t) => ({
      repositoryId: t.repositoryId,
      resultSha: t.resultSha,
      evidence: taskEvidence(s, t, h),
    })),
  );
}

/**
 * Размер receipt принятого результата. Попытка, receipt которой не строится
 * (прежняя без восстановимой policy), здесь не отклоняется: это ограничение
 * переноса, а не приёмки.
 */
export function receiptBytes(h: DevContour, s: DevContourState, t: Task) {
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
  /** Источник конфигурации не менялся с загрузки: `undefined` — да, иначе причина. */
  configProvenance(): string | undefined {
    const unchanged = sourceUnchanged(this.provenance);
    return unchanged.ok ? undefined : unchanged.reason;
  }
  /**
   * Процесс работает не с применённой конфигурацией и сменить её не вправе.
   * Правило — движка harness (`policyState().stale`): живой чужой controller,
   * изменённый источник или применённое после запуска поколение.
   */
  configStale() {
    const { engine } = executionOf(this);
    return !!engine.policyState().stale;
  }
  /**
   * Транзакция прикладного слоя под барьером применённой конфигурации: процесс
   * сверяет свою конфигурацию с применённой в той же записи (правило движка);
   * первый законный после правки файла процесс делает свою применённой — откат
   * отменит и это. Продуктовые поля меняются в документе транзакции.
   */
  /**
   * Барьер применённой конфигурации отдельной записью: отставший процесс
   * получает отказ; законный после правки файла — делает свою применённой.
   */
  assertCurrentConfig() {
    this.currentChange('config.checked', () => undefined);
  }
  currentChange<T>(kind: string, action: (state: DevContourState) => T): T {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host(kind, (ht) => {
        engine.assertCurrentPolicy(ht.tx);
        const result = action(ht.state);
        if (result !== undefined)
          ht.journal(
            result && typeof result === 'object' && !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : { result },
          );
        return result;
      }),
    );
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
  /** Пауза операции (правило движка): только если очередь не остановлена; пауза человека не перезаписывается. */
  operationPause(operation: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.operationPause(operation))
      ? { paused: true, reason: 'reconfigure', operation }
      : undefined;
  }
  /** Снять паузу операции — только свою; паузу человека она не трогает. */
  operationResume(operation: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.operationResume(operation))
      ? { paused: false, operation }
      : undefined;
  }
  /**
   * Запросить применение конфигурации с ожидаемым digest (идемпотентно).
   * Повтор той же операцией сбрасывает прежний отказ: файл могли исправить.
   */
  requestReconfigure(operation: string, configDigest: string) {
    const { engine } = executionOf(this);
    const r = domain(() => engine.requestReconfigure(operation, configDigest));
    if (!r.changed) return undefined;
    return { operation, digest: configDigest, ...(r.retried ? { retried: true } : {}) };
  }
  /**
   * Подтвердить применение (процесс уже работает с ожидаемой конфигурацией)
   * или записать отказ с причиной. Применение — правило движка: только при
   * совпадающем digest и без работ под прежней конфигурацией.
   */
  settleReconfigure(operation: string, configDigest: string, by: string, error?: string) {
    const { engine } = executionOf(this);
    if (error) {
      const rejected = domain(() => engine.rejectReconfigure(operation, configDigest, error));
      return rejected ? { operation, digest: configDigest, error } : undefined;
    }
    const request = engine.policyState().reconfigure;
    if (!request || request.operation !== operation || request.digest !== configDigest)
      return undefined;
    const applied = domain(() => engine.applyReconfigure(by));
    return applied.status === 'applied' ? { operation, digest: configDigest, by } : undefined;
  }
  /**
   * Запуск процесса применяет его конфигурацию: перезапуск — штатный способ
   * сменить любые поля. Только действующий controller; неприменённый запрос
   * операции остаётся (правило движка).
   */
  recordConfig(by: string) {
    const { engine } = executionOf(this);
    domain(() => engine.recordPolicy(by));
  }
  /** Снять завершённый запрос операции. */
  clearReconfigure(operation: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.clearReconfigure(operation)) ? { operation } : undefined;
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
  taskPolicyDigest(t: Pick<Task, 'repositoryId' | 'consumers'>): string {
    // Без потребителей договор задачи — сама политика компонента.
    const input = this.taskPolicyInput(t, digest);
    return t.consumers?.length ? digest(input) : (input as string);
  }
  /**
   * Содержимое договора задачи, из которого считается taskPolicyDigest.
   * `policy` задаёт, чем представлена политика компонента: digest (формула
   * договора) или сама запись (тождество проверок receipt — тот же договор
   * без потери полей).
   */
  taskPolicyInput(
    t: Pick<Task, 'repositoryId' | 'consumers'>,
    policy: (input: Record<string, unknown>) => unknown = (x) => x,
  ): unknown {
    const own = policy(this.policyInput(t.repositoryId));
    if (!t.consumers?.length) return own;
    return {
      own,
      consumers: t.consumers.map((c) => ({
        repositoryId: c.repositoryId,
        policy: policy(this.policyInput(c.repositoryId)),
        gates: expandGates(repository(this.config, c.repositoryId), c.gates),
      })),
    };
  }
  /** Receipt задачи из другого clone подтверждает её при текущей конфигурации. */
  receiptHolds(s: DevContourState, t: Task) {
    return receiptHolds(this, s, t);
  }
  policyDigest(repositoryId = 'main', legacy = false) {
    return digest(this.policyInput(repositoryId, legacy));
  }
  /** Запись политики компонента, digest которой — policyDigest. */
  policyInput(repositoryId = 'main', legacy = false): Record<string, unknown> {
    const repo = repository(this.config, repositoryId);
    return {
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
    };
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
      // Структура плана — общая проверка harness (`draftIssues`): повтор ключа,
      // неизвестная зависимость, цикл внутри плана. Хост сохраняет прежний
      // порядок и статусы отказов: повтор ключа — раньше всего (400),
      // неизвестная зависимость — у своей задачи до её проверок (404), цикл —
      // после проверок всех задач, тем же отказом, что у графа состояния.
      const issues = draftIssues(plan, { known: s.tasks.map((t) => t.id) });
      const at = (code: CodedIssue['code'], task?: number) =>
        issues.find((i) => i.code === code && (task === undefined || i.path[1] === task));
      if (at('GRAPH_DUPLICATE_ID')) throw new DomainError('Ключи задач должны быть уникальны', 400);
      const ids = new Map<string, string>();
      for (const t of plan.tasks) ids.set(t.key, entityId(s, 'T'));
      const tasks = plan.tasks.map((item, i) => {
        const unknown = at('GRAPH_UNKNOWN_DEPENDENCY', i);
        if (unknown) throw new DomainError(unknown.message, 404);
        const parsed = taskInput.parse({
          ...item,
          dependsOn: item.dependsOn.map((key) => ids.get(key) ?? key),
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
      // Цикл плана называется задачами состояния, как у любого цикла графа.
      const cycle = at('GRAPH_CYCLE');
      if (cycle) {
        assertDag(s.tasks);
        throw new DomainError(cycle.message);
      }
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
    return this.currentChange('board.approved', (s) => {
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
        closeEpisodeIfBasisChanged(t, now());
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
    return this.currentChange('board.accepted', (s) => {
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
        const unproven = unprovenReason(
          t.requirements,
          taskEvidence(s, t, this),
          t.resultSha,
          taskChecks(s, t, this),
        );
        if (unproven)
          throw new DomainError(
            needsRecheck(s, t, this)
              ? `${unproven}. Receipt задачи ${t.id} подтверждает другие проверки или не называет их (прежний формат) — нужна перепроверка задачи под текущей конфигурацией`
              : unproven,
          );
      }
      const uncovered = uncoveredGates(this, s, tasks);
      if (uncovered.length) {
        // Receipt другого clone с другими проверками или без их тождества
        // покрытия не даёт — причина названа: задачу нужно перепроверить.
        const recheck = tasks.filter((t) => needsRecheck(s, t, this)).map((t) => t.id);
        throw new DomainError(
          'Полный набор проверок не пройден: ' +
            uncovered.map((u) => `${u.repositoryId}: ${u.gates.join(', ')}`).join('; ') +
            ' — ни одна задача доски не прошла их на integration. ' +
            (recheck.length
              ? `Receipt задач ${recheck.join(', ')} подтверждает другие проверки или не называет их (прежний формат) — нужна перепроверка задач под текущей конфигурацией`
              : 'Добавьте задачу, чья область их включает'),
        );
      }
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
  /**
   * Пауза и продолжение очереди — wrapper без правил над паузой harness
   * (`pause`/`resume`): штатная остановка не подменяет паузу человека, решение
   * человека снимает паузу вместе с классами отказов и ожиданием проверки
   * базы. Паузу операции применения политики человек сначала забирает себе
   * (`pause('operator')` harness) — операция её уже не снимет, — затем снимает.
   * DevContour добавляет продуктовое условие продолжения: привязку разработки.
   */
  pause(value: boolean, reason: 'operator' | 'shutdown' = 'operator') {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host(value ? 'scheduler.paused' : 'scheduler.started', (ht) => {
        if (!value) developmentBinding(ht.state);
        // Решение человека заменяет паузу операции применения политики (как
        // и прежде): пауза переходит к человеку и снимается им. Выдачу до
        // применения конфигурации по-прежнему держит запрос операции.
        if (!value && engine.read((v) => v.control().pauseReason) === 'reconfigure')
          engine.pause('operator');
        const { control } = value ? engine.pause(reason) : engine.resume();
        const result = { paused: control.paused, reason: control.pauseReason };
        ht.journal(result);
        return result;
      }),
    );
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
  /** Передать удержание задач от одной операции другой без окна выдачи (правило движка). */
  transferHold(from: string, to: string, reason: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.transferHold(from, to, reason));
  }
  /** Снять удержание операции с перечисленных задач; чужие не трогаются. */
  releaseTasks(operation: string, ids: string[]) {
    const { engine } = executionOf(this);
    return domain(() => engine.releaseHold(operation, ids));
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
  /**
   * Выдача попытки — решение движка harness (пауза, барьеры, бюджеты,
   * предел попыток, продуктовые условия хоста); ожидание задачи до выдачи
   * движок пишет по сведениям хоста в той же транзакции, как и при выдаче
   * очередью.
   */
  claim(owner: string): Run | undefined {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host('run.claimed', (ht) => {
        const before = ht.state.leader;
        const leading = before?.owner === owner && before.leaseUntil > Date.now();
        if (!engine.lead(owner)) return undefined;
        const attempt = engine.claim(owner);
        // Выдаёт только controller; прямая выдача (не из очереди) роль за
        // вызвавшим не оставляет — как и прежде, она не запуск очереди.
        if (!leading) engine.release(owner);
        if (!attempt) return undefined;
        // Ожидание задачи (`wait`) записал движок в той же транзакции: время
        // готовности — от хоста (`devcontourHost.readyAt`).
        const s = ht.state;
        const run = s.runs.find((r) => r.id === attempt.id)!;
        run.callsRecorded = true;
        ht.journal({ taskId: run.taskId, runId: run.id });
        return structuredClone(run);
      }),
    );
  }
  /**
   * Продуктовая запись в попытку под её владением: владение и актуальность
   * проверяет движок в той же транзакции. Правил исполнения здесь нет.
   */
  withRun<T>(
    id: string,
    token: string,
    type: string,
    fn: (run: Run, t: Task, s: DevContourState) => T,
  ): T {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host(
        type,
        (ht) =>
          engine.withAttempt(id, token, 'run.context', () => {
            const s = ht.state;
            const r = requireValue(
              s.runs.find((r) => r.id === id),
              'Попытка не найдена',
            );
            const out = fn(r, task(s, r.taskId), s);
            // Возвращённое продуктовой записью — данные её события журнала, как прежде.
            if (out && typeof out === 'object' && !Array.isArray(out))
              ht.journal(out as Record<string, unknown>);
            return out as never;
          }) as T,
      ),
    );
  }
  heartbeat(id: string, token: string) {
    const { engine } = executionOf(this);
    domain(() => engine.heartbeat(id, token));
  }
  /**
   * Продление владения не удалось.  /**
   * Продление владения не удалось. Планировщик прерывал попытку молча, и
   * снаружи оставалось только «истёк срок владения» — причину (сменившаяся
   * политика, привязка к подготовке, сбой хранилища) узнать было неоткуда.
   * Причина записывается в попытку; истечение её не затирает.
   */
  heartbeatFailed(id: string, token: string, reason: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.heartbeatFailed(id, token, reason));
  }
  phase(
    id: string,
    token: string,
    phase: 'running' | 'verifying' | 'reviewing' | 'integrating',
    data: Partial<Pick<Run, 'baseSha' | 'candidateSha' | 'integrationSha' | 'worktree'>> = {},
  ) {
    const { engine } = executionOf(this);
    domain(() => engine.phase(id, token, phase, data));
  }
  evidence(id: string, token: string, evidence: Omit<Evidence, 'id' | 'runId' | 'createdAt'>) {
    const { engine } = executionOf(this);
    return domain(() =>
      engine.evidence(id, token, evidence as Parameters<typeof engine.evidence>[2]),
    );
  }
  /** Приёмка — решение движка: gates, ревью, потребители, требования, CAS в `publish`. */
  finish(id: string, token: string, sha: string, publish?: () => void) {
    const { engine } = executionOf(this);
    return domain(() => {
      const accepted = engine.finish(id, token, sha, publish);
      return { taskId: accepted.workId, runId: id, sha };
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
    const { engine } = executionOf(this);
    return domain(() =>
      engine.fail(id, token, error, {
        blocked,
        kind,
        ...(heartbeatCause ? { heartbeatCause } : {}),
        ...(properties ? { properties } : {}),
      }),
    );
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
    const { engine } = executionOf(this);
    return domain(() => {
      const r = engine.recoveryReserve(taskId, recoveryId);
      return { taskId, recovery: r.id, status: r.status, reason: r.reason };
    });
  }
  /**
   * Записать решение разбора — ведущего (автоматического) или ручное через
   * API. Правила эпизода — движка harness.
   */
  recoveryDecide(
    taskId: string,
    recoveryId: string,
    decision: NonNullable<PropertyRecovery['decision']>,
    expectedVersion?: number,
  ): PropertyRecovery {
    if (!recoveryActions.includes(decision.action))
      throw new DomainError('Неизвестное действие восстановления', 400);
    const { engine } = executionOf(this);
    domain(() => engine.recoveryDecide(taskId, recoveryId, decision, expectedVersion));
    return structuredClone(task(this.store.read(), taskId).recovery!);
  }
  /** Итог добавления случаев: подтверждённый случай разрешает один повтор. */
  recoveryApplied(
    taskId: string,
    recoveryId: string,
    outcomes: { outcome: string; reason: string }[],
  ) {
    const { engine } = executionOf(this);
    domain(() =>
      engine.recoveryApplied(
        taskId,
        recoveryId,
        outcomes as Parameters<typeof engine.recoveryApplied>[2],
      ),
    );
    return structuredClone(task(this.store.read(), taskId).recovery!);
  }
  /** Разбор прервался без решения: вызов учтён, повтор не бесплатен. */
  recoveryInterrupted(taskId: string, recoveryId: string, reason: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.recoveryInterrupted(taskId, recoveryId, reason));
  }
  // Причина отмены остаётся в журнале: отменённая находка без неё неотличима
  // от забытой. Панель отменяет без причины, ведущий агент — с ней.
  cancel(id: string, reason?: string) {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host('task.cancelled', (ht) => {
        const t = task(ht.state, id);
        if (t.status === 'done')
          throw new DomainError('Принятый результат нельзя отменить; создайте корректировку');
        engine.cancel(id, reason);
        const data = reason ? { taskId: id, reason } : { taskId: id };
        ht.journal(data);
        return data;
      }),
    );
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
   * удерживаемая другой операцией, — конфликт (правило движка).
   */
  hold(ids: string[], operation: string, reason: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.hold(ids, operation, reason));
  }
  /** Снять удержание операции. Чужие удержания не трогаются. */
  release(operation: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.releaseHold(operation));
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
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host('task.retry', (ht) => {
        const t = task(ht.state, id);
        // Продуктовое условие: принятую ревизией задачу повтор не трогает.
        assertNotAccepted(ht.state, t);
        const exhaustedReady = t.attempt >= this.config.maxAttempts && !t.activeRunId;
        if (!['failed', 'cancelled'].includes(t.status) && !exhaustedReady)
          throw new DomainError('Повтор доступен после сбоя или отмены');
        const spent = t.attempt;
        const exhausted = t.attempt >= this.config.maxAttempts;
        engine.retry(id, reset);
        const data =
          exhausted && reset
            ? { taskId: id, reset: { spent, reason: reset.reason.trim() } }
            : { taskId: id };
        ht.journal(data);
        return data;
      }),
    );
  }
  /** Истечение владения к моменту `at` — решение движка. */
  expire(at?: number) {
    const { engine } = executionOf(this);
    return domain(() => engine.expire(at));
  }
  adopt(id: string, owner: string): Run {
    const { engine } = executionOf(this);
    domain(() => engine.adopt(id, owner));
    return structuredClone(this.store.read().runs.find((r) => r.id === id)!);
  }
  leader(owner: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.lead(owner));
  }
}
