// Пакет передачи контекста новой сессии ведущего агента: сборка и отрисовка —
// общие функции devcontour-harness (`handoffPack`, `handoffMarkdown`) над
// движком DevContour и тем же хранилищем, что у исполнения. Пакет только
// читает состояние: моделей не вызывает, записей и событий не создаёт.
//
// Это не handoff публикации ChangeSet (`devcontour handoff --changeset`):
// тот готовит результат к push/PR человеком.
import {
  Harness,
  handoffMarkdown,
  handoffPack,
  redactor,
  type ExecutionView,
  type HandoffPack,
  type WorkflowJob as HarnessJob,
} from 'devcontour-harness';
import { z } from 'zod';
import { DomainError, type Config } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import { loopAhead, type LoopOutlook } from '../runner/lead-outlook.ts';
import { repositories } from '../core/repositories.ts';
import { executionOf, toDomain } from '../harness/execution.ts';
import type { DevContourExecutionStore } from '../harness/store.ts';

export const handoffFormats = ['json', 'md'] as const;
export type HandoffFormat = (typeof handoffFormats)[number];

/**
 * Намерения — по правилу пакета harness: пробелы по краям снимаются, пустые
 * строки отбрасываются, непустых не больше 20 (иначе 400), строка длиннее
 * 1000 знаков усекается и считается в `truncated.intentions`. Схема задаёт
 * только транспортный предел.
 */
export const handoffRequestInput = z.strictObject({
  /** Доска DevContour — граф harness с тем же id; без неё — вся доска workspace. */
  boardId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
  /** Намерения агента: единственный текст пакета не из хранилища. */
  intentions: z.array(z.string().max(10_000)).max(100).optional(),
});

/** Вход операции `session_handoff` агентского API. */
export const handoffInput = handoffRequestInput.extend({
  format: z.enum(handoffFormats).default('json'),
});

export type HandoffRequest = z.infer<typeof handoffRequestInput>;

/**
 * Команды harness в `next.command` пакета (`handoffCommands`) и что делать в
 * DevContour. Controller очереди — работающий сервер контура; работу доски
 * продолжает её задание ведущего (`workflow_start`), а не сервер сам по себе.
 * Правила цикла — `loopOutlook` (src/runner/lead-outlook.ts).
 */
export const handoffHostCommands = {
  'harness run':
    'Not a DevContour command. The running server holds the controller role but does not lift pauses itself: a board continues under its lead workflow job (workflow_start {"kind": "board", "id": BOARD, "authorRuntime": …}; workflow_status lists jobs). With approvalMode agent the job loop, at stage 1 (tasks), lifts the initial pause, the shutdown pause and an operator pause set before the job started, and checks a moved base itself (base-check); at stage 2 (acceptance) it lifts only the shutdown pause. It retries failed tasks within the repair budget and stops the job when the budget or the failure class allows no retry. With approvalMode operator jobs do not run: the operator starts the queue and retries. host.next names the step for this pack.',
  'harness resume':
    'queue_set {"paused": false}, or devcontour queue --start --workspace …; an operator pause is lifted only on the user\'s decision.',
} as const;

/** Шаг DevContour вместо команды harness: что сделать ведущему агенту или человеку. */
export interface HandoffHostNext {
  action:
    | 'workflow_start'
    | 'workflow_retry'
    | 'wait'
    | 'queue_set'
    | 'decide'
    | 'fix-input'
    | 'operator';
  boardId?: string;
  /** Задание ведущего, к которому относится шаг. */
  job?: {
    key: string;
    repositoryId?: string;
    status: string;
    stage: number;
    attempts: number;
    maxAttempts: number;
    repairs: number;
  };
  /** Что сделает цикл ведущего по этому заданию на следующем такте (`loopOutlook`). */
  loop?: LoopOutlook;
  detail: string;
}

/** Пакет harness и приложение DevContour. */
export interface DevContourHandoff {
  pack: HandoffPack;
  host: {
    next?: HandoffHostNext;
    /** Доски с действующим заданием ведущего (его очередь продолжает сервер). */
    liveBoards: string[];
  };
}

/** Владельцы заданий ведущего: workspace и компоненты (как `LeadWorkflow.view`). */
const ownersOf = (config: Config) => [undefined, ...repositories(config).map((r) => r.id)];

