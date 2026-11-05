import {
  CLIP_DIAGNOSTIC,
  CLIP_SHORT,
  chainRoots,
  clipText,
  queueStop,
  type ChainRootCode,
} from 'devcontour-harness/projections';
import type { AuditEvent, Board, DevContourState, Run, Task } from './model.ts';

/**
 * Почему диспетчер сам остановил выдачу работы — общая проекция harness
 * (`queueStop`). Хост переводит журнал в её вход: каждое `scheduler.error`
 * — ошибка с номером события; правило выбора (пауза оператора не называет
 * сбой, пустая причина — runtime, самая свежая ошибка) — в harness.
 */
export function queueStopReason(
  state: { paused?: boolean; pauseReason?: DevContourState['pauseReason'] },
  events: Pick<AuditEvent, 'id' | 'type' | 'data'>[],
) {
  return queueStop({
    paused: state.paused === true,
    ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
    errors: events
      .filter((e) => e.type === 'scheduler.error')
      .map((e) => ({ seq: e.id, message: (e.data as { error?: string } | undefined)?.error })),
  }).detail;
}

/**
 * Остановка очереди одной записью для всех читателей: `/api/state`,
 * `/api/preparation`, сводка панели, CLI `queue` и агентские операции.
 * Раньше причину называл только экран этапа и только для сбоя диспетчера:
 * ожидание проверки базы и пауза человека выглядели молчаливой паузой, а
 * `/api/state` отдавал `paused: true` без объяснения.
 *
 * Порядок причин — от той, что держит выдачу дольше всех:
 * 1. классы отказов (`pauseFailures`) — провайдер, окружение; их не снимает
 *    ни перенос базы, ни цикл ведущего, только решение человека;
 * 2. ожидание проверки базы — при любой паузе: `queue --start` снимает его
 *    вместе с паузой, поэтому подсказка — сначала проверить базу;
 * 3. сама причина паузы. Пауза без причины — либо исходная «очередь ещё не
 *    запускали» (`not-started`), либо сбой такта диспетчера: такт ставит
 *    `pausedAt`, а прежняя запись видна по `scheduler.error` в журнале.
 *
 * Подсказка зависит от режима: в `approvalMode: agent` исходную и штатную
 * паузы снимает цикл ведущего, если есть зарегистрированная работа
 * (`workflowActive`); без неё — `workflow_start`, ручной `queue --start` с
 * этим маршрутом не смешивают. В режиме оператора — `queue --start`.
 *
 * `stopReason` усечён общим пределом диагностики, поэтому байты одинаковы во
 * всех ответах.
 */
