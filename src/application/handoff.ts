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
import { LeadWorkflow } from '../core/lead-workflow.ts';
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
 */
export const handoffHostCommands = {
  'harness run':
    'Not a DevContour command. The running server holds the controller role but does not lift pauses itself: a board continues under its lead workflow job (workflow_start {"kind": "board", "id": BOARD, "authorRuntime": …}; workflow_status lists jobs). With approvalMode agent the job loop lifts the initial pause, the shutdown pause and an operator pause set before the job started, and retries failed tasks within the repair budget. With approvalMode operator jobs do not run: the operator starts the queue and retries. host.next names the step for this pack.',
  'harness resume':
    'queue_set {"paused": false}, or devcontour queue --start --workspace …; an operator pause is lifted only on the user\'s decision.',
} as const;

/** Шаг DevContour вместо команды harness: что сделать ведущему агенту или человеку. */
export interface HandoffHostNext {
  action: 'workflow_start' | 'workflow_retry' | 'wait' | 'queue_set' | 'decide' | 'operator';
  boardId?: string;
  /** Задание ведущего, к которому относится шаг (`workflow_retry`, `decide`). */
  job?: {
    key: string;
    repositoryId?: string;
    status: string;
    attempts: number;
    maxAttempts: number;
  };
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

/** Порядок заданий: идущие и ждущие стадии — первыми, затем новые первыми. */
const jobRank = (job: HarnessJob) => (job.status === 'running' || job.status === 'queued' ? 0 : 1);
const byLiveness = (a: HarnessJob, b: HarnessJob) =>
  jobRank(a) - jobRank(b) || (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0);

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
 * (`LeadRunner.advance`): ни одно задание не продолжается. Список — идущие
 * и ждущие задания первыми, затем новые первыми (так же упорядочены
 * `repairs` пакета: у доски бывает несколько заданий).
 */
function harnessOf(h: DevContour) {
  const { engine } = executionOf(h);
  const queue = new LeadWorkflow(h).queue();
  const owners = ownersOf(h.config);
  const operator = h.config.approvalMode === 'operator';
  const workflows = {
    list: (): HarnessJob[] =>
      owners
        .flatMap((owner) => queue.list(owner))
        .filter((job) => job.kind === 'board')
        .map((job): HarnessJob => ({ ...job, kind: 'graph' }))
        .sort(byLiveness),
    continues: (
      job: HarnessJob,
      view: ExecutionView,
      options: { reconfigureApplies?: boolean } = {},
    ) => !operator && queue.continues({ ...job, kind: 'board' }, view, options),
  };
  const harness = Object.assign(Object.create(Harness.prototype) as Harness, {
    engine,
    policy: engine.policy,
    workflows,
  });
  return { harness, workflows, engine };
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
 *   экспортирована, поэтому здесь обход той же формы);
 * - учётные данные MCP профилей инструментов (`env`, `bearerTokenEnv`) и
 *   токены подключений forge (`tokenEnv`);
 * - наследуемые значения (`inherit`) не короче 8 знаков: короткие («1»,
 *   «true») маскировали бы обычный текст.
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
      if (key === 'inherit' && Array.isArray(v))
        (v as unknown[]).forEach((name) => add(name, MIN_INHERITED));
      if (key === 'env' && Array.isArray(v)) (v as unknown[]).forEach((name) => add(name));
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
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
});

interface HostContext {
  pack: HandoffPack;
  view: ExecutionView;
  state: ReturnType<DevContourExecutionStore['stateOf']>;
  operator: boolean;
  /** Задания досок (вид графа), идущие первыми. */
  jobs: HarnessJob[];
  live: (job: HarnessJob) => boolean;
  /** Вход задания совпадает с текущим входом доски (иначе задание устарело). */
  current: (job: HarnessJob) => boolean;
}

const OPERATOR_STEP =
  'approvalMode operator: lead workflow jobs do not run. The operator reviews plans and accepts boards in the panel, starts the queue (devcontour queue --start --workspace …) and retries failed tasks (devcontour retry --task ID --workspace …).';