type State = ReturnType<DevContourExecutionStore['stateOf']>;
/** Задание harness как задание ведущего DevContour (тот же объект, другой `kind`). */
const asLead = (job: HarnessJob) => ({ ...job, kind: 'board' }) as unknown as WorkflowJob;

/**
 * Вход задания доски по состоянию: digest и владелец (правило
 * `LeadWorkflow.staleBoards`) или причина, по которой его не построить
 * (нет согласованной подготовки, у доски нет задач) — тогда и
 * `workflow_start` откажет с той же причиной.
 */
function boardInputs(h: DevContour) {
  const lead = new LeadWorkflow(h);
  const cache = new WeakMap<State, Map<string, { digest: string; owner?: string } | string>>();
  return (id: string, state: State) => {
    let byBoard = cache.get(state);
    if (!byBoard) {
      byBoard = new Map<string, { digest: string; owner?: string } | string>();
      cache.set(state, byBoard);
    }
    if (!byBoard.has(id))
      try {
        byBoard.set(id, lead.input('board', id, state));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        byBoard.set(id, error.message);
      }
    return byBoard.get(id)!;
  };
}

/**
 * Harness для `handoffPack` поверх движка DevContour. `Harness.open` открывает
 * собственную базу harness, а исполнение DevContour идёт движком над его
 * хранилищем (`executionOf`), поэтому пакету дан вид с теми полями, которые
 * он читает: `engine`, `policy`, `workflows` и методы `status` прототипа.
 *
 * Задание графа harness в DevContour — задание ведущего по доске (id доски —
 * id графа) у любого владельца: пакет и диагнозы видят его счётчик
 * восстановлений, а продолжает ли оно работу, решает очередь заданий
 * DevContour с её продуктовым входом (`LeadWorkflow.queue`). Задания
 * ChangeSet графу не соответствуют и в пакет не входят. В режиме
 * `approvalMode: operator` цикл ведущего заданий не исполняет
 * (`LeadRunner.advance`): ни одно задание не продолжается.
 *
 * Порядок списка (и `repairs` пакета: у доски бывает несколько заданий):
 * действующие задания первыми, затем задания по текущему входу доски, затем
 * новые первыми.
 */
function harnessOf(h: DevContour) {
  const { engine, store } = executionOf(h);
  const queue = new LeadWorkflow(h).queue();
  const owners = ownersOf(h.config);
  const operator = h.config.approvalMode === 'operator';
  const inputOf = boardInputs(h);
  const continues = (
    job: HarnessJob,
    view: ExecutionView,
    options: { reconfigureApplies?: boolean } = {},
  ) => !operator && queue.continues({ ...job, kind: 'board' }, view, options);
  const current = (job: HarnessJob, state: State) => {
    const bound = inputOf(job.id, state);
    return (
      typeof bound !== 'string' && bound.digest === job.inputDigest && bound.owner === job.owner
    );
  };
  const list = (): HarnessJob[] =>
    store.read((view) => {
      const state = store.stateOf(view);
      const options = { reconfigureApplies: engine.reconfigureApplies(view) };
      const rank = (job: HarnessJob) =>
        (continues(job, view, options) ? 0 : 2) + (current(job, state) ? 0 : 1);
      return owners
        .flatMap((owner) => queue.list(owner))
        .filter((job) => job.kind === 'board')
        .map((job): HarnessJob => ({ ...job, kind: 'graph' }))
        .sort(
          (a, b) =>
            rank(a) - rank(b) ||
            (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0),
        );
    });
  const workflows = { list, continues };
  const harness = Object.assign(Object.create(Harness.prototype) as Harness, {
    engine,
    policy: engine.policy,
    workflows,
  });
  return { harness, workflows, engine, current, inputOf };
}

/** Наследуемое значение короче — обычное слово или число, а не учётные данные. */
const MIN_INHERITED = 8;

