import { resolve } from 'node:path';
import { z } from 'zod';
import type { DevContour } from '../core/service.ts';
import { specDigest } from '../core/service.ts';
import {
  DomainError,
  type Board,
  type ChangeSet,
  type DevContourState,
  type Evidence,
  type Run,
  type Task,
} from '../core/model.ts';
import type { Delivery } from '../core/integrations.ts';
import type { PropertyRecovery } from '../core/property-recovery.ts';
import { blockers, readyTasks } from '../core/graph.ts';
import { repositories } from '../core/repositories.ts';
import { boardPhase, queueStopReason } from '../core/work-status.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { taskProgress } from './context.ts';
import { checksSummary } from './checks.ts';
import { DIAGNOSTIC, SHORT, clip, short } from './bounded.ts';

/**
 * Проекции панели. Периодический опрос получает ограниченную сводку: строки
 * досок, задачи выбранной доски, активные и последние попытки компактными
 * строками, компактные ChangeSet и контракты. Тела истории — evidence, логи,
 * findings, patch, снимки задач проверок, история восстановлений — только по
 * запросу деталей, страницами. Ответ не растёт с числом завершённых попыток,
 * проверок и событий.
 */

/** Сколько находок попытки ревью приходит сразу; остальные — страницами. */
const FINDINGS = 20;
/** Сколько последних записей истории эпизода восстановления приходит сразу. */
const RECOVERY_HISTORY = 20;
/** Хвост лога в деталях попытки. */
const LOG_TAIL = 4000;
const tail = (text: string) => (text.length > LOG_TAIL ? '…' + text.slice(-LOG_TAIL) : text);

/** Без токенов владения на любой глубине: они не для панели. */
function withoutTokens<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutTokens) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== 'token')
        .map(([k, v]) => [k, withoutTokens(v)]),
    ) as T;
  return value;
}

/**
 * Данные события для деталей журнала: только верхнеуровневые скаляры с
 * ограниченным текстом. Вложенные тела (контракт, evidence, снимки проверок)
 * событий не покидают — у них свои детали.
 */
function eventData(data: unknown): Record<string, string | number | boolean | null> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>).slice(0, 20)) {
    if (key === 'token') continue;
    // Длинная строка — тело (контракт, лог, вывод): вместо неё только длина.
    if (typeof value === 'string')
      out[key] = value.length <= 120 ? value : `[текст ${value.length} знаков]`;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      out[key] = value;
  }
  return out;
}

export type PanelEvidence = Pick<Evidence, 'id' | 'gate' | 'phase' | 'kind' | 'passed'> & {
  summary: string;
};
export type PanelRun = Pick<
  Run,
  | 'id'
  | 'taskId'
  | 'repositoryId'
  | 'attempt'
  | 'status'
  | 'phase'
  | 'startedAt'
  | 'finishedAt'
  | 'runtime'
  | 'reviewer'
  | 'model'
  | 'reviewerModel'
  | 'blocked'
  | 'reusedFrom'
  | 'failureKind'
> & {
  error?: string;
  boardId?: string;
  /** Последняя отметка стадии: с неё считается «сколько идёт фаза». */
  timings?: Run['timings'];
  /** Последний результат каждой проверки на фазу — значки задачи. */
  evidence: PanelEvidence[];
};

function runLine(run: Run, boardId: string | undefined): PanelRun {
  const latest = new Map<string, Evidence>();
  for (const e of run.evidence) latest.set(e.gate + e.phase, e);
  return {
    id: run.id,
    taskId: run.taskId,
    repositoryId: run.repositoryId,
    attempt: run.attempt,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    runtime: run.runtime,
    reviewer: run.reviewer,
    model: run.model,
    reviewerModel: run.reviewerModel,
    blocked: run.blocked,
    reusedFrom: run.reusedFrom,
    failureKind: run.failureKind,
    error: short(run.error),
    boardId,
    ...(run.status === 'active' && run.timings ? { timings: run.timings.slice(-1) } : {}),
    evidence: [...latest.values()].map((e) => ({
      id: e.id,
      gate: e.gate,
      phase: e.phase,
      kind: e.kind,
      passed: e.passed,
      summary: short(e.summary, 200) ?? '',
    })),
  };
}

