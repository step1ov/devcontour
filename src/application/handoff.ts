// Пакет передачи контекста новой сессии ведущего агента: сборка и отрисовка —
// общие функции devcontour-harness (`handoffPack`, `handoffMarkdown`) над
// движком DevContour и тем же хранилищем, что у исполнения. Пакет только
// читает состояние: моделей не вызывает, записей и событий не создаёт.
//
// Это не handoff публикации ChangeSet (`devcontour handoff --changeset`):
// тот готовит результат к push/PR человеком.
import {
  Harness,
  WorkflowQueue,
  handoffMarkdown,
  handoffPack,
  type HandoffPack,
} from 'devcontour-harness';
import { z } from 'zod';
import { DomainError } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { executionOf, toDomain } from '../harness/execution.ts';

export const handoffFormats = ['json', 'md'] as const;
export type HandoffFormat = (typeof handoffFormats)[number];

/** Предел намерений — `HANDOFF_LIMITS` пакета: 20 строк по 1000 знаков. */
export const handoffRequestInput = z.strictObject({
  /** Доска DevContour — граф harness с тем же id; без неё — вся доска workspace. */
  boardId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
  /** Намерения агента: единственный текст пакета не из хранилища. */
  intentions: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
});

/** Вход операции `handoff` агентского API. */
export const handoffInput = handoffRequestInput.extend({
  format: z.enum(handoffFormats).default('json'),
});

export type HandoffRequest = z.infer<typeof handoffRequestInput>;

/**
 * Команды harness в `next.command` пакета (`handoffCommands`) и что делать в
 * DevContour: controller очереди — работающий сервер контура, а не `harness run`.
 */
export const handoffHostCommands = {
  'harness run':
    'Controller is the running DevContour server: start it (devcontour start|serve --workspace …) or check /api/state; do not run harness CLI on this store.',
  'harness resume': 'queue_set {"paused": false}, or devcontour queue --start --workspace …',
} as const;

/**
 * Harness для `handoffPack` поверх движка DevContour. `Harness.open` открывает
 * собственную базу harness, а исполнение DevContour идёт движком над его
 * хранилищем (`executionOf`), поэтому пакету дан вид с теми полями, которые
 * он читает: `engine`, `policy`, `workflows` и методы `status` прототипа.
 * Задания графов harness DevContour не ведёт (его стадии — доски и
 * ChangeSet): очередь заданий читается из того же хранилища и графов не
 * содержит, восстановлений графов в пакете нет.
 */
function harnessOf(h: DevContour): Harness {
  const { engine } = executionOf(h);
  const workflows = new WorkflowQueue(engine.host.store, engine.policy, () => engine.clock());
  return Object.assign(Object.create(Harness.prototype) as Harness, {
    engine,
    policy: engine.policy,
    workflows,
  });
}

/**
 * Пакет передачи контекста workspace или одной доски (до 256 КБ, предел
 * пакета). Только чтение; весь пакет — один снимок хранилища.
 */
export function devcontourHandoff(h: DevContour, input: HandoffRequest = {}): HandoffPack {
  // CLI передаёт флаги как есть: пределы намерений и формат id — той же схемой.
  const parsed = handoffRequestInput.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      400,
    );
  const request = parsed.data;
  const harness = harnessOf(h);
  const { boardId } = request;
  if (boardId !== undefined) {
    const { store } = executionOf(h);
    const known = store.read((v) => ({
      board: store.stateOf(v).boards.some((b) => b.id === boardId),
      graph: Boolean(v.graph(boardId)),
    }));
    if (!known.board) throw new DomainError('Доска не найдена: ' + boardId, 404);
    if (!known.graph)
      throw new DomainError(
        `Доска ${boardId} ещё не выпущена: у неё нет утверждённых или выпущенных задач`,
        409,
      );
  }
  try {
    return handoffPack(harness, {
      ...(boardId !== undefined ? { graphId: boardId } : {}),
      ...(request.intentions ? { intentions: request.intentions } : {}),
    });
  } catch (error) {
    throw toDomain(error);
  }
}

/** Текст пакета для CLI: JSON (с командами DevContour) или Markdown. */
export function renderHandoff(pack: HandoffPack, format: HandoffFormat) {
  if (format === 'json') return JSON.stringify({ pack, commands: handoffHostCommands }, null, 2);
  return handoffMarkdown(pack) + commandsMarkdown();
}

function commandsMarkdown() {
  return [
    '',
    '## Команды в DevContour',
    '',
    ...Object.entries(handoffHostCommands).map(([k, v]) => `- \`${k}\` — ${v}`),
    '',
  ].join('\n');
}

export const parseHandoffFormat = (format: string | undefined): HandoffFormat => {
  if (format === undefined) return 'json';
  if (!(handoffFormats as readonly string[]).includes(format))
    throw new DomainError('format: ожидается json или md', 400);
  return format as HandoffFormat;
};

/** Предел ответа операции: каталог обещает не больше 64 KiB. */
const AGENT_HANDOFF_BYTES = 60_000;

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

/**
 * Пакет для ведущего агента в пределе ответа операции: JSON — `{pack,
 * commands}` по схеме `handoffPackSchema`; `md` — тот же пакет текстом.
 * Сверх предела записи отбрасываются тем же порядком, что у пакета
 * (`truncated.bySize`); полный пакет — `devcontour session-handoff`.
 */
export function agentHandoff(h: DevContour, input: z.infer<typeof handoffInput>) {
  const { format, ...request } = input;
  const full = devcontourHandoff(h, request);
  const respond = (pack: HandoffPack) =>
    format === 'md'
      ? { format, markdown: handoffMarkdown(pack), commands: handoffHostCommands }
      : { format, pack, commands: handoffHostCommands };
  const pack = fitHandoff(full, (p) => bytes(respond(p)) <= AGENT_HANDOFF_BYTES);
  return {
    ...respond(pack),
    ...(pack.truncated.bySize && !full.truncated.bySize
      ? { full: 'devcontour session-handoff --workspace <path> [--board ID] [--format json|md]' }
      : {}),
  };
}
