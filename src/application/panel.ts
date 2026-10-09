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
import { blockers, readyTasks } from '../core/graph.ts';
import { repositories } from '../core/repositories.ts';
import { boardPhase, queueStopReason } from '../core/work-status.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { taskProgress } from './context.ts';
import { checksSummary } from './checks.ts';

/**
 * Проекции панели. Периодический опрос получает ограниченную сводку: строки
 * досок, задачи выбранной доски, активные и последние попытки компактными
 * строками, компактные ChangeSet и контракты. Тела истории — evidence, логи,
 * findings, patch, снимки задач проверок, история восстановлений — только по
 * запросу деталей, страницами. Ответ не растёт с числом завершённых попыток,
 * проверок и событий.
 */

/** Сколько знаков текста диагностики остаётся в компактной строке. */
const SHORT = 300;
/** Хвост лога в деталях попытки. */
const LOG_TAIL = 4000;
const short = (text: string | undefined, n = SHORT) =>
  text && text.length > n ? text.slice(0, n) + '…' : text;

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

/** Задача для панели: без истории восстановлений и тела receipt. */
function uiTask(h: DevContour, state: DevContourState, t: Task) {
  const { recoveryHistory: _history, sharedCompletion, ...rest } = t;
  return {
    ...rest,
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
    checks: checksSummary(t),
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

/** ChangeSet: последняя проверка без снимка задач и тел логов. */
function changeSetLine(c: ChangeSet) {
  const last = c.verifications.at(-1);
  return {
    ...c,
    verificationCount: c.verifications.length,
    verifications: last
      ? [
          {
            ...last,
            tasks: [],
            taskCount: last.tasks.length,
            evidence: last.evidence.map((e) => ({
              ...e,
              log: '',
              summary: short(e.summary) ?? '',
            })),
          },
        ]
      : [],
    deliveries: c.deliveries?.filter((d) => d.verificationId === last?.id),
  };
}

const summaryQuery = z.object({
  board: z.string().max(200).optional(),
  revision: z.coerce.number().int().min(0).optional(),
  task: z.string().max(200).optional(),
  view: z.enum(['workspace']).optional(),
});

/**
 * Периодическая сводка. `revision` — ревизия, которую клиент уже показывает:
 * если данные не менялись, возвращается только номер.
 */
export function panelSummary(
  h: DevContour,
  root: string,
  query: Record<string, string | undefined>,
) {
  const q = summaryQuery.parse(query);
  const revision = h.store.revision();
  if (q.revision === revision) return { revision, unchanged: true as const };
  const { state: shared } = h.store.readShared();
  const state = shared as DevContourState;
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
  // Задачи сводки: выбранная доска, их зависимости, выбранная задача, занятые,
  // готовые и ждущие решения. Остальные доски — компактными строками.
  const include = new Set<string>(board ? boardTasks(board) : []);
  for (const id of [...include])
    for (const dep of state.tasks.find((t) => t.id === id)?.dependsOn ?? []) include.add(dep);
  if (q.task) include.add(q.task);
  for (const id of running) include.add(id);
  for (const id of ready) include.add(id);
  // Текущая работа целиком: готовые (в том числе ждущие зависимостей),
  // упавшие, занятые и ждущие решения — со своими зависимостями. Это
  // ограничено объёмом действующих планов, а не историей.
  for (const t of state.tasks)
    if (
      !['done', 'cancelled', 'draft'].includes(t.status) ||
      (t.recovery && t.recovery.status !== 'retry')
    ) {
      include.add(t.id);
      for (const dep of t.dependsOn) include.add(dep);
    }
  // Вид всего workspace: задачи текущих ревизий незакрытых досок.
  const workspaceTaskIds =
    query.view === 'workspace'
      ? state.boards
          .filter((b) => b.revisions.at(-1)?.status === 'active')
          .flatMap((b) => b.revisions.at(-1)!.taskIds)
      : undefined;
  for (const id of workspaceTaskIds ?? []) include.add(id);
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
  const events = h.store.events().slice(0, 40);
  return {
    revision,
    boardId,
    board: board && {
      ...board,
      revisions: board.revisions.map(compactRevision),
      phase: boardPhase(board, state.tasks),
    },
    boards,
    tasks,
    workspaceTaskIds,
    runs,
    changeSets: state.changeSets.map(changeSetLine),
    contracts: state.contracts.map(({ content, ...c }) => ({ ...c, contentBytes: content.length })),
    contractAttempts: (state.contractAttempts ?? []).slice(-20),
    paused: state.paused,
    pauseReason: state.pauseReason,
    waits: state.waits,
    team: state.team,
    events,
    stopReason: queueStopReason(state, events),
    journalError: h.store.projectionError,
    workflows: new LeadWorkflow(h)
      .view()
      .map((w) => ({ ...w, history: (w.history ?? []).slice(-5) })),
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
export type PanelSummary = Exclude<ReturnType<typeof panelSummary>, { unchanged: true }>;

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

function sharedState(h: DevContour) {
  return h.store.readShared().state as DevContourState;
}

/** Задача целиком и первая страница попыток (новые сначала). */
export function panelTask(h: DevContour, id: string, query: Record<string, string | undefined>) {
  const state = sharedState(h);
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new DomainError('Задача не найдена', 404);
  return {
    revision: h.store.revision(),
    task: {
      ...task,
      specDigest: specDigest(task),
      blockers: blockers(task, state),
      progress: taskProgress(h, state, task),
      checks: checksSummary(task),
    },
    dependencies: task.dependsOn.map((d) => {
      const t = state.tasks.find((x) => x.id === d);
      return { id: d, title: t?.title, status: t?.status };
    }),
    runs: panelRuns(h, id, query),
  };
}

/** Страница попыток задачи: полные попытки с хвостами логов, новые сначала. */
export function panelRuns(
  h: DevContour,
  taskId: string,
  query: Record<string, string | undefined>,
) {
  const { limit, cursor } = page.parse(query);
  const all = sharedState(h)
    .runs.filter((r) => r.taskId === taskId)
    .reverse();
  return {
    total: all.length,
    items: all.slice(cursor, cursor + limit).map(runDetail),
    next: cursor + limit < all.length ? cursor + limit : null,
  };
}

function runDetail(run: Run) {
  const { partial, ...rest } = run;
  return {
    ...rest,
    // Токен владения попыткой — не для панели.
    token: '',
    ...(partial ? { partial: { ...partial, patch: undefined } } : {}),
    evidence: run.evidence.map((e) => ({
      ...e,
      log: e.log.length > LOG_TAIL ? '…' + e.log.slice(-LOG_TAIL) : e.log,
      tests: e.tests?.slice(0, 200),
    })),
  };
}

export function panelRun(h: DevContour, id: string) {
  const run = sharedState(h).runs.find((r) => r.id === id);
  if (!run) throw new DomainError('Попытка не найдена', 404);
  return runDetail(run);
}

/** ChangeSet: последняя проверка целиком и страницы прежних без снимков. */
export function panelChangeSet(
  h: DevContour,
  id: string,
  query: Record<string, string | undefined>,
) {
  const c = sharedState(h).changeSets.find((x) => x.id === id);
  if (!c) throw new DomainError('ChangeSet не найден', 404);
  const { limit, cursor } = page.parse(query);
  const all = [...c.verifications].reverse();
  const withTasks = query.tasks === '1';
  return {
    ...changeSetLine(c),
    deliveries: c.deliveries,
    history: {
      total: all.length,
      items: all.slice(cursor, cursor + limit).map((v, i) => ({
        ...v,
        tasks: withTasks && cursor + i === 0 ? v.tasks : [],
        taskCount: v.tasks.length,
        evidence: v.evidence.map((e) => ({
          ...e,
          log: e.log.length > LOG_TAIL ? '…' + e.log.slice(-LOG_TAIL) : e.log,
        })),
      })),
      next: cursor + limit < all.length ? cursor + limit : null,
    },
  };
}

export function panelContract(h: DevContour, id: string) {
  const c = sharedState(h).contracts.find((x) => x.id === id);
  if (!c) throw new DomainError('Контракт не найден', 404);
  return c;
}

/** Журнал событий страницами: новые сначала, `before` — id события. */
export function panelEvents(h: DevContour, query: Record<string, string | undefined>) {
  const q = z
    .object({
      before: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    })
    .parse(query);
  const items = h.store.eventsPage(q.before, q.limit);
  return { items, next: items.length === q.limit ? items.at(-1)!.id : null };
}

/** Поиск задач для выбора зависимостей: компактные строки страницами. */
export function panelTaskSearch(h: DevContour, query: Record<string, string | undefined>) {
  const { limit, cursor } = page.parse(query);
  const text = (query.q ?? '').toLowerCase();
  const all = sharedState(h).tasks.filter(
    (t) => !text || t.title.toLowerCase().includes(text) || t.id.toLowerCase().includes(text),
  );
  return {
    total: all.length,
    items: all.slice(cursor, cursor + limit).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      supersedes: t.supersedes,
      repositoryId: t.repositoryId,
    })),
    next: cursor + limit < all.length ? cursor + limit : null,
  };
}
