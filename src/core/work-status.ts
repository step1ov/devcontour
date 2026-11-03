import {
  CLIP_DIAGNOSTIC,
  chainRoots,
  clipText,
  queueStop,
  type ChainRootCode,
} from 'devcontour-harness/projections';
import type { AuditEvent, Board, DevContourState, Task } from './model.ts';

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
      : 'Зарегистрируйте доску через workflow_start — цикл ведущего запустит очередь сам; ручной queue --start с этим маршрутом не смешивайте';
  const explain = (): [text: string, action: string, failed: boolean] => {
    if (failures.includes('provider-auth'))
      return [
        detail ??
          'Провайдер моделей отказал: нет кредитов, исчерпан лимит или runtime не авторизован',
        'Авторизуйте CLI исполнителя, пополните баланс или дождитесь сброса лимита, затем ' + start,
        true,
      ];
    if (failures.length)
      return [
        detail ?? 'Окружение не дало исполнителю работать',
        'Устраните неисправность окружения, затем ' + start,
        true,
      ];
    if (wait)
      return [
        wait,
        reason === 'base-check' && agent && options.workflowActive
          ? 'Цикл ведущего проверит базу gates и продолжит выдачу сам; если проверка не прошла — исправьте базу или выполните ' +
            start
          : 'Проверьте базу gates, затем выполните ' +
            start +
            (reason === 'operator' ? ' — он снимет и паузу человека, и ожидание' : ''),
        false,
      ];
    switch (reason) {
      case 'operator':
        return ['Выдача остановлена человеком', start, false];
      case 'shutdown':
        return ['Сервер был остановлен штатно', resume, false];
      case 'reconfigure':
        return [
          'Применяется новая конфигурация после изменения контракта',
          'Ничего не требуется: операция снимет паузу сама',
          false,
        ];
      case 'base-check':
        return [
          'Выдача ждёт проверки перенесённой базы gates',
          'Проверьте базу gates, затем выполните ' + start,
          false,
        ];
      case 'not-started':
        return ['Очередь ещё не запущена', resume, false];
      default:
        return detail
          ? [
              detail,
              /base-update/.test(detail)
                ? 'Выполните devcontour base-update, затем проверьте базу и ' + start
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
  const [text, action, failed] = explain();
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