export type QueueStopReason = NonNullable<DevContourState['pauseReason']> | 'not-started';
export interface QueueStopView {
  paused: boolean;
  reason?: QueueStopReason;
  stopReason?: string;
  /** Когда выдачу остановили (`pausedAt`), если известно. */
  since?: string;
  action?: string;
  /** Остановка вызвана сбоем (рантайм, провайдер, окружение), а не решением или ожиданием. */
  failed?: true;
}
/** Ошибка `scheduler.error`, записанная не раньше паузы (секунда — на порядок записи). */
const AFTER_PAUSE_SLACK_MS = 1000;
export function queueStopView(
  state: Pick<DevContourState, 'paused' | 'pauseReason' | 'pausedAt' | 'pauseFailures' | 'waits'>,
  events: Pick<AuditEvent, 'id' | 'at' | 'type' | 'data'>[],
  options: { approvalMode?: 'agent' | 'operator'; workflowActive?: boolean } = {},
): QueueStopView {
  if (!state.paused) return { paused: false };
  const agent = (options.approvalMode ?? 'agent') === 'agent';
  const start = 'devcontour queue --start';
  const reconfiguring = 'Ничего не требуется: операция изменения контракта снимет паузу сама';
  const since = state.pausedAt;
  // Самая свежая ошибка диспетчера после паузы: более старая относится к
  // прошлой остановке и за причину текущей не выдаётся.
  const from = since ? Date.parse(since) - AFTER_PAUSE_SLACK_MS : -Infinity;
  const detail = queueStop({
    paused: true,
    errors: events
      .filter((e) => e.type === 'scheduler.error' && Date.parse(e.at) >= from)
      .map((e) => ({ seq: e.id, message: (e.data as { error?: string } | undefined)?.error })),
  }).detail;
  const reason: QueueStopReason =
    state.pauseReason ?? (since || detail ? 'runtime' : 'not-started');
  const failures = (state.pauseFailures ?? []).filter((f) => f !== 'unknown');
  const wait = state.waits?.find((w) => w.kind === 'base-check')?.detail;
  // Исходную и штатную паузы в режиме агента снимает цикл ведущего.
  const resume = !agent
    ? start
    : options.workflowActive
      ? 'Ничего не требуется: цикл ведущего продолжит выдачу, пока работает devcontour serve'
      : 'Если доска ведётся workflow — зарегистрируйте её через workflow_start; если вручную — ' +
        start +
        '; маршруты не смешивайте';
  // Продолжение очереди снимает и ожидание проверки базы: при нём базу
  // проверяют до запуска.
  const thenStart = (wait ? ', проверьте базу gates, затем ' : ', затем ') + start;
  const explain = (): [text: string, action: string, failed: boolean] => {
    if (failures.includes('provider-auth'))
      return [
        detail ??
          'Провайдер моделей отказал: нет кредитов, исчерпан лимит или runtime не авторизован',
        'Авторизуйте CLI исполнителя, пополните баланс или дождитесь сброса лимита' + thenStart,
        true,
      ];
    if (failures.length)
      return [
        detail ?? 'Окружение не дало исполнителю работать',
        agent && options.workflowActive
          ? 'Цикл ведущего один раз повторит задачу сам; если отказ повторится — устраните неисправность окружения' +
            thenStart
          : 'Устраните неисправность окружения' + thenStart,
        true,
      ];
    if (wait) {
      const checkFailed = wait.startsWith('Проверка базы не пройдена');
      const held = /меняет приёмку или настройку контура/.test(wait);
      return [
        wait,
        reason === 'base-check' && agent && options.workflowActive && !held
          ? checkFailed
            ? 'Исправьте базу и выполните devcontour base-update (ведущий агент — с --by host) — цикл ведущего проверит её снова'
            : 'Цикл ведущего проверит базу gates и продолжит выдачу сам'
          : 'Проверьте базу gates, затем выполните ' +
            start +
            (reason === 'operator' ? ' — он снимет и паузу человека, и ожидание' : ''),
        false,
      ];
    }
    switch (reason) {
      case 'operator':
        return ['Выдача остановлена человеком', start, false];
      case 'shutdown':
        return ['Сервер был остановлен штатно', resume, false];
      case 'reconfigure':
        return ['Применяется новая конфигурация после изменения контракта', reconfiguring, false];
      case 'base-check':
        // Ожидание без описания — перенос базы ещё идёт: он сам поставит
        // описание и диапазон проверки.
        return [
          'Выдача ждёт проверки перенесённой базы gates',
          'Идёт обновление базы — дождитесь его окончания',
          false,
        ];
      case 'not-started':
        return ['Очередь ещё не запущена', resume, false];
      default:
        return detail
          ? [
              detail,
              /base-update/.test(detail)
                ? 'Выполните devcontour base-update (ведущий агент — с --by host), затем проверьте базу и ' +
                  start
                : 'Устраните причину и выполните ' + start,
              true,
            ]
          : [
              'Выдача остановлена сбоем диспетчера; подробности — в devcontour journal',
              'Устраните причину и выполните ' + start,
              true,
            ];
    }
  };
  const [text, explained, failed] = explain();
  // Паузу применения конфигурации снимает операция: queue --start при ней не
  // подсказывается, даже если рядом отказ или ожидание.
  const action = reason === 'reconfigure' ? reconfiguring : explained;
  return {
    paused: true,
    reason,
    stopReason: clipText(text, CLIP_DIAGNOSTIC),
    ...(since ? { since } : {}),
    action,
    ...(failed ? { failed: true as const } : {}),
  };
}

export type BoardPhase =
  'accepted' | 'running' | 'failed' | 'acceptance' | 'queued' | 'draft' | 'empty' | 'closed';

export const boardPhaseLabels: Record<BoardPhase, string> = {
  accepted: 'Принята',
  running: 'Идёт работа',
  failed: 'Есть сбой',
  acceptance: 'Ждёт приёмки',
  queued: 'В очереди',
  draft: 'План не утверждён',
  empty: 'Без задач',
  closed: 'Закрыта',
};

/**
 * Где сейчас доска. У ревизии всего два статуса, и всё, что не принято,
 * панель называла «В работе» — в том числе доску, где ни одна задача не
 * выпущена из черновика. Фаза выводится из живых задач доски.
 */
