import type { AuditEvent, Board, DevContourState, Task } from './model.ts';

/**
 * Почему диспетчер сам остановил выдачу работы. Пауза оператора или
 * остановка сервера причины не требуют; прежние записи паузы рантайма не
 * называли её вовсе, поэтому пустая причина означает то же, что runtime.
 * Журнал приходит от новых событий к старым: берётся самая свежая ошибка,
 * иначе при нескольких сбоях экран называл давно устранённую.
 */
export function queueStopReason(
  state: { paused?: boolean; pauseReason?: DevContourState['pauseReason'] },
  events: Pick<AuditEvent, 'id' | 'type' | 'data'>[],
) {
  if (!state.paused || (state.pauseReason && state.pauseReason !== 'runtime')) return undefined;
  const latest = events
    .filter((e) => e.type === 'scheduler.error')
    .reduce<(typeof events)[number] | undefined>((a, e) => (!a || e.id > a.id ? e : a), undefined);
  const detail = (latest?.data as { error?: string } | undefined)?.error;
  return detail ? detail.replace(/^(Error|TaskFailure):\s*/, '') : undefined;
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
