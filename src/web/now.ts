import { useSyncExternalStore } from 'react';

// Общие часы панели для подписей, которые растут без записей: простой
// попытки без движения. Пока попытка молчит, сервер ничего не пишет, опрос
// отвечает `unchanged`, и без своего тика «зависла 10 мин» стояла бы
// полчаса. Один таймер на всю панель и только пока есть подписчик.

/** Шаг часов: минутные подписи не отстают больше чем на треть минуты. */
export const NOW_TICK_MS = 20_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let current = Date.now();

function subscribe(listener: () => void) {
  if (!listeners.size) {
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const l of listeners) l();
    }, NOW_TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const idle = () => () => {};

/**
 * Текущее время с перерисовкой каждые `NOW_TICK_MS`, пока `active`. Без
 * подписки — время отрисовки: таймер не крутится, когда тикать нечему.
 */
export function useNow(active: boolean) {
  const tick = useSyncExternalStore(
    active ? subscribe : idle,
    () => current,
    () => current,
  );
  return active ? tick : Date.now();
}
