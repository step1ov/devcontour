// Отображение записей DevContour в нейтральные записи исполнения harness и
// обратно (docs/compatibility.md пакета, «Отображение записей»).
//
// Состояние остаётся одним документом DevContour. Чтение строит запись
// harness из записи DevContour и проверяет её схемой договора; запись
// переносит в запись DevContour только поля исполнения и сохраняет остальные
// поля хоста как есть. Недостающие у прежних записей сведения не
// выдумываются: необязательные поля остаются пустыми.
import {
  API_VERSION,
  HarnessError,
  attemptStateSchema,
  callRecordSchema,
  contractDocumentSchema,
  controlStateSchema,
  controllerLeaseSchema,
  graphStateSchema,
  jointVerificationStateSchema,
  reproductionRegistrySchema,
  workGraphDigest,
  workStateSchema,
  type AttemptState,
  type CallRecord,
  type ContractDocument,
  type ControlState,
  type ControllerLease,
  type GraphState,
  type JointVerificationState,
  type WorkOrder,
  type WorkState,
} from 'devcontour-harness';
import type { UsageRecord } from '../core/usage.ts';
import type {
  Board,
  Contract,
  DevContourState,
  Reproduction,
  Run,
  Task,
  Verification,
} from '../core/model.ts';
import { specDigest } from '../core/service.ts';
import { isDeepStrictEqual } from 'node:util';

/** Сведения хоста, которых нет в самих записях. */
export interface ProjectionOptions {
  /**
   * Digest нейтральной политики исполнения, под которой согласован граф
   * (`executionDigest`). Согласование DevContour привязано к digest политики
   * задачи; граф harness получает текущий digest хоста.
   */
  policyDigest(): string;
  /**
   * Digest утверждаемой части политики (`approvalPolicyDigest`). Задача,
   * утверждённая при другом, делает граф устаревшим: он проецируется с её
   * закреплением вместо текущего digest. Нет — закрепления не сверяются.
   */
  approvalPolicy?(): string;
  /** Область записи задачи без своей: область её роли из конфигурации. */
  roleScope?(task: Task): string[] | undefined;
  /**
   * Пакеты контекста задачи — названные ею и пакеты её роли в её компоненте
   * (выбор конфигурации); нет — только названные.
   */
  contextPacks?(task: Task): string[];
  /**
   * Текущий digest контракта. Неутверждённая задача ещё не закрепила
   * редакцию контракта: её поручение ссылается на текущую — ту, что закрепит
   * утверждение. Утверждённая задача без закреплённого digest — нарушение.
   */
  contractDigest?(id: string): string | undefined;
}

/** Граф задачи, не входящей ни в одну доску (возможно только у созданных движком). */
export const UNASSIGNED_GRAPH = 'devcontour-unassigned';

const invalid = (what: string, issue: string) =>
  new HarnessError('INVALID_INPUT', `${what}: запись не соответствует договору harness — ${issue}`);