/**
 * Маска текстов пакета. Переданная маска заменяет маску пакета по умолчанию
 * (секреты политики), поэтому здесь собраны все известные значения контура,
 * заданные в окружении читающего процесса:
 * - секреты (`secrets`) любого профиля окружения — конфигурации DevContour
 *   (workspace, компоненты, preview, профили инструментов) и политики
 *   harness — тем же обходом, что `policySecrets` пакета (его функция не
 *   экспортирована, поэтому здесь обход той же формы), — и MCP
 *   `bearerTokenEnv`, токены подключений forge (`tokenEnv`) любой длины;
 * - наследуемые значения (`inherit`) и переменные MCP (`env`) не короче
 *   8 знаков: короткие («1», «true») маскировали бы обычный текст.
 */
export function handoffRedactor(config: Config, policy: unknown, source = process.env) {
  const values = new Set<string>();
  const add = (name: unknown, min = 1) => {
    const value = typeof name === 'string' ? source[name] : undefined;
    if (value && value.length >= min) values.add(value);
  };
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'secrets' && v && typeof v === 'object' && !Array.isArray(v))
        Object.values(v as Record<string, unknown>).forEach((name) => add(name));
      if ((key === 'inherit' || key === 'env') && Array.isArray(v))
        (v as unknown[]).forEach((name) => add(name, MIN_INHERITED));
      if (key === 'bearerTokenEnv' || key === 'tokenEnv') add(v);
      walk(v);
    }
  };
  walk(config);
  walk(policy);
  return redactor([...values]);
}

/** Сведения задания для шага хоста. */
const jobRef = (job: HarnessJob) => ({
  key: job.key,
  ...(job.owner ? { repositoryId: job.owner } : {}),
  status: job.status,
  stage: job.stage,
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  repairs: job.repairs ?? 0,
});

/** Что сделает цикл — словами для `detail`. */
function loopText(o: LoopOutlook) {
  switch (o.step) {
    case 'review-plan':
      return 'reviews the plan';
    case 'advance':
      return 'finishes its stage';
    case 'recovery':
      return `handles the property episode of task ${o.taskId} (${o.action})`;
    case 'repair':
      return `retries task ${o.taskId} (${o.reason})`;
    case 'stop':
      return `stops the job: ${o.reason}`;
    case 'check-base':
      return 'checks the moved base';
    case 'lift-pause':
      return `lifts the ${o.pause} pause`;
    case 'wait':
      return "waits for the board's tasks";
    case 'accept':
      return 'accepts the board';
    case 'none':
      return 'has nothing to do';
  }
}

/** Как снять остановку цикла: задачу чинит человек или ведущий, не повтор задания. */
const STOP_REMEDY =
  'Diagnose it; fix or retry the task by hand (devcontour retry --task ID [--reset --reason TEXT]; a property episode — recovery_decide) or ask the user. Retrying the job (workflow_retry) before that fails again.';

interface HostContext {
  h: DevContour;
  pack: HandoffPack;
  view: ExecutionView;
  state: State;
  /** Задания досок (вид графа) в порядке `harnessOf`. */
  jobs: HarnessJob[];
  live: (job: HarnessJob) => boolean;
  current: (job: HarnessJob) => boolean;
  /** Причина, по которой вход доски не построить, или `undefined`. */
  inputError: (boardId: string) => string | undefined;
}

const OPERATOR_STEP =
  'approvalMode operator: lead workflow jobs do not run. The operator reviews plans and accepts boards in the panel, starts the queue (devcontour queue --start --workspace …) and retries failed tasks (devcontour retry --task ID --workspace …).';

