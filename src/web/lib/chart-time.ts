// Подписи времени графиков главной за сутки (F92): окно начинается вчера,
// и голое «21:04» у левого края читалось бы как сегодняшнее — правый край
// тоже «21:04». Время вне сегодняшнего дня (по часам браузера, как и сами
// подписи) несёт день: «вчера 21:04» или дату для более ранних дней.
// Сегодня — относительно `today`, конца окна графика (сейчас сервера).

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** День момента относительно `today`: `''` — сегодня, «вчера» или дата. */
export function dayLabel(ms: number, today: number): string {
  const day = startOfDay(ms);
  const ref = startOfDay(today);
  if (day === ref) return '';
  // Предыдущий календарный день (переход на летнее время — не 24 ч).
  const yesterday = new Date(ref);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return 'вчера';
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Время для оси и строк таблицы: «21:04», «вчера 21:04». */
export function clock(ms: number, today: number): string {
  const day = dayLabel(ms, today);
  return day ? `${day} ${hhmm(ms)}` : hhmm(ms);
}

/** Время во фразе: «в 21:04», «вчера в 21:04». */
export function atClock(ms: number, today: number): string {
  const day = dayLabel(ms, today);
  return day ? `${day} в ${hhmm(ms)}` : `в ${hhmm(ms)}`;
}

/** Интервал: «21:04–21:19», «вчера 21:04–21:19» (день — по началу). */
export function span(from: number, to: number, today: number): string {
  return `${clock(from, today)}–${hhmm(to)}`;
}