/**
 * Задача для панели: без истории восстановлений и тела receipt. Тексты плана
 * (название, описание, приёмка) — целиком: по ним редактируют задачу, и их
 * объём задаёт план, а не история. Диагностика отказа — ограничена.
 */
function uiTask(h: DevContour, state: DevContourState, t: Task) {
  const { recoveryHistory: _history, sharedCompletion, failure, hold, recovery, ...rest } = t;
  return {
    ...rest,
    ...(failure !== undefined ? { failure: short(failure, DIAGNOSTIC) } : {}),
    ...(hold ? { hold: clip(hold) } : {}),
    ...(recovery
      ? {
          recovery: {
            ...clip(recovery),
            history: clip(recovery.history.slice(-5)),
            historyCount: recovery.history.length,
          },
        }
      : {}),
    ...(sharedCompletion
      ? {
          sharedCompletion: {
            ...sharedCompletion,
            receipt: {
              ...sharedCompletion.receipt,
              checks: [] as typeof sharedCompletion.receipt.checks,
            },
          },
        }
      : {}),
    recoveryCount: _history?.length ?? 0,
    specDigest: specDigest(t),
    blockers: blockers(t, state),
    progress: taskProgress(h, state, t),
    checks: clip(checksSummary(t)),
  };
}

/** Ревизия без задач снимка: принятый снимок хранит полные копии задач. */
function compactRevision(r: Board['revisions'][number]) {
  return r.snapshot ? { ...r, snapshot: { ...r.snapshot, tasks: [] as Task[] } } : r;
}
function boardTasks(board: Board) {
  return new Set(board.revisions.flatMap((r) => r.taskIds));
}

/** Компактная строка доски: навигация и прогресс без списков задач. */
function boardLine(state: DevContourState, board: Board, running: Set<string>) {
  const ids = boardTasks(board);
  const own = state.tasks.filter((t) => ids.has(t.id));
  const live = own.filter((t) => t.status !== 'cancelled');
  const done = live.filter((t) => t.status === 'done').length;
  const inWork = live.filter((t) => t.activeRunId).length;
  return {
    id: board.id,
    title: board.title,
    description: board.description,
    scope: board.scope,
    repositoryId: board.repositoryId,
    // Списки задач и снимки ревизий — только у выбранной доски.
    revisions: board.revisions.map(compactRevision).map((r) => ({ ...r, taskIds: [] as string[] })),
    taskCount: ids.size,
    phase: boardPhase(board, state.tasks),
    progress: live.length
      ? `${done} из ${live.length}` + (inWork ? ` · ${inWork} в работе` : '')
      : '',
    /** Доска, где вся работа отменена, — история, а не выбор. */
    live: own.length === 0 || live.length > 0,
    running: own.some((t) => running.has(t.id)),
  };
}
export type PanelBoard = ReturnType<typeof boardLine>;

/**
 * Проверка ChangeSet — перечисленными полями: без снимка задач, токена,
 * влияния и доказательства релиза; ошибка и отчёты гейтов ограничены, лог —
 * пустой в сводке и хвостом в деталях (целиком — `/evidence`).
 */