/** Шаг по заданиям одной доски: ждать, повторить, начать, исправить вход или решить. */
function boardStep(boardId: string, ctx: HostContext): HandoffHostNext {
  const { h, state } = ctx;
  const jobs = ctx.jobs.filter((j) => j.id === boardId);
  const live = jobs.find(ctx.live);
  if (live) {
    const { stage, outlook: loop } = loopAhead(h, state, asLead(live));
    if (loop.step === 'stop')
      return {
        action: 'decide',
        boardId,
        job: jobRef(live),
        loop,
        detail: `Next, at stage ${stage}, the lead workflow job of board ${boardId} stops: ${loop.reason}. ${STOP_REMEDY}`,
      };
    return {
      action: 'wait',
      boardId,
      job: jobRef(live),
      loop,
      detail: `Board ${boardId} has a live lead workflow job (stage ${live.stage}); next, at stage ${stage}, the job loop ${loopText(loop)}. The running DevContour server continues it; if the server is stopped, start it (devcontour start --workspace …).`,
    };
  }
  const refused = ctx.inputError(boardId);
  if (refused)
    return {
      action: 'fix-input',
      boardId,
      detail: `workflow_start for board ${boardId} would be refused: ${refused}. Fix that first (approvals in the panel, tasks of the board), then register the job.`,
    };
  const job = jobs.find((j) => ctx.current(j));
  if (job?.status === 'failed') {
    if (job.attempts < job.maxAttempts) {
      // Повтор задания — тот же такт цикла по состоянию сейчас.
      const { outlook: loop } = loopAhead(h, state, { ...asLead(job), status: 'queued' });
      if (loop.step === 'stop')
        return {
          action: 'decide',
          boardId,
          job: jobRef(job),
          loop,
          detail: `The lead workflow job of board ${boardId} failed${job.error ? ': ' + job.error : ''}, and a retry would stop again: ${loop.reason}. ${STOP_REMEDY} Then workflow_retry {"key": ${JSON.stringify(job.key)}${job.owner ? ', "repositoryId": ' + JSON.stringify(job.owner) : ''}}.`,
        };
      return {
        action: 'workflow_retry',
        boardId,
        job: jobRef(job),
        loop,
        detail: `The lead workflow job of board ${boardId} failed${job.error ? ': ' + job.error : ''}. On retry the job loop ${loopText(loop)}: workflow_retry {"key": ${JSON.stringify(job.key)}${job.owner ? ', "repositoryId": ' + JSON.stringify(job.owner) : ''}}.`,
      };
    }
    return {
      action: 'decide',
      boardId,
      job: jobRef(job),
      detail: `The lead workflow job of board ${boardId} used all ${job.maxAttempts} attempts${job.error ? ': ' + job.error : ''}. workflow_start returns this failed job until the board input changes: diagnose, then change the board or its tasks (a new input registers a new job) or ask the user.`,
    };
  }
  if (job?.status === 'stale' || job?.status === 'completed')
    return {
      action: 'decide',
      boardId,
      job: jobRef(job),
      detail: `A lead workflow job for exactly the current input of board ${boardId} is already ${job.status}${job.status === 'stale' ? ' (the input changed and then returned to it)' : ''}; workflow_start returns it unchanged and it will not run. Change the board or its tasks to register a new job, or continue by hand (devcontour queue --start, retry, accept; docs/cli.md), or ask the user.`,
    };
  if (job)
    return {
      action: 'wait',
      boardId,
      job: jobRef(job),
      detail: `The lead workflow job of board ${boardId} is ${job.status} but does not continue now (a policy apply is pending or another process holds it); check workflow_status.`,
    };
  const running = ctx.pack.active.some((a) => ctx.view.work(a.workId)?.graphId === boardId);
  const previous = jobs.find((j) => j.status !== 'completed');
  return {
    action: 'workflow_start',
    boardId,
    ...(previous ? { job: jobRef(previous) } : {}),
    detail:
      `No live lead workflow job for board ${boardId}${previous ? ` (its ${previous.status} job was started on another input)` : ''}: with the DevContour server running, register workflow_start {"kind": "board", "id": ${JSON.stringify(boardId)}, "authorRuntime": …}; queue_set {"paused": false} alone resumes dispatch without the job's pause handling and repairs.` +
      (running
        ? ' An attempt is running: the server finishes it without a job; the board can also be continued by hand (devcontour retry, accept; docs/cli.md).'
        : ''),
  };
}

/** Срочность шага при выборе одного из досок workspace. */
const urgency: Record<HandoffHostNext['action'], number> = {
  decide: 0,
  'fix-input': 0,
  operator: 0,
  queue_set: 1,
  workflow_retry: 1,
  workflow_start: 2,
  wait: 3,
};

/**
 * Шаг DevContour по состоянию и правилам цикла ведущего (`loopOutlook`), а не
 * по `next.command`: с работающим сервером роль controller жива, и пакет
 * команды не называет, хотя исходную паузу и паузу остановки снимает только
 * цикл задания доски.
 */