export function boardPhase(
  board: Pick<Board, 'revisions'>,
  tasks: Pick<Task, 'id' | 'status' | 'activeRunId'>[],
): BoardPhase {
  if (board.revisions.at(-1)?.status === 'accepted') return 'accepted';
  const ids = new Set(board.revisions.flatMap((r) => r.taskIds));
  const own = tasks.filter((t) => ids.has(t.id) && t.status !== 'cancelled');
  // Доска, где отменено всё, — брошенный план, а не пустая заготовка: работы
  // на ней не будет. «Без задач» звало её наполнить.
  if (!own.length) return ids.size ? 'closed' : 'empty';
  if (own.some((t) => t.activeRunId)) return 'running';
  if (own.some((t) => t.status === 'failed')) return 'failed';
  const open = own.filter((t) => t.status !== 'done');
  if (!open.length) return 'acceptance';
  return open.every((t) => t.status === 'draft') ? 'draft' : 'queued';
}

/**
 * Задачи последней ревизии, перенесённые из предыдущей принятой в том
 * состоянии, в каком их приняли: следующий этап и корректировка несут
 * прежний состав доски. Такой результат уже принят (или отмена уже учтена
 * приёмкой), поэтому работой новой ревизии он не является: его не
 * перепроверяют на свежесть подготовки и требований, он не останавливает
 * workflow и не нужен заново как доказательство. Иначе изменение подготовки
 * или старая отмена делали этап непринимаемым.
 *
 * Задача, возвращённая после приёмки (reopen, retry), — снова работа: её
 * новую постановку должен увидеть ревьюер, а результат — пройти проверки.
 * Поэтому перенесённой считается только done с тем же SHA, что в снимке
 * приёмки, или по-прежнему отменённая.
 */
export function carriedTaskIds(
  board: Pick<Board, 'revisions'>,
  tasks: Pick<Task, 'id' | 'status' | 'resultSha'>[],
): Set<string> {
  const [previous, current] = board.revisions.slice(-2);
  if (!current || previous.status !== 'accepted') return new Set();
  return new Set(
    current.taskIds.filter((id) => {
      if (!previous.taskIds.includes(id)) return false;
      const t = tasks.find((x) => x.id === id);
      if (t?.status === 'cancelled') return true;
      return (
        t?.status === 'done' &&
        previous.snapshot?.tasks.some((x) => x.id === id && x.resultSha === t.resultSha) === true
      );
    }),
  );
}

export type ChainBlocker = {
  taskId: string;
  title: string;
  /** Почему задача держит цепочку, человеческими словами. */
  reason: string;
  /** Что нужно, чтобы цепочка пошла дальше. */
  next: string;
  /** Сколько готовых задач ждут её прямо или через других. */
  waiting: number;
};

/** Тексты панели для кодов корня цепочки; `detail` — причина удержания или бюджета. */
const chainTexts: Record<ChainRootCode, (detail?: string) => [string, string]> = {
  'failed-exhausted': () => [
    'сбой, бюджет попыток исчерпан',
    'ведущий устраняет причину и повторяет со сбросом бюджета',
  ],
  failed: () => ['сбой', 'повтор назначит восстановление или ведущий'],
  draft: () => ['план не утверждён', 'ревью и утверждение плана'],
  cancelled: () => ['отменена', 'перепланировать зависимые задачи'],
  held: (detail) => [`удержана: ${detail}`, 'дождаться завершения операции'],
  'budget-blocked': (detail = '') => [
    detail,
    'осознанно поднять предел в budgets или задать политику onUnknown',
  ],
  'attempts-exhausted': () => ['исчерпан бюджет попыток', 'повтор со сбросом бюджета'],
};

/**
 * Чего ждёт цепочка, когда исполнители свободны. Счётчик «ждут зависимостей»
 * говорил, что работа стоит, но не почему: на пилоте четыре задачи этапа
 * ждали одну упавшую с исчерпанным бюджетом, а панель писала «никто не
 * работает». Обход к корням — общая проекция harness (`chainRoots`); хост
 * передаёт задачи как работы и называет код корня прежними словами панели.
 */