function verificationLine(v: ChangeSet['verifications'][number], logs: 'none' | 'tail') {
  return {
    id: v.id,
    status: v.status,
    startedAt: v.startedAt,
    finishedAt: v.finishedAt,
    policyDigest: v.policyDigest,
    specDigest: v.specDigest,
    manifestDigest: v.manifestDigest,
    manifest: v.manifest && clip(v.manifest, 200),
    boards: clip(v.boards, 200),
    error: short(v.error, DIAGNOSTIC),
    taskCount: v.tasks.length,
    evidence: v.evidence.slice(0, 50).map((e) => ({
      gate: short(e.gate, 200)!,
      passed: e.passed,
      exitCode: e.exitCode,
      digest: e.digest,
      command: clip(e.command, 200),
      summary: short(e.summary) ?? '',
      log: logs === 'none' ? '' : tail(e.log),
      artifactCount: e.artifacts.length,
    })),
  };
}
/** Поставка — перечисленными полями, без токена и срока; ошибка ограничена. */
function deliveryLine(d: Delivery) {
  return {
    id: d.id,
    verificationId: d.verificationId,
    manifestDigest: d.manifestDigest,
    policyDigest: d.policyDigest,
    status: d.status,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    error: short(d.error, DIAGNOSTIC),
    components: Object.fromEntries(
      Object.entries(d.components)
        .slice(0, 50)
        .map(([id, c]) => [
          id,
          {
            sha: c.sha,
            state: c.state,
            mr: c.mr,
            url: short(c.url, 500),
            mergedSha: c.mergedSha,
            checks: c.checks?.slice(0, 20).map((k) => ({
              name: short(k.name, 200)!,
              sha: k.sha,
              status: short(k.status, 100)!,
            })),
          },
        ]),
    ),
  };
}
/** ChangeSet — перечисленными полями: последняя проверка и её поставки. */
function changeSetLine(c: ChangeSet) {
  const last = c.verifications.at(-1);
  return {
    id: c.id,
    title: c.title,
    description: short(c.description, DIAGNOSTIC)!,
    /** Описание сокращено — целиком в деталях ChangeSet. */
    descriptionTruncated: c.description.length > DIAGNOSTIC,
    releaseId: c.releaseId,
    boardIds: c.boardIds,
    createdAt: c.createdAt,
    supersedes: c.supersedes,
    acceptance: c.acceptance && {
      at: c.acceptance.at,
      verificationId: c.acceptance.verificationId,
      digest: c.acceptance.digest,
      deliveryId: c.acceptance.deliveryId,
      approval: clip(c.acceptance.approval, 200),
    },
    verificationCount: c.verifications.length,
    verifications: last ? [verificationLine(last, 'none')] : [],
    deliveries: (c.deliveries ?? [])
      .filter((d) => d.verificationId === last?.id)
      .slice(-5)
      .map(deliveryLine),
  };
}

const summaryQuery = z.object({
  board: z.string().max(200).optional(),
  revision: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
  task: z.string().max(200).optional(),
  view: z.enum(['workspace']).optional(),
  accepted: z.enum(['1']).optional(),
});

function leaseOperations(state: DevContourState) {
  return state.changeSets.flatMap((c) => [
    ...c.verifications.filter((v) => v.status === 'active'),
    ...(c.deliveries ?? []).filter((d) => d.status === 'active'),
  ]);
}

/**
 * Из сроков владения панели важен только lease операции workspace: пока он
 * не истёк, задачи недоступны. Кэш со старыми сроками годится, пока ни один
 * показанный по нему срок не истёк после чтения кэша: продление срока
 * (heartbeat) ничего не меняет на экране, а heartbeat лидера и попыток
 * панели не касается вовсе. Истёкший срок, уже прочитанный истёкшим, не
 * продлевается (heartbeat операции отклоняется) — перечитывать незачем.
 */
function leaseStale(state: Readonly<DevContourState>, readAt: number) {
  const now = Date.now();
  return leaseOperations(state).some((o) => o.leaseUntil <= now && o.leaseUntil > readAt);
}

/**
 * Периодическая сводка. `revision` — номер данных, которые клиент уже
 * показывает для той же области (доска, задача, вид): если данные не
 * менялись, возвращается только номер. Продление lease номер не меняет:
 * сводка сообщает `expiresAt` — срок ближайшего lease операции workspace, —
 * и после него клиент запрашивает сводку целиком, получая новый срок или
 * снятую блокировку. Всё в ответе — из одного снимка БД.
 */