function hostNext(ctx: HostContext): HandoffHostNext | undefined {
  const { pack, view, state, h } = ctx;
  if (!pack.summary.open) return undefined;
  if (h.config.approvalMode === 'operator') return { action: 'operator', detail: OPERATOR_STEP };
  if (state.paused) {
    // Пауза выдачи общая: её снимает любое действующее задание, чей цикл
    // снимет её на следующем такте.
    for (const job of ctx.jobs.filter(ctx.live)) {
      const { stage, outlook: loop } = loopAhead(h, state, asLead(job));
      if (loop.step === 'lift-pause')
        return {
          action: 'wait',
          boardId: job.id,
          job: jobRef(job),
          loop,
          detail: `Dispatch is paused (${state.pauseReason ?? 'initial'}); the lead workflow job of board ${job.id} lifts the pause at stage ${stage}. The running DevContour server continues it; if the server is stopped, start it (devcontour start --workspace …).`,
        };
    }
    if (state.pauseReason === 'operator')
      return {
        action: 'queue_set',
        detail:
          'Dispatch is paused by the operator and no job loop lifts it: resume only on the user\'s decision with queue_set {"paused": false} (devcontour queue --start).',
      };
  }
  const workId = pack.next.workId;
  const board = (workId ? view.work(workId)?.graphId : undefined) ?? pack.graphId;
  if (board && state.boards.some((b) => b.id === board)) return boardStep(board, ctx);
  const boards = [...new Set(pack.works.map((w) => w.graphId))].filter((id) =>
    state.boards.some((b) => b.id === id),
  );
  const steps = boards.map((id) => boardStep(id, ctx));
  return steps.sort((a, b) => urgency[a.action] - urgency[b.action])[0];
}

/**
 * Пакет передачи контекста workspace или одной доски (до 256 КБ, предел
 * пакета) и приложение DevContour. Только чтение; пакет и задания досок —
 * один снимок хранилища.
 */
export function devcontourHandoff(h: DevContour, input: HandoffRequest = {}): DevContourHandoff {
  // CLI передаёт флаги как есть: формат id и транспортный предел — той же схемой.
  const parsed = handoffRequestInput.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      400,
    );
  const request = parsed.data;
  const { harness, workflows, engine, current, inputOf } = harnessOf(h);
  const { store } = executionOf(h);
  const { boardId } = request;
  try {
    return store.read((v) => {
      const state = store.stateOf(v);
      if (boardId !== undefined) {
        if (!state.boards.some((b) => b.id === boardId))
          throw new DomainError('Доска не найдена: ' + boardId, 404);
        if (!v.graph(boardId))
          throw new DomainError(
            `Доска ${boardId} ещё не выпущена: у неё нет утверждённых или выпущенных задач`,
            409,
          );
      }
      const pack = handoffPack(harness, {
        ...(boardId !== undefined ? { graphId: boardId } : {}),
        ...(request.intentions ? { intentions: request.intentions } : {}),
        redact: handoffRedactor(h.config, engine.policy),
      });
      const options = { reconfigureApplies: engine.reconfigureApplies(v) };
      const jobs = workflows.list();
      const live = (job: HarnessJob) => workflows.continues(job, v, options);
      const liveBoards = [...new Set(jobs.filter(live).map((j) => j.id))];
      const next = hostNext({
        h,
        pack,
        view: v,
        state,
        jobs,
        live,
        current: (job) => current(job, state),
        inputError: (id) => {
          const bound = inputOf(id, state);
          return typeof bound === 'string' ? bound : undefined;
        },
      });
      return { pack, host: { ...(next ? { next } : {}), liveBoards } };
    });
  } catch (error) {
    throw toDomain(error);
  }
}

/**
 * Ответ пакета — один вид у операции агентского API и CLI: JSON —
 * `{format, pack, host, commands}`, `md` — `{format, markdown, host,
 * commands}`; Markdown — текст пакета harness и раздел DevContour.
 */
export function handoffResponse(value: DevContourHandoff, format: HandoffFormat) {
  const { pack, host } = value;
  return format === 'md'
    ? {
        format,
        markdown: handoffMarkdown(pack) + hostMarkdown(host),
        host,
        commands: handoffHostCommands,
      }
    : { format, pack, host, commands: handoffHostCommands };
}