/** Значение по схеме; иначе — явный отказ с названием записи, а не тихая подмена. */
function parsed<T>(
  schema: {
    safeParse(
      v: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
  value: unknown,
  what: string,
): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw invalid(what, `${first?.path.join('.') || '—'}: ${first?.message ?? ''}`);
}

/** Копия без ключей со значением undefined (схемы strict их не принимают иначе как отсутствие). */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Присвоить поля исполнения записи хоста: заданные — записать, отсутствующие — удалить. */
function assign(
  target: Record<string, unknown>,
  keys: readonly string[],
  source: Record<string, unknown>,
) {
  for (const key of keys) {
    if (source[key] === undefined) delete target[key];
    else target[key] = structuredClone(source[key]);
  }
}

/* ------------------------------------------------------------------ */
/* Доски и графы                                                       */
/* ------------------------------------------------------------------ */

/** Ревизия доски, по которой идёт исполнение: активная, иначе последняя. */
export const activeRevision = (board: Board) =>
  board.revisions.find((r) => r.status === 'active') ?? board.revisions.at(-1);

/** Доска задачи: в активной ревизии которой она есть, иначе последняя, где она была. */
export function boardOf(state: DevContourState, taskId: string): Board | undefined {
  return (
    state.boards.find((b) => activeRevision(b)?.taskIds.includes(taskId)) ??
    state.boards.findLast((b) => b.revisions.some((r) => r.taskIds.includes(taskId)))
  );
}

/**
 * Digest контракта — из того же состояния, в котором прочитана задача. Иначе
 * каждая задача без утверждённой постановки перечитывала и разбирала всё
 * хранилище: на такте очереди с сотней задач это была большая часть его
 * стоимости.
 */
const withState = (state: DevContourState, options?: ProjectionOptions) =>
  options && {
    ...options,
    contractDigest: (id: string) => state.contracts.find((c) => c.id === id)?.digest,
  };

/** Поручение задачи: поля постановки DevContour в форме `WorkOrder`. */
export function orderOf(task: Task, options?: ProjectionOptions): WorkOrder {
  // Без области у задачи и роли — весь репозиторий, как прежде; защищённые
  // и генерируемые пути по-прежнему ограничивают запись.
  const writeScope = task.writePaths?.length
    ? task.writePaths
    : options?.roleScope?.(task)?.length
      ? options.roleScope(task)!
      : ['.'];
  const contracts = task.contracts.map((id) => {
    const digest =
      task.contractDigests?.[id] ??
      (task.approvedDigest ? undefined : options?.contractDigest?.(id));
    if (!digest) throw invalid('Задача ' + task.id, `нет закреплённого digest контракта ${id}`);
    return { id, digest };
  });
  return defined({
    apiVersion: API_VERSION,
    id: task.id,
    source: {
      connector: 'devcontour',
      ref: task.id,
      revision: task.approvedDigest ?? specDigest(task),
    },
    title: task.title,
    goal: task.description,
    acceptance: task.acceptance,
    role: task.role,
    repositoryId: task.repositoryId,
    relatedRepositories: task.relatedRepositories ?? [],
    writeScope,
    dependsOn: task.dependsOn,
    gates: task.gates,
    consumers: task.consumers,
    properties: task.properties,
    resources: task.resources,
    requirements: task.requirements ?? [],
    contracts,
    context: options?.contextPacks?.(task) ?? task.contextPacks ?? [],
  });
}

/** Поля исполнения задачи — те же имена и формы, что у `WorkState`. */
const workFields = [
  'status',
  'attempt',
  'activeRunId',
  'resultSha',
  'failure',
  'failureKind',
  'failureFingerprint',
  'approvedAt',
  'approvedDigest',
  'approvedScope',
  'approval',
  'hold',
  'budgetBlock',
  'checkVersion',
  'recovery',
  'recoveryHistory',
  'neutralFailures',
] as const;

export function workOf(state: DevContourState, task: Task, options?: ProjectionOptions): WorkState {
  const value = defined({
    id: task.id,
    graphId: boardOf(state, task.id)?.id ?? UNASSIGNED_GRAPH,
    order: orderOf(task, withState(state, options)),
    ...Object.fromEntries(workFields.map((k) => [k, task[k]])),
  });
  return parsed(workStateSchema, value, 'Задача ' + task.id);
}

/**
 * Запись поручения в задачу. Постановку ведёт продукт: у существующей задачи
 * поручение должно совпадать с её постановкой, меняются только поля
 * исполнения. Задача, которой нет, создаётся из поручения (так хранилище
 * проходит общий договор; в DevContour задачи создаёт продукт).
 */
export function putWork(state: DevContourState, work: WorkState, options?: ProjectionOptions) {
  const next = parsed(workStateSchema, work, 'Поручение ' + work.id);
  const task = state.tasks.find((t) => t.id === next.id);
  if (task) {
    if (JSON.stringify(orderOf(task, withState(state, options))) !== JSON.stringify(next.order))
      throw new HarnessError(
        'INVALID_INPUT',
        `Поручение ${next.id}: постановку задачи меняет продукт, а не исполнение`,
      );
    assign(task as unknown as Record<string, unknown>, workFields, next);
    return;
  }
  const o = next.order;
  const created = defined({
    id: o.id,
    title: o.title,
    description: o.goal,
    role: o.role,
    repositoryId: o.repositoryId,
    scope: 'component' as const,
    relatedRepositories: o.relatedRepositories.length ? o.relatedRepositories : undefined,
    acceptance: o.acceptance,
    dependsOn: o.dependsOn,
    contracts: o.contracts.map((c) => c.id),
    contractDigests: Object.fromEntries(o.contracts.map((c) => [c.id, c.digest])),
    contextPacks: o.context.length ? o.context : undefined,
    writePaths: o.writeScope,
    gates: o.gates,
    consumers: o.consumers,
    properties: o.properties,
    resources: o.resources,
    requirements: o.requirements.length ? o.requirements : undefined,
    createdAt: new Date().toISOString(),
  }) as unknown as Task;
  assign(created as unknown as Record<string, unknown>, workFields, next);
  state.tasks.push(created);
}

/**
 * Граф доски: поручения задач её активной ревизии, выпущенных из черновика.
 * Согласование графа — согласования этих задач: оно есть, если у каждой
 * задачи графа есть утверждение; время — последнего из них. Ни одной такой
 * задачи — графа нет.
 */
export function graphOf(
  state: DevContourState,
  board: Board,
  options: ProjectionOptions,
): GraphState | undefined {
  const revision = activeRevision(board);
  if (!revision) return undefined;
  const tasks = revision.taskIds
    .map((id) => state.tasks.find((t) => t.id === id))
    // Черновик ещё не выпущен; отменённая до утверждения задача не выпускалась
    // вовсе. Утверждение DevContour — у задач: граф согласован, когда
    // утверждены все выпущенные.
    .filter(
      (t): t is Task =>
        !!t && t.status !== 'draft' && !(t.status === 'cancelled' && !t.approvedDigest),
    );
  if (!tasks.length) return undefined;
  const graph = {
    apiVersion: API_VERSION,
    id: board.id,
    source: { connector: 'devcontour', ref: board.id, revision: String(revision.number) },
    orders: tasks.map((t) => orderOf(t, withState(state, options))),
    prerequisites: [],
  };
  const digest = workGraphDigest(graph);
  // Утверждение задачи — её утверждённая постановка; запись `approval` (кто
  // утвердил) есть не у всех прежних задач и признаком не служит.
  // Завершённые задачи (в том числе принятые другим клоном и полученные
  // синхронизацией) уже не выдаются: согласование нужно тем, что ещё в работе.
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  // Признак утверждения — утверждённая постановка; время записано не у всех
  // (задачи, полученные синхронизацией), тогда — время ревизии.
  const approved = open.every((t) => t.approvedDigest);
  const at =
    (open.length ? open : tasks)
      .map((t) => t.approvedAt ?? '')
      .sort()
      .at(-1) || revision.createdAt;
  // Политика, при которой граф согласован, — закреплённая утверждением задач
  // (`approvedPolicy`). Утверждённая при другой политике задача делает граф
  // устаревшим, и движок его работу не выдаёт: смена gate, правила ревью или
  // области записи не применяется к плану без повторного утверждения.
  // Утверждение прежней версии без закрепления — при текущей политике.
  const current = options.policyDigest();
  const approvedPolicy = options.approvalPolicy?.();
  const stalePin = approvedPolicy
    ? open.find((t) => t.approvedPolicy && t.approvedPolicy !== approvedPolicy)?.approvedPolicy
    : undefined;
  const policyDigest = stalePin ?? current;
  return parsed(
    graphStateSchema,
    defined({
      id: board.id,
      digest,
      graph,
      policyDigest,
      approval:
        approved && at
          ? {
              actor: (open.length ? open : tasks).every((t) => t.approval?.actor === 'agent')
                ? 'agent'
                : 'operator',
              digest,
              at,
            }
          : undefined,
      registeredAt: revision.createdAt,
    }),
    'Доска ' + board.id,
  );
}

/**
 * Запись графа. Граф регистрирует продукт (импорт плана, ревизии доски):
 * регистрация нового графа исполнением отклоняется. Согласование графа
 * DevContour хранит у задач — его записывает `putWork` той же транзакции;
 * здесь проверяется только, что состав графа — состав доски.
 */
export function putGraph(state: DevContourState, graph: GraphState, options: ProjectionOptions) {
  const next = parsed(graphStateSchema, graph, 'Граф ' + graph.id);
  const board = state.boards.find((b) => b.id === next.id);
  if (!board)
    throw new HarnessError('INVALID_INPUT', 'В DevContour граф регистрирует продукт: ' + next.id);
  const current = graphOf(state, board, options);
  const ids = (g?: GraphState) => JSON.stringify(g?.graph.orders.map((o) => o.id).sort() ?? []);
  if (ids(current) !== ids(next))
    throw new HarnessError('INVALID_INPUT', `Граф ${next.id}: состав доски меняет продукт`);
}

/* ------------------------------------------------------------------ */
/* Попытки                                                             */
/* ------------------------------------------------------------------ */

const attemptKeys = Object.keys(attemptStateSchema.shape).filter(
  (k) => k !== 'workId' && k !== 'repositoryId' && k !== 'runtime' && k !== 'reviewer',
);

const toHarnessRuntime = (r: string) => (r === 'demo' ? 'fixture' : r);
const toHostRuntime = (r: string) => (r === 'fixture' ? 'demo' : r);

/**
 * Продолжение попытки в форме договора harness. Ранние версии записывали
 * источник продолжения иначе, и такие записи остались в истории:
 *
 * - без `kind` — продолжался только черновик попытки, исчерпавшей время
 *   (других источников не было): незаконченная работа, отказ `timeout`;
 * - `kind: 'timeout'` — тот же черновик по времени: незаконченная работа,
 *   отказ `timeout`;
 * - `kind: 'review'` — кандидат, отклонённый ревью: кандидат, отказ `review`.
 *
 * Класс отказа источника в этих формах был самим `kind`; записанный `reason`
 * не заменяется. Запись в базе не переписывается: перевод — только на
 * границе чтения, а `putAttempt` возвращает прежнюю форму, если движок её
 * не менял. Неизвестное значение не подменяется — его отклоняет схема.
 */
export function continuationOf(
  from: Run['continuedFrom'],
): AttemptState['continuedFrom'] | Run['continuedFrom'] {
  if (!from) return from;
  const legacy =
    from.kind === undefined || from.kind === 'timeout'
      ? { kind: 'unfinished' as const, reason: 'timeout' as const }
      : from.kind === 'review'
        ? { kind: 'candidate' as const, reason: 'review' as const }
        : undefined;
  if (!legacy) return from;
  return { ...from, kind: legacy.kind, reason: from.reason ?? legacy.reason };
}

/**
 * Разобранные попытки замороженного снимка. Снимок версии данных неизменяем,
 * и его попытка — тот же объект, пока версия та же: схема разбирает её один
 * раз, а не на каждом такте очереди (`claim`, `expire`, `recover` читают все
 * попытки). Изменяемое состояние транзакции не кешируется; вызывающий
 * получает свою копию.
 */
const parsedAttempts = new WeakMap<Run, AttemptState>();

export function attemptOf(state: DevContourState, run: Run): AttemptState {
  const frozen = Object.isFrozen(run) && Object.isFrozen(state.tasks);
  const hit = frozen ? parsedAttempts.get(run) : undefined;
  if (hit) return structuredClone(hit);
  const attempt = projectAttempt(state, run);
  if (frozen) parsedAttempts.set(run, structuredClone(attempt));
  return attempt;
}

function projectAttempt(state: DevContourState, run: Run): AttemptState {
  const repositoryId =
    run.repositoryId ?? state.tasks.find((t) => t.id === run.taskId)?.repositoryId ?? 'main';
  const value = defined({
    ...Object.fromEntries(
      attemptKeys.map((k) => [k, (run as unknown as Record<string, unknown>)[k]]),
    ),
    continuedFrom: continuationOf(run.continuedFrom),
    workId: run.taskId,
    repositoryId,
    runtime: toHarnessRuntime(run.runtime),
    reviewer: toHarnessRuntime(run.reviewer),
  });
  return parsed(attemptStateSchema, value, 'Попытка ' + run.id);
}

/** Запись попытки: поля попытки перезаписываются, поля хоста (`memory`, …) сохраняются. */
export function putAttempt(state: DevContourState, attempt: AttemptState) {
  const next = parsed(attemptStateSchema, attempt, 'Попытка ' + attempt.id);
  let run = state.runs.find((r) => r.id === next.id);
  if (!run) {
    run = { id: next.id } as Run;
    state.runs.push(run);
  }
  const target = run as unknown as Record<string, unknown>;
  // Продолжение прежней формы, которое движок не менял, остаётся как записано.
  const recorded = run.continuedFrom;
  assign(target, attemptKeys, next);
  if (recorded && isDeepStrictEqual(defined(continuationOf(recorded)!), next.continuedFrom))
    run.continuedFrom = recorded;
  target.taskId = next.workId;
  target.repositoryId = next.repositoryId;
  target.runtime = toHostRuntime(next.runtime);
  target.reviewer = toHostRuntime(next.reviewer);
}

/* ------------------------------------------------------------------ */
/* Управление очередью                                                 */
/* ------------------------------------------------------------------ */

export function controlOf(state: DevContourState): ControlState {
  return parsed(
    controlStateSchema,
    defined({
      paused: state.paused,
      pauseReason: state.pauseReason,
      pausedAt: state.pausedAt,
      pauseOperation: state.pauseOperation,
      pauseFailures: state.pauseFailures,
      waits: state.waits,
      appliedPolicy: state.appliedConfig,
      reconfigure: state.reconfigure,
    }),
    'Управление очередью',
  );
}

export function setControl(state: DevContourState, control: ControlState) {
  const next = parsed(controlStateSchema, control, 'Управление очередью');
  const target = state as unknown as Record<string, unknown>;
  target.paused = next.paused;
  assign(
    target,
    ['pauseReason', 'pausedAt', 'pauseOperation', 'pauseFailures', 'waits', 'reconfigure'],
    next,
  );
  if (next.appliedPolicy) state.appliedConfig = structuredClone(next.appliedPolicy);
  else delete state.appliedConfig;
}

export const controllerOf = (state: DevContourState): ControllerLease | undefined =>
  state.leader ? parsed(controllerLeaseSchema, state.leader, 'Роль controller') : undefined;

export function setController(state: DevContourState, lease: ControllerLease | undefined) {
  if (lease) state.leader = parsed(controllerLeaseSchema, lease, 'Роль controller');
  else delete state.leader;
}

/* ------------------------------------------------------------------ */
/* Совместные проверки                                                 */
/* ------------------------------------------------------------------ */

const verificationKeys = [
  'id',
  'token',
  'leaseUntil',
  'engineVersion',
  'startedAt',
  'finishedAt',
  'status',
  'policyDigest',
  'specDigest',
  'manifest',
  'manifestDigest',
  'impact',
  'evidence',
  'error',
] as const;

export function verificationOf(v: Verification): JointVerificationState {
  return parsed(
    jointVerificationStateSchema,
    defined({
      apiVersion: API_VERSION,
      ...Object.fromEntries(verificationKeys.map((k) => [k, v[k]])),
      workIds: v.tasks.map((t) => t.id),
    }),
    'Совместная проверка ' + v.id,
  );
}

export const verificationsOf = (state: DevContourState) =>
  state.changeSets.flatMap((c) => c.verifications.map(verificationOf));

/**
 * Запись совместной проверки. Проверка живёт в ChangeSet; новую добавляет
 * хост (операция ChangeSet знает, к какому набору она относится), здесь —
 * только изменение существующей. Снимок задач и доски остаются полями хоста.
 */
export function putVerification(
  state: DevContourState,
  verification: JointVerificationState,
  /** ChangeSet, операция которого начинает новую проверку (`withJointTarget`). */
  target?: string,
) {
  const next = parsed(
    jointVerificationStateSchema,
    verification,
    'Совместная проверка ' + verification.id,
  );
  const v = state.changeSets.flatMap((c) => c.verifications).find((x) => x.id === next.id);
  if (!v) {
    const changeSet = target ? state.changeSets.find((c) => c.id === target) : undefined;
    if (!changeSet)
      throw new HarnessError(
        'INVALID_INPUT',
        'Совместную проверку DevContour начинает операция ChangeSet: ' + next.id,
      );
    // Снимок задач и доски дописывает операция ChangeSet в той же записи.
    const created = {
      tasks: next.workIds.map((id) =>
        structuredClone(
          state.tasks.find((t) => t.id === id) ??
            (() => {
              throw new HarnessError('NOT_FOUND', 'Задача не найдена: ' + id);
            })(),
        ),
      ),
      boards: [],
    } as unknown as Verification;
    assign(created as unknown as Record<string, unknown>, verificationKeys, next);
    changeSet.verifications.push(created);
    return;
  }
  if (JSON.stringify(v.tasks.map((t) => t.id)) !== JSON.stringify(next.workIds))
    throw new HarnessError(
      'INVALID_INPUT',
      `Совместная проверка ${next.id}: состав задач не меняется`,
    );
  assign(v as unknown as Record<string, unknown>, verificationKeys, next);
}

/* ------------------------------------------------------------------ */
/* Локальные записи                                                    */
/* ------------------------------------------------------------------ */

/** Пространство harness → пространство `local_workflow` DevContour. */
export const hostNamespace: Record<string, string> = {
  usage: 'usage',
  'check-suites': 'check-suites',
  'workflow-jobs': 'lead',
  spikes: 'spikes',
  'context-snapshots': 'context-snapshots',
  'run-keys': 'run-keys',
  delivery: 'delivery',
  reviews: 'reviews',
  'contract-documents': 'contract-documents',
};

/** Учёт вызова: `taskId` ↔ `workId`, `boardId` ↔ `groupId`, `taskIds` ↔ `workIds`. */
export function callOf(record: UsageRecord): CallRecord {
  const { taskId, boardId, taskIds, ...rest } = record;
  return parsed(
    callRecordSchema,
    defined({ ...rest, workId: taskId, groupId: boardId, workIds: taskIds }),
    'Вызов модели ' + record.id,
  );
}
export function usageOf(call: CallRecord): UsageRecord {
  const { workId, groupId, workIds, ...rest } = parsed(
    callRecordSchema,
    call,
    'Вызов модели ' + call.id,
  );
  return defined({ ...rest, taskId: workId, boardId: groupId, taskIds: workIds }) as UsageRecord;
}

/** Документ контракта DevContour в форме harness (по digest контракта). */
export function contractDocumentOf(contract: Contract): ContractDocument {
  return parsed(
    contractDocumentSchema,
    defined({
      apiVersion: API_VERSION,
      id: contract.id,
      repositoryId: contract.repositoryId,
      title: contract.title,
      content: contract.content,
      artifacts: contract.artifacts?.map((a) => ({ path: a.path, blob: a.blob })),
      checks: contract.checks,
    }),
    'Контракт ' + contract.id,
  );
}

/** Реестр воспроизведений задачи: записи состояния с её `taskId`, в прежнем порядке. */
export function reproductionsOf(state: DevContourState, taskId: string) {
  const items = (state.reproductions ?? []).filter((r) => r.taskId === taskId);
  if (!items.length) return undefined;
  return parsed(
    reproductionRegistrySchema,
    {
      workId: taskId,
      items: items.map((r) => ({
        key: r.key,
        property: r.property,
        inputHash: r.inputHash,
        input: r.input,
        // Только записанное: у записей прежних версий поля нет.
        ...(r.inputClass ? { inputClass: r.inputClass } : {}),
        expected: r.expected,
        actual: r.actual,
        command: r.command,
        message: r.message,
        claimed: r.claimed,
        observed: r.observed,
        run: r.run ?? null,
        runs: r.runs.map((x) => ({ runId: x.runId, sha: x.sha, at: x.at })),
      })),
    },
    'Воспроизведения задачи ' + taskId,
  );
}

/**
 * Запись реестра задачи обратно в массив состояния: записи других задач не
 * трогаются; у сохранившихся записей остаются поля хоста (id, contracts
 * прогонов), новые получают id по ключу.
 */
export function putReproductions(
  state: DevContourState,
  registry: ReturnType<typeof reproductionRegistrySchema.parse>,
) {
  const next = parsed(
    reproductionRegistrySchema,
    registry,
    'Воспроизведения задачи ' + registry.workId,
  );
  const prior = new Map(
    (state.reproductions ?? []).filter((r) => r.taskId === next.workId).map((r) => [r.key, r]),
  );
  const items: Reproduction[] = next.items.map((item) => {
    const old = prior.get(item.key);
    return {
      ...(old ?? { id: 'RP-' + item.key.slice(0, 16), status: 'proposed' as const }),
      key: item.key,
      taskId: next.workId,
      property: item.property,
      input: item.input,
      ...(item.inputClass ? { inputClass: item.inputClass } : {}),
      inputHash: item.inputHash,
      expected: item.expected,
      actual: item.actual,
      command: item.command,
      message: item.message,
      claimed: item.claimed,
      observed: item.observed,
      run: item.run,
      runs: item.runs.map((r) => ({
        ...(old?.runs.find((x) => x.runId === r.runId && x.sha === r.sha) ?? { contracts: {} }),
        runId: r.runId,
        sha: r.sha,
        at: r.at,
      })),
    };
  });
  state.reproductions = [
    ...(state.reproductions ?? []).filter((r) => r.taskId !== next.workId),
    ...items,
  ];
}