export function panelSummary(
  h: DevContour,
  root: string,
  query: Record<string, string | undefined>,
) {
  const q = summaryQuery.parse(query);
  return h.store.snapshot(() => {
    const shared = h.store.readShared(leaseStale);
    const state = shared.state as DevContourState;
    const now = Date.now();
    const leases = leaseOperations(state)
      .map((o) => o.leaseUntil)
      .filter((at) => at > now);
    // Номер — данные и то, действует ли сейчас блокировка операции. Продление
    // lease его не меняет, а смена блокировки меняет: так ответ, собранный из
    // снимка, который ещё не видел продления, не закрепится у клиента
    // ответами «без изменений».
    const revision = leases.length ? `${shared.revision}.1` : String(shared.revision);
    if (q.revision === revision) return { revision, unchanged: true as const };
    return buildSummary(h, root, q, state, revision, leases);
  });
}

function buildSummary(
  h: DevContour,
  root: string,
  q: z.infer<typeof summaryQuery>,
  state: DevContourState,
  revision: string,
  leases: number[],
) {
  const running = new Set(state.runs.filter((r) => r.status === 'active').map((r) => r.taskId));
  const boards = state.boards.map((b) => boardLine(state, b, running));
  const ranked = boards
    .map((b, i) => ({
      b,
      i,
      rank: b.running ? 0 : b.revisions.at(-1)?.status === 'active' ? 1 : 2,
    }))
    .filter((x) => x.b.live)
    .sort((x, y) => x.rank - y.rank || x.i - y.i);
  const boardId =
    (q.board && state.boards.some((b) => b.id === q.board) ? q.board : undefined) ??
    ranked[0]?.b.id ??
    state.boards[0]?.id;
  const board = state.boards.find((b) => b.id === boardId);
  const boardOf = new Map<string, string>();
  for (const b of state.boards) for (const id of boardTasks(b)) boardOf.set(id, b.id);
  const ready = readyTasks(state).map((t) => t.id);
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  // Задачи сводки: выбранная доска, их зависимости, выбранная задача, занятые,
  // готовые и ждущие решения. Остальные доски — компактными строками.
  const include = new Set<string>(board ? boardTasks(board) : []);
  const withDependencies = (id: string) => {
    include.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) include.add(dep);
  };
  for (const id of [...include]) withDependencies(id);
  if (q.task) withDependencies(q.task);
  for (const id of running) withDependencies(id);
  for (const id of ready) withDependencies(id);
  // Текущая работа: готовые (в том числе ждущие зависимостей), упавшие,
  // занятые и ждущие решения — со своими зависимостями. Это ограничено
  // объёмом действующих планов, а не историей. Полная очередь с черновиками
  // всех досок — страницами (`/api/queue`).
  for (const t of state.tasks)
    if (
      !['done', 'cancelled', 'draft'].includes(t.status) ||
      (t.recovery && t.recovery.status !== 'retry')
    )
      withDependencies(t.id);
  // Общий граф: текущие ревизии незакрытых досок и задачи, от которых они
  // зависят, даже на принятых досках; принятые доски целиком — по запросу.
  let workspaceTaskIds: string[] | undefined;
  if (q.view === 'workspace') {
    const shown = state.boards.filter(
      (b) => q.accepted === '1' || b.revisions.at(-1)?.status === 'active',
    );
    const ids = new Set(shown.flatMap((b) => b.revisions.at(-1)!.taskIds));
    for (const id of [...ids]) for (const dep of byId.get(id)?.dependsOn ?? []) ids.add(dep);
    workspaceTaskIds = [...ids];
    for (const id of ids) include.add(id);
  }
  const tasks = state.tasks
    .filter((t) => include.has(t.id))
    .map((t) => ({ ...uiTask(h, state, t), boardId: boardOf.get(t.id) }));
  const lastRun = new Map<string, Run>();
  for (const r of state.runs) if (include.has(r.taskId)) lastRun.set(r.taskId, r);
  const runs = [
    ...new Map(
      [...state.runs.filter((r) => r.status === 'active'), ...lastRun.values()].map((r) => [
        r.id,
        r,
      ]),
    ).values(),
  ].map((r) => runLine(r, boardOf.get(r.taskId)));
  const recent = h.store.events();
  const attempts = state.contractAttempts ?? [];
  return {
    revision,
    /**
     * Когда истечёт ближайший lease операции workspace: после этого момента
     * доступность задач меняется без записи, и клиент запрашивает сводку
     * заново.
     */
    expiresAt: leases.length ? Math.min(...leases) : undefined,
    boardId,
    board: board && {
      ...board,
      revisions: board.revisions.map(compactRevision),
      phase: boardPhase(board, state.tasks),
    },
    boards,
    tasks,
    workspaceTaskIds,
    acceptedBoards: boards.filter((b) => b.revisions.at(-1)?.status === 'accepted').length,
    runs,
    changeSets: state.changeSets.map(changeSetLine),
    // Контракт — строкой: текст, артефакты и обязательства проверки — в деталях.
    contracts: state.contracts.map((c) => ({
      id: c.id,
      title: c.title,
      repositoryId: c.repositoryId,
      digest: c.digest,
      approvedAt: c.approvedAt,
      contentBytes: c.content.length,
      artifactCount: c.artifacts?.length ?? 0,
      obligationCount: c.checks?.obligations.length ?? 0,
    })),
    // Последние попытки ревью без находок; все — страницами с находками.
    contractAttempts: attempts.slice(-20).map(({ findings, ...a }) => ({
      ...clip(a),
      findingsCount: findings.length,
    })),
    contractAttemptCount: attempts.length,
    paused: state.paused,
    pauseReason: state.pauseReason,
    waits: clip(state.waits),
    team: state.team,
    // Журнал в сводке — только строки; данные событий — в деталях журнала.
    events: recent.slice(0, 40).map((e) => ({ id: e.id, at: e.at, type: e.type })),
    stopReason: short(queueStopReason(state, recent), DIAGNOSTIC),
    journalError: short(h.store.projectionError, DIAGNOSTIC),
    workflows: new LeadWorkflow(h)
      .view()
      .map((w) => clip({ ...w, history: (w.history ?? []).slice(-5) })),
    dataRoot: resolve(root),
    ready,
    progress: progressOf(state),
    counts: {
      boards: state.boards.length,
      tasks: state.tasks.length,
      runs: state.runs.length,
      changeSets: state.changeSets.length,
    },
    config: {
      name: h.config.name,
      workspaceRoot: h.config.workspaceRoot,
      workspaceMode: h.config.workspaceMode,
      repositories: repositories(h.config),
      workspaceGates: h.config.workspaceGates,
      mode: h.config.mode,
      approvalMode: h.config.approvalMode,
      completionMode: h.config.completionMode,
      storage: h.config.storage,
      concurrency: h.config.concurrency,
      maxAttempts: h.config.maxAttempts,
      roles: h.config.roles,
      reviewer: h.config.reviewer,
      gates: h.config.gates,
      targetBranch: h.config.targetBranch,
      packs: h.config.packs,
    },
  };
}
export type PanelSummary = ReturnType<typeof buildSummary>;

