// Пакет передачи контекста новой сессии ведущего агента: сборка и отрисовка —
// общие функции devcontour-harness (`handoffPack`, `handoffMarkdown`) над
// движком DevContour и тем же хранилищем, что у исполнения. Пакет только
// читает состояние: моделей не вызывает, записей и событий не создаёт.
//
// Это не handoff публикации ChangeSet (`devcontour handoff --changeset`):
// тот готовит результат к push/PR человеком.
import {
  Harness,
  composeRedactors,
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
import { availableRedactor } from '../runner/environment.ts';

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
 * DevContour. Controller очереди — работающий сервер контура; очередь доски
 * продолжает её задание ведущего (`workflow_start`): снимает исходную паузу и
 * паузу штатной остановки и чинит упавшие задачи в бюджете восстановлений.
 */
export const handoffHostCommands = {
  'harness run':
    'The running DevContour server is the controller. A board continues under its lead workflow job: workflow_start {"kind": "board", "id": BOARD, "authorRuntime": …} registers it (workflow_status lists jobs); the job loop lifts the initial or shutdown pause and retries failed tasks within the repair budget. Never run harness CLI on this store; host.next names the step for this pack.',
  'harness resume':
    'queue_set {"paused": false}, or devcontour queue --start --workspace …; an operator pause is lifted only on the user\'s decision.',
} as const;

/** Шаг DevContour для `next.command` пакета: что сделать вместо команды harness. */
export interface HandoffHostNext {
  action: 'workflow_start' | 'wait' | 'queue_set';
  boardId?: string;
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
 * ChangeSet графу не соответствуют и в пакет не входят.
 */
function harnessOf(h: DevContour) {
  const { engine } = executionOf(h);
  const queue = new LeadWorkflow(h).queue();
  const owners = ownersOf(h.config);
  const workflows = {
    list: (): HarnessJob[] =>
      owners
        .flatMap((owner) => queue.list(owner))
        .filter((job) => job.kind === 'board')
        .map((job) => ({ ...job, kind: 'graph' })),
    continues: (
      job: HarnessJob,
      view: ExecutionView,
      options: { reconfigureApplies?: boolean } = {},
    ) => queue.continues({ ...job, kind: 'board' }, view, options),
  };
  const harness = Object.assign(Object.create(Harness.prototype) as Harness, {
    engine,
    policy: engine.policy,
    workflows,
  });
  return { harness, workflows };
}

/**
 * Маска текстов пакета — та же, что у процессов контура: секреты и
 * наследуемые значения профилей окружения (workspace, компонентов, preview)
 * и токены подключений forge, заданные в окружении читающего процесса.
 */
export function handoffRedactor(config: Config, source = process.env) {
  const profiles = [
    config.environment,
    ...repositories(config).map((r) => r.environment),
    config.preview?.environment,
  ];
  const tokens = Object.values(config.forgeConnections).flatMap((c) => {
    const token = c.tokenEnv ? source[c.tokenEnv] : undefined;
    return token ? [token] : [];
  });
  return composeRedactors(availableRedactor(profiles, source), redactor(tokens));
}

/** Доска шага `next`: доска его задачи или доска пакета. */
function nextBoard(pack: HandoffPack) {
  const workId = pack.next.workId;
  return (workId ? pack.works.find((w) => w.id === workId)?.graphId : undefined) ?? pack.graphId;
}

function hostNext(pack: HandoffPack, live: Set<string>): HandoffHostNext | undefined {
  if (pack.next.command === 'harness resume')
    return {
      action: 'queue_set',
      detail:
        'Resume dispatch: queue_set {"paused": false} (devcontour queue --start); an operator pause only on the user\'s decision.',
    };
  if (pack.next.command !== 'harness run') return undefined;
  const boardId = nextBoard(pack);
  if (boardId && live.has(boardId))
    return {
      action: 'wait',
      boardId,
      detail: `Board ${boardId} has a live lead workflow job: the running DevContour server continues its queue. If the server is stopped, start it (devcontour start --workspace …).`,
    };
  const id = boardId ? JSON.stringify(boardId) : 'BOARD';
  return {
    action: 'workflow_start',
    ...(boardId ? { boardId } : {}),
    detail: `No live lead workflow job${boardId ? ' for board ' + boardId : ''}: with the DevContour server running, register workflow_start {"kind": "board", "id": ${id}, "authorRuntime": …}. queue_set {"paused": false} alone resumes dispatch without the job's repairs.`,
  };
}

/**
 * Пакет передачи контекста workspace или одной доски (до 256 КБ, предел
 * пакета) и приложение DevContour. Только чтение; пакет и действующие
 * задания досок — один снимок хранилища.
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
  const { harness, workflows } = harnessOf(h);
  const { store } = executionOf(h);
  const { boardId } = request;
  try {
    return store.read((v) => {
      if (boardId !== undefined) {
        if (!store.stateOf(v).boards.some((b) => b.id === boardId))
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
        redact: handoffRedactor(h.config),
      });
      const live = new Set(
        workflows
          .list()
          .filter((job) => workflows.continues(job, v))
          .map((job) => job.id),
      );
      const next = hostNext(pack, live);
      return { pack, host: { ...(next ? { next } : {}), liveBoards: [...live] } };
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