export function chainBlockers(
  tasks: Pick<
    Task,
    'id' | 'title' | 'status' | 'dependsOn' | 'attempt' | 'hold' | 'budgetBlock' | 'activeRunId'
  >[],
  maxAttempts = 3,
): ChainBlocker[] {
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  const works = tasks.map((t) => ({
    id: t.id,
    status: t.status,
    dependsOn: t.dependsOn,
    attempt: t.attempt,
    ...(t.activeRunId ? { activeRunId: t.activeRunId } : {}),
    ...(t.hold ? { hold: t.hold } : {}),
    ...(t.budgetBlock ? { budgetBlock: { reason: t.budgetBlock.reason } } : {}),
  }));
  return chainRoots(works, maxAttempts).map((root) => {
    const [reason, next] = chainTexts[root.code](root.detail);
    return {
      taskId: root.workId,
      title: titles.get(root.workId)!,
      reason,
      next,
      waiting: root.waiting,
    };
  });
}

/**
 * Живость идущей попытки по обходу зависаний controller (`stallSweep`
 * политики harness). Переход пишется в попытку только при смене состояния,
 * поэтому длительность простоя считается от `lastMovementAt` на момент `now`,
 * а не берётся из записи. `active` и завершённая попытка вида не дают:
 * оператору нужно заметить только попытку без движения.
 *
 * `attention` — зависание, о котором политика только сообщает
 * (`stallSweep.action: report`): попытка идёт до своего предела времени, и
 * действовать должен человек (harness `explain`: `fix-environment`). При
 * `stop` попытку останавливает сам controller.
 */
export type RunLivenessState = 'quiet' | 'stalled';
export type RunLivenessActivity = {
  kind: 'agent' | 'gate' | 'step' | 'command';
  label: string;
};
export interface RunLiveness {
  state: RunLivenessState;
  /** С какого момента попытка в этом состоянии (момент перехода). */
  since: string;
  lastMovementAt: string;
  /** Сколько попытка без движения на момент ответа. */
  idleMs: number;
  /** Чем попытка занята: исполняющаяся команда (агент, gate, шаг среды). */
  activity?: RunLivenessActivity;
  action?: 'stop' | 'report';
  /** Нужен человек: зависание при `stallSweep.action: report`. */
  attention: boolean;
}
type LivenessRecord = {
  state: 'active' | RunLivenessState;
  lastMovementAt: string;
  activity?: RunLivenessActivity;
  action?: 'stop' | 'report';
};
/** Вид живости из записи перехода; `active` — вида нет. */
function livenessView(l: LivenessRecord, since: string, now: number): RunLiveness | undefined {
  if (l.state === 'active') return undefined;
  const moved = Date.parse(l.lastMovementAt);
  return {
    state: l.state,
    since,
    lastMovementAt: l.lastMovementAt,
    idleMs: Number.isFinite(moved) ? Math.max(0, now - moved) : 0,
    ...(l.activity
      ? {
          activity: {
            kind: l.activity.kind,
            label: clipText(l.activity.label, CLIP_SHORT) ?? '',
          },
        }
      : {}),
    ...(l.action ? { action: l.action } : {}),
    attention: l.state === 'stalled' && l.action !== 'stop',
  };
}
export function runLiveness(
  run: Pick<Run, 'status' | 'liveness'>,
  now: number,
): RunLiveness | undefined {
  const l = run.liveness;
  if (run.status !== 'active' || !l) return undefined;
  return livenessView(l, l.at, now);
}

/**
 * Проверка вне попытки без движения: совместная проверка ChangeSet
 * (`joint.liveness`), проверка перенесённой базы и проверка доски на итоговом
 * SHA (`runGatesAt` → `onLiveness`). У них нет поля живости в записи: переход —
 * только событие журнала, поэтому вид строится по последнему переходу ещё не
 * завершённой проверки.
 */