/**
 * Агрегаты прогресса по всей истории: готовность по компонентам, проверки и
 * задачи без тестового evidence. Считаются на сервере — клиенту не нужны все
 * попытки.
 */
function progressOf(state: DevContourState) {
  const tasks = state.tasks.filter((t) => t.status !== 'cancelled');
  const repos = [...new Set(tasks.map((t) => t.repositoryId))].sort();
  const gates = new Map<
    string,
    { gate: string; passed: number; failed: number; tasks: Set<string>; phases: Set<string> }
  >();
  const covered = new Set<string>();
  for (const run of state.runs)
    for (const e of run.evidence) {
      if (e.kind !== 'test') continue;
      covered.add(run.taskId);
      const row = gates.get(e.gate) ?? {
        gate: e.gate,
        passed: 0,
        failed: 0,
        tasks: new Set<string>(),
        phases: new Set<string>(),
      };
      row[e.passed ? 'passed' : 'failed'] += 1;
      row.tasks.add(run.taskId);
      row.phases.add(e.phase);
      gates.set(e.gate, row);
    }
  const uncovered = tasks.filter((t) => t.status === 'done' && !covered.has(t.id));
  return {
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    drafts: tasks.filter((t) => t.status === 'draft').length,
    statuses: Object.fromEntries(
      [...new Set(tasks.map((t) => t.status))].map((s) => [
        s,
        tasks.filter((t) => t.status === s).length,
      ]),
    ),
    blocks: repos.map((id) => {
      const own = tasks.filter((t) => t.repositoryId === id);
      return { id, done: own.filter((t) => t.status === 'done').length, total: own.length };
    }),
    gates: [...gates.values()]
      .sort((a, b) => a.gate.localeCompare(b.gate))
      .map((g) => ({
        gate: g.gate,
        passed: g.passed,
        failed: g.failed,
        tasks: g.tasks.size,
        phases: [...g.phases],
      })),
    uncovered: uncovered.slice(0, 50).map((t) => ({ id: t.id, title: t.title })),
    uncoveredCount: uncovered.length,
  };
}

