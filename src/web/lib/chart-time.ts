// Подписи времени графиков главной за сутки (F92): окно начинается вчера,
// и голое «21:04» у левого края читалось бы как сегодняшнее — правый край
// тоже «21:04». Время вне сегодняшнего дня (по часам браузера, как и сами
// подписи) несёт день: «вчера 21:04» или дату для более ранних дней.
// Сегодня — относительно `today`, конца окна графика (сейчас сервера).

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Календарный день по часам браузера: сравнение дат, а не полуночей (полночь бывает пропущена переводом часов). */
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** День момента относительно `today`: `''` — сегодня, «вчера» или дата. */
export function dayLabel(ms: number, today: number): string {
  const day = dayKey(new Date(ms));
  const ref = new Date(today);
  if (day === dayKey(ref)) return '';
  // Предыдущий календарный день — от полудня: он есть в любой день.
  const yesterday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1, 12);
  if (day === dayKey(yesterday)) return 'вчера';
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
