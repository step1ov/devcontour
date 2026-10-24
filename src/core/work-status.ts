import { chainRoots, queueStop, type ChainRootCode } from 'devcontour-harness/projections';
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