const page = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.coerce.number().int().min(0).default(0),
});
const paged = <T>(all: T[], query: Record<string, string | undefined>) => {
  const { limit, cursor } = page.parse(query);
  return {
    total: all.length,
    items: all.slice(cursor, cursor + limit),
    next: cursor + limit < all.length ? cursor + limit : null,
  };
};

function sharedState(h: DevContour) {
  return h.store.readShared().state as DevContourState;
}

/** Задача целиком и первая страница попыток (новые сначала) из одного снимка. */
export function panelTask(h: DevContour, id: string, query: Record<string, string | undefined>) {
  return h.store.snapshot(() => {
    const shared = h.store.readShared();
    const state = shared.state as DevContourState;
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new DomainError('Задача не найдена', 404);
    // Запись целиком; диагностика отказа и эпизоды восстановления — с
    // ограниченными строками, последние 20 эпизодов.
    const { failure, hold, recovery, recoveryHistory, ...rest } = task;
    return {
      revision: shared.revision,
      task: {
        ...withoutTokens(rest),
        // Квитанция завершения: проверки с первыми 200 testcases каждая.
        ...(rest.sharedCompletion
          ? {
              sharedCompletion: {
                ...rest.sharedCompletion,
                receipt: {
                  ...rest.sharedCompletion.receipt,
                  checks: rest.sharedCompletion.receipt.checks.slice(0, 50).map((c) => ({
                    ...c,
                    tests: c.tests && clip(c.tests.slice(0, 200), SHORT),
                    testsCount: c.tests?.length,
                  })),
                  checksCount: rest.sharedCompletion.receipt.checks.length,
                },
              },
            }
          : {}),
        ...(failure !== undefined ? { failure: short(failure, DIAGNOSTIC) } : {}),
        ...(hold ? { hold: clip(hold) } : {}),
        // Эпизоды восстановления: последние записи истории со счётчиком,
        // остальное — страницами (`/api/tasks/:id/recovery-history`).
        ...(recovery ? { recovery: recoveryLine(recovery, RECOVERY_HISTORY) } : {}),
        ...(recoveryHistory
          ? {
              recoveryHistory: recoveryHistory.slice(-20).map((r) => recoveryLine(r, 5)),
              recoveryHistoryCount: recoveryHistory.length,
            }
          : {}),
        specDigest: specDigest(task),
        blockers: blockers(task, state),
        progress: taskProgress(h, state, task),
        checks: clip(checksSummary(task)),
      },
      dependencies: task.dependsOn.map((d) => {
        const t = state.tasks.find((x) => x.id === d);
        return { id: d, title: t?.title, status: t?.status };
      }),
      runs: runsPage(state, id, query),
    };
  });
}