export type OperationKind = 'joint' | 'base-check' | 'board-coverage';
export interface OperationLiveness extends RunLiveness {
  kind: OperationKind;
  /** Идентификатор проверки: verificationId или runId проверки gates. */
  id: string;
  /** ChangeSet, доска или компонент проверки. */
  subjectId: string;
  title: string;
  repositoryId?: string;
}
export const operationNames: Record<OperationKind, string> = {
  joint: 'Совместная проверка',
  'base-check': 'Проверка базы',
  'board-coverage': 'Проверка доски',
};
/** Типы событий журнала с переходом живости проверки. */
export const OPERATION_LIVENESS_EVENTS = [
  'workspace.liveness',
  'base.check.liveness',
  'board.coverage.liveness',
] as const;
const finishedTypes: Record<'base-check' | 'board-coverage', string[]> = {
  'base-check': ['base.check.passed', 'base.check.failed'],
  'board-coverage': ['board.coverage.passed', 'board.coverage.failed'],
};
/** Типы событий, которыми кончается проверка gates (по ним вид снимается). */
export const OPERATION_FINISH_EVENTS = [
  ...finishedTypes['base-check'],
  ...finishedTypes['board-coverage'],
];
/** Начало проверки gates: более новое начало той же области вытесняет прежнюю. */
export const OPERATION_START_EVENTS = ['base.check.started', 'board.coverage.started'];
/** Область проверки gates: компонент базы или компонент доски. */
const scopeOf = (type: string, data: Record<string, unknown>) =>
  type.startsWith('base.check.')
    ? `base:${String(data.repositoryId)}`
    : `board:${String(data.boardId)}:${String(data.repositoryId)}`;
type LivenessPayload = LivenessRecord & { verificationId?: string };
export function operationLiveness(
  state: Pick<DevContourState, 'changeSets' | 'boards' | 'leader'>,
  /** События переходов и окончаний проверок, новые сначала (`Store.latestEvents`). */
  events: Pick<AuditEvent, 'id' | 'at' | 'type' | 'data'>[],
  now: number,
): OperationLiveness[] {
  const seen = new Set<string>();
  const finished = new Set(
    events
      .filter((e) => OPERATION_FINISH_EVENTS.includes(e.type))
      .map((e) => (e.data as { runId?: string } | null)?.runId)
      .filter(Boolean),
  );
  // Последнее начало в каждой области: проверка, у которой есть более новое
  // начало той же области, уже не идёт (оборвана и начата заново).
  const latestStart = new Map<string, string>();
  for (const e of events)
    if (OPERATION_START_EVENTS.includes(e.type)) {
      const data = (e.data ?? {}) as Record<string, unknown>;
      const scope = scopeOf(e.type, data);
      if (!latestStart.has(scope) && typeof data.runId === 'string')
        latestStart.set(scope, data.runId);
    }
  // Проверку gates ведёт процесс с ролью controller, и переход записан под его
  // именем: живая роль другого владельца (сервер перезапущен) значит, что
  // незавершённая в журнале проверка оборвана, а не идёт.
  const leader = (state.leader?.leaseUntil ?? 0) > now ? state.leader?.owner : undefined;
  const out: OperationLiveness[] = [];
  for (const e of events) {
    if (!(OPERATION_LIVENESS_EVENTS as readonly string[]).includes(e.type)) continue;
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === 'workspace.liveness') {
      const draft = (data.harnessEvents as { type: string; payload: LivenessPayload }[] | undefined)
        ?.filter((d) => d.type === 'joint.liveness')
        .at(-1);
      const id = draft?.payload.verificationId;
      if (!draft || !id || seen.has(id)) continue;
      seen.add(id);
      const changeSet = state.changeSets.find((c) => c.verifications.some((v) => v.id === id));
      if (changeSet?.verifications.find((v) => v.id === id)?.status !== 'active') continue;
      const view = livenessView(draft.payload, e.at, now);
      if (view)
        out.push({ ...view, kind: 'joint', id, subjectId: changeSet.id, title: changeSet.title });
      continue;
    }
    const kind = e.type === 'base.check.liveness' ? 'base-check' : 'board-coverage';
    const runId = typeof data.runId === 'string' ? data.runId : undefined;
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    if (finished.has(runId) || !leader || data.owner !== leader) continue;
    const started = latestStart.get(scopeOf(e.type, data));
    if (started && started !== runId) continue;
    const view = livenessView(data as unknown as LivenessPayload, e.at, now);
    if (!view) continue;
    const repositoryId = typeof data.repositoryId === 'string' ? data.repositoryId : undefined;
    const boardId = typeof data.boardId === 'string' ? data.boardId : undefined;
    out.push({
      ...view,
      kind,
      id: runId,
      subjectId: (kind === 'board-coverage' ? boardId : repositoryId) ?? runId,
      title:
        kind === 'board-coverage'
          ? (state.boards.find((b) => b.id === boardId)?.title ?? boardId ?? runId)
          : (repositoryId ?? runId),
      ...(repositoryId ? { repositoryId } : {}),
    });
  }
  return out;
}