/** Шаг по заданиям доски: ждать, повторить задание, начать новое или решить. */
function jobStep(boardId: string, ctx: HostContext): HandoffHostNext {
  const jobs = ctx.jobs.filter((j) => j.id === boardId);
  if (jobs.some(ctx.live))
    return {
      action: 'wait',
      boardId,
      detail: `Board ${boardId} has a live lead workflow job: the running DevContour server continues it. If the server is stopped, start it (devcontour start --workspace …).`,
    };
  const latest = jobs.find((j) => j.status !== 'completed');
  if (latest?.status === 'failed' && ctx.current(latest)) {
    if (latest.attempts < latest.maxAttempts)
      return {
        action: 'workflow_retry',
        boardId,
        job: jobRef(latest),
        detail: `The lead workflow job of board ${boardId} failed${latest.error ? ': ' + latest.error : ''}. Diagnose it, then workflow_retry {"key": ${JSON.stringify(latest.key)}${latest.owner ? ', "repositoryId": ' + JSON.stringify(latest.owner) : ''}} within its attempts.`,
      };
    return {
      action: 'decide',
      boardId,
      job: jobRef(latest),
      detail: `The lead workflow job of board ${boardId} used all ${latest.maxAttempts} attempts${latest.error ? ': ' + latest.error : ''}. workflow_start returns this failed job until the board input changes: diagnose, then correct the board or tasks (a new input registers a new job) or ask the user.`,
    };
  }
  const id = JSON.stringify(boardId);
  return {
    action: 'workflow_start',
    boardId,
    ...(latest ? { job: jobRef(latest) } : {}),
    detail: `No live lead workflow job for board ${boardId}${latest && !ctx.current(latest) ? ' (its job was started on a previous input)' : ''}: with the DevContour server running, register workflow_start {"kind": "board", "id": ${id}, "authorRuntime": …}. queue_set {"paused": false} alone resumes dispatch without the job's pause handling and repairs.`,
  };
}

/**
 * Шаг DevContour по состоянию, а не по `next.command` пакета: с работающим
 * сервером роль controller жива, и пакет команды не называет, хотя исходную
 * паузу и паузу остановки снимает только цикл задания доски.
 */
function hostNext(ctx: HostContext): HandoffHostNext | undefined {
  const { pack, view, state } = ctx;
  if (!pack.summary.open) return undefined;
  if (ctx.operator) return { action: 'operator', detail: OPERATOR_STEP };
  const workId = pack.next.workId;
  const boardId = (workId ? view.work(workId)?.graphId : undefined) ?? pack.graphId;
  const board = boardId && state.boards.some((b) => b.id === boardId) ? boardId : undefined;
  if (state.paused && state.pauseReason === 'operator') {
    // Цикл стадии снимает паузу человека, поставленную до начала задания.
    const lifts =
      board &&
      state.pausedAt !== undefined &&
      ctx.jobs.some((j) => j.id === board && ctx.live(j) && state.pausedAt! < j.startedAt);
    if (lifts) return jobStep(board, ctx);
    return {
      action: 'queue_set',
      ...(board ? { boardId: board } : {}),
      detail:
        'Dispatch is paused by the operator: resume only on the user\'s decision with queue_set {"paused": false} (devcontour queue --start).',
    };
  }
  const controllerStep =
    pack.next.actor === 'controller' ||
    pack.next.command === 'harness run' ||
    ('liftedByRun' in pack.queue && pack.queue.liftedByRun === true);
  if (!controllerStep) return undefined;
  if (!board)
    return {
      action: 'workflow_start',
      detail:
        'Open work waits for the controller: register workflow_start {"kind": "board", "id": BOARD, "authorRuntime": …} for each board without a live lead workflow job (workflow_status lists jobs), with the DevContour server running.',
    };
  return jobStep(board, ctx);
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
  const { harness, workflows, engine } = harnessOf(h);
  const { store } = executionOf(h);
  const lead = new LeadWorkflow(h);
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
      // Вход доски — правило `LeadWorkflow.staleBoards`: digest и владелец.
      const inputs = new Map<string, { digest: string; owner?: string } | undefined>();
      const inputOf = (id: string) => {
        if (!inputs.has(id))
          try {
            inputs.set(id, lead.input('board', id, state));
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            inputs.set(id, undefined);
          }
        return inputs.get(id);
      };
      const current = (job: HarnessJob) => {
        const bound = inputOf(job.id);
        return !!bound && bound.digest === job.inputDigest && bound.owner === job.owner;
      };
      const liveBoards = [...new Set(jobs.filter(live).map((j) => j.id))];
      const next = hostNext({
        pack,
        view: v,
        state,
        operator: h.config.approvalMode === 'operator',
        jobs,
        live,
        current,
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