function hostMarkdown(host: DevContourHandoff['host']) {
  return [
    '',
    '## В DevContour',
    '',
    ...(host.next ? [`- **Следующий шаг: ${host.next.action}** — ${host.next.detail}`] : []),
    `- Действующие задания досок: ${host.liveBoards.length ? host.liveBoards.join(', ') : 'нет'}`,
    ...Object.entries(handoffHostCommands).map(([k, v]) => `- \`${k}\` — ${v}`),
    '',
  ].join('\n');
}

/** Текст для CLI: JSON того же вида, что у операции, или Markdown. */
export function renderHandoff(value: DevContourHandoff, format: HandoffFormat): string {
  const response = handoffResponse(value, format);
  return response.markdown ?? JSON.stringify(response, null, 2) + '\n';
}

export const parseHandoffFormat = (format: string | undefined): HandoffFormat => {
  if (format === undefined) return 'json';
  if (!(handoffFormats as readonly string[]).includes(format))
    throw new DomainError('format: ожидается json или md', 400);
  return format as HandoffFormat;
};

/** Предел ответа операции: каталог обещает не больше 64 KiB. */
export const AGENT_HANDOFF_BYTES = 60_000;

const isDecision = (d: { actor: string | null; action: string }) =>
  (d.actor === 'user' || d.actor === 'lead') && d.action !== 'wait';

/**
 * Пакет в пределе `fits`: записи отбрасываются в порядке контракта HandoffPack
 * («намерения с конца, старые провалы, поручения без решения, остановки без
 * решения, незавершённые попытки, остальные поручения и остановки, строки
 * бюджетов»), каждая — в `truncated`, с `truncated.bySize`. Тот же порядок,
 * что у предела пакета harness; функция harness с пределом не экспортирована
 * (её экспорт — задача пакета), поэтому здесь копия для предела ответа API.
 */
export function fitHandoff(input: HandoffPack, fits: (pack: HandoffPack) => boolean): HandoffPack {
  const pack = structuredClone(input);
  const t = pack.truncated;
  const dropLast = <T>(list: T[], keep: (item: T) => boolean = () => false) => {
    for (let i = list.length - 1; i >= 0; i--)
      if (!keep(list[i])) {
        list.splice(i, 1);
        return true;
      }
    return false;
  };
  const steps = [
    () => dropLast(pack.intentions) && (t.intentionsDropped++, true),
    () => dropLast(pack.failures) && (t.failures++, true),
    () => dropLast(pack.works, (w) => isDecision(w.next)) && (t.works++, true),
    () => dropLast(pack.stops, isDecision) && (t.stops++, true),
    () => dropLast(pack.unfinished) && (t.unfinished++, true),
    () => dropLast(pack.works) && (t.works++, true),
    () => dropLast(pack.stops) && (t.stops++, true),
    () => Boolean(pack.budgets && dropLast(pack.budgets.entries)) && (t.budgets++, true),
  ];
  for (const step of steps)
    while (!fits(pack)) {
      t.bySize = true;
      if (!step()) break;
    }
  return pack;
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** Сколько записей пакета отброшено пределами (`truncated`). */
const droppedOf = (t: HandoffPack['truncated']) =>
  t.works + t.stops + t.failures + t.unfinished + t.budgets + t.intentionsDropped;

/** CLI с полным пакетом — без предела ответа операции. */
export const HANDOFF_FULL_HINT =
  'devcontour session-handoff --workspace <path> [--board ID] [--intent TEXT]... [--format json|md] [--out FILE]';

/**
 * Пакет для ведущего агента в пределе ответа операции (`handoffResponse`).
 * Сверх предела записи отбрасываются тем же порядком, что у пакета
 * (`truncated.bySize`); тогда `full` называет CLI с полным пакетом.
 */
export function agentHandoff(h: DevContour, input: z.infer<typeof handoffInput>) {
  const { format, ...request } = input;
  const value = devcontourHandoff(h, request);
  const respond = (pack: HandoffPack) => handoffResponse({ ...value, pack }, format);
  const pack = fitHandoff(value.pack, (p) => bytes(respond(p)) <= AGENT_HANDOFF_BYTES);
  return {
    ...respond(pack),
    ...(droppedOf(pack.truncated) > droppedOf(value.pack.truncated)
      ? { full: HANDOFF_FULL_HINT }
      : {}),
  };
}
