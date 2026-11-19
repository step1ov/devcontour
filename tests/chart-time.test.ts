// Подписи времени графиков главной за сутки (F92): время вне сегодняшнего
// дня несёт день. Моменты заданы в местном времени процесса — тест не
// зависит от его часового пояса.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atClock, clock, dayLabel, span } from '../src/web/lib/chart-time.ts';

const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

test('F92: a time of yesterday says «вчера», today stays bare, older days carry the date', () => {
  const today = local(19, 21, 4);
  assert.equal(dayLabel(local(19, 0, 0), today), '');
  assert.equal(clock(today, today), '21:04');
  assert.equal(clock(local(18, 21, 4), today), 'вчера 21:04');
  assert.equal(atClock(local(18, 21, 4), today), 'вчера в 21:04');
  assert.equal(atClock(local(19, 9, 30), today), 'в 09:30');
  assert.equal(span(local(18, 23, 45), local(19, 0, 0), today), 'вчера 23:45–00:00');
  assert.match(clock(local(17, 8, 0), today), /^17 нояб\.? 08:00$/);
  // Первые минуты суток: вчерашний вечер — всё ещё «вчера».
  assert.equal(clock(local(18, 23, 59), local(19, 0, 1)), 'вчера 23:59');
  // Через границу месяца.
  assert.equal(
    dayLabel(new Date(2026, 10, 30, 22).getTime(), new Date(2026, 11, 1, 1).getTime()),
    'вчера',
  );
});