function recoveryLine(r: PropertyRecovery, history: number) {
  return { ...clip(r), history: clip(r.history.slice(-history)), historyCount: r.history.length };
}

/** История текущего эпизода восстановления задачи страницами, новые сначала. */
export function panelRecoveryHistory(
  h: DevContour,
  id: string,
  query: Record<string, string | undefined>,
) {
  const task = sharedState(h).tasks.find((t) => t.id === id);
  if (!task) throw new DomainError('Задача не найдена', 404);
  if (!task.recovery) throw new DomainError('У задачи нет эпизода восстановления', 404);
  const result = paged([...task.recovery.history].reverse(), query);
  return { ...result, items: clip(result.items) };
}

/**
 * Страница попыток задачи, новые сначала. `before` — id попытки: страница
 * строго старше неё. Такой курсор не сдвигается, когда появляются новые
 * попытки (в отличие от смещения).
 */
function runsPage(
  state: DevContourState,
  taskId: string,
  query: Record<string, string | undefined>,
) {
  const all = state.runs.filter((r) => r.taskId === taskId).reverse();
  const before = query.before;
  const from = before ? all.findIndex((r) => r.id === before) + 1 : 0;
  if (before && from === 0) throw new DomainError('Попытка курсора не найдена', 404);
  const { limit, cursor } = page.parse(before ? { ...query, cursor: '0' } : query);
  const start = before ? from : cursor;
  const items = all.slice(start, start + limit);
  return {
    total: all.length,
    items: items.map(runDetail),
    next: start + limit < all.length ? start + limit : null,
    nextBefore: start + limit < all.length ? items.at(-1)!.id : null,
  };
}
export function panelRuns(
  h: DevContour,
  taskId: string,
  query: Record<string, string | undefined>,
) {
  return runsPage(sharedState(h), taskId, query);
}

/**
 * Попытка для деталей: строки диагностики ограничены, лог — хвостом, тесты и
 * находки — первыми записями; patch черновика — только по своей команде.
 */
function runDetail(run: Run) {
  const { partial, evidence, ...rest } = run;
  return {
    ...clip(rest),
    // Токен владения попыткой — не для панели.
    token: '',
    ...(partial ? { partial: clip({ ...partial, patch: undefined }) } : {}),
    evidence: evidence.slice(0, 100).map(({ log, tests, findings, ...e }) => ({
      ...clip(e),
      log: tail(log),
      tests: tests && clip(tests.slice(0, 200), SHORT),
      testsCount: tests?.length,
      findings: findings && clip(findings.slice(0, 50), SHORT),
      findingsCount: findings?.length,
    })),
  };
}

export function panelRun(h: DevContour, id: string) {
  const run = sharedState(h).runs.find((r) => r.id === id);
  if (!run) throw new DomainError('Попытка не найдена', 404);
  return runDetail(run);
}

/**
 * ChangeSet: прежние проверки страницами (без снимков и токенов), поставки —
 * последними 20, снимок задач любой проверки — отдельной страницей по
 * `verification`.
 */