/** Длительность простоя словами панели: «40 с», «12 мин», «1 ч 5 мин». */
export function idleSpan(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + ' с';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' мин';
  return Math.floor(seconds / 3600) + ' ч ' + Math.floor((seconds % 3600) / 60) + ' мин';
}

const activityKinds: Record<RunLivenessActivity['kind'], string> = {
  agent: 'агент',
  gate: 'проверка',
  step: 'шаг среды',
  command: 'команда',
};
/** Чем занята попытка: «проверка unit», «агент codex». */
export const activityText = (a: RunLivenessActivity) => `${activityKinds[a.kind]} ${a.label}`;

/** Чья живость: попытка задачи или проверка вне попытки (у неё нет повтора). */
export type LivenessSubject = 'attempt' | 'check';

/**
 * Короткая подпись состояния: строка «Сейчас», строка задачи, инспектор.
 * Одно двоеточие на строку не тратится: строка доски уже «Сейчас: …».
 */
export function livenessText(
  l: Pick<RunLiveness, 'state' | 'idleMs' | 'action'>,
  subject: LivenessSubject = 'attempt',
) {
  const span = idleSpan(l.idleMs);
  if (l.state === 'quiet') return `без движения ${span}`;
  if (l.action !== 'stop') return `зависла ${span} — проверьте среду`;
  return subject === 'attempt'
    ? `зависла ${span} — будет остановлена и повторена автоматически`
    : `зависла ${span} — будет остановлена автоматически`;
}

/**
 * Что делать с работой без движения и кто действует. `panel` — словами
 * оператора, без внутренних имён; `agent` (MCP, CLI) — с именами политики и
 * событий, по которым ведущий найдёт снимок и порог.
 */
export function livenessNext(
  l: Pick<RunLiveness, 'state' | 'action'>,
  audience: 'panel' | 'agent' = 'panel',
  subject: LivenessSubject = 'attempt',
) {
  const who = subject === 'attempt' ? 'Попытка' : 'Проверка';
  if (l.state === 'quiet')
    return audience === 'panel'
      ? 'Ничего не требуется: нет вывода, расхода процессора и смены стадий, но порог зависания ещё не пройден.'
      : 'Ничего не требуется: нет вывода, расхода процессора и смены стадий, но порог stallSweep.stalledMs ещё не пройден.';
  if (l.action === 'stop')
    return audience === 'panel'
      ? subject === 'attempt'
        ? 'Ничего не требуется: попытка будет остановлена автоматически и повторена один раз.'
        : 'Ничего не требуется: проверка будет остановлена автоматически.'
      : subject === 'attempt'
        ? 'Ничего не требуется: controller остановит попытку отказом stalled, repairPolicy.stalled повторит её один раз.'
        : 'Ничего не требуется: controller остановит проверку с текстом зависания.';
  return audience === 'panel'
    ? `Проверьте среду (сеть, сервис, блокировку); подробности — в журнале ${subject === 'attempt' ? 'задачи' : 'проверки'}. Процесс жив, но ничего не выводит, не расходует процессор и не меняет стадий; ${who.toLowerCase()} идёт до своего предела времени.`
    : `Проверьте среду исполнения (сеть, сервис, блокировку): процесс жив, но ничего не выводит, не расходует процессор и не меняет стадий (stallSweep.action: report, explain: fix-environment). ${subject === 'attempt' ? 'Попытка идёт до runTimeoutMs; снимок процессов и хвост вывода — в событии attempt.liveness' : 'Проверка идёт до своего предела времени; переход — в журнале (joint.liveness, base.check.liveness, board.coverage.liveness)'}.`;
}

/**
 * Отказ класса `stalled`: обход остановил зависшую попытку. Это не замечание
 * к коду: повтор или правка среды (`repairPolicy.stalled` — один повтор).
 */
export const stalledFailureText =
  'Попытка зависла и остановлена: повтор или правка среды, не кода.';

/**
 * Что делать с задачей, упавшей отказом `stalled`. Правило восстановления
 * уже повторяет такую попытку один раз; `repeated` — зависла и повторная.
 */
export function stalledFailureNext(repeated: boolean) {
  return repeated
    ? 'Попытка зависла повторно: повтор уже был. Устраните неисправность среды (сеть, сервис, блокировка) или осознанно поднимите порог зависания, затем повторите задачу.'
    : 'Повтор назначается автоматически один раз. Если попытка зависнет снова — устраните неисправность среды (сеть, сервис, блокировка) или осознанно поднимите порог зависания.';
}