export function panelChangeSet(
  h: DevContour,
  id: string,
  query: Record<string, string | undefined>,
) {
  const c = sharedState(h).changeSets.find((x) => x.id === id);
  if (!c) throw new DomainError('ChangeSet не найден', 404);
  const history = paged([...c.verifications].reverse(), query);
  const chosen = query.verification
    ? c.verifications.find((v) => v.id === query.verification)
    : undefined;
  if (query.verification && !chosen) throw new DomainError('Проверка не найдена', 404);
  const deliveries = [...(c.deliveries ?? [])].reverse();
  return {
    ...changeSetLine(c),
    description: c.description,
    deliveries: deliveries.slice(0, 20).map(deliveryLine),
    deliveryCount: deliveries.length,
    history: { ...history, items: history.items.map((v) => verificationLine(v, 'tail')) },
    snapshot: chosen && {
      verificationId: chosen.id,
      ...(() => {
        const tasks = paged(chosen.tasks, {
          limit: query.taskLimit,
          cursor: query.taskCursor,
        });
        return {
          ...tasks,
          items: tasks.items.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            repositoryId: t.repositoryId,
            resultSha: t.resultSha,
            dependsOn: t.dependsOn,
          })),
        };
      })(),
    },
  };
}

export function panelContract(h: DevContour, id: string) {
  const c = sharedState(h).contracts.find((x) => x.id === id);
  if (!c) throw new DomainError('Контракт не найден', 404);
  return c;
}

/** Журнал событий страницами по ≤ 50: новые сначала, `before` — id события. */
export function panelEvents(h: DevContour, query: Record<string, string | undefined>) {
  const q = z
    .object({
      before: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(40),
    })
    .parse(query);
  const items = h.store
    .eventsPage(q.before, q.limit)
    .map((e) => ({ id: e.id, at: e.at, type: e.type, data: eventData(e.data) }));
  return { items, next: items.length === q.limit ? items.at(-1)!.id : null };
}

/**
 * Поиск задач по всем доскам для выбора зависимостей: компактные строки
 * страницами; `superseded` — у задачи есть замена (считается по всем задачам).
 */
export function panelTaskSearch(h: DevContour, query: Record<string, string | undefined>) {
  const state = sharedState(h);
  const text = (query.q ?? '').toLowerCase();
  const replaced = new Set(state.tasks.flatMap((t) => (t.supersedes ? [t.supersedes] : [])));
  const boardOf = new Map<string, string>();
  for (const b of state.boards) for (const id of boardTasks(b)) boardOf.set(id, b.id);
  const all = state.tasks.filter(
    (t) => !text || t.title.toLowerCase().includes(text) || t.id.toLowerCase().includes(text),
  );
  const result = paged(all, query);
  return {
    ...result,
    items: result.items.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      supersedes: t.supersedes,
      superseded: replaced.has(t.id),
      repositoryId: t.repositoryId,
      boardId: boardOf.get(t.id),
    })),
  };
}

/** Очередь всех досок: незавершённые и неотменённые задачи страницами. */
export function panelQueue(h: DevContour, query: Record<string, string | undefined>) {
  const state = sharedState(h);
  const active = ['running', 'verifying', 'reviewing', 'integrating'];
  const result = paged(
    state.tasks.filter((t) => !['done', 'cancelled', ...active].includes(t.status)),
    query,
  );
  return {
    ...result,
    items: result.items.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      role: t.role,
      repositoryId: t.repositoryId,
    })),
  };
}

/** Попытки ревью контрактов и планов страницами, новые сначала, с находками. */
export function panelContractAttempts(h: DevContour, query: Record<string, string | undefined>) {
  const result = paged([...(sharedState(h).contractAttempts ?? [])].reverse(), query);
  return {
    ...result,
    items: result.items.map(({ findings, ...a }) => ({
      ...clip(a),
      findings: clip(findings.slice(0, FINDINGS)),
      findingsCount: findings.length,
    })),
  };
}

/** Находки одной попытки ревью страницами — продолжение первых `FINDINGS`. */
export function panelContractAttemptFindings(
  h: DevContour,
  id: string,
  query: Record<string, string | undefined>,
) {
  const attempt = (sharedState(h).contractAttempts ?? []).find((a) => a.id === id);
  if (!attempt) throw new DomainError('Попытка ревью не найдена', 404);
  const result = paged(attempt.findings, query);
  return { ...result, items: clip(result.items) };
}
