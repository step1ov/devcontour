import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
/** Русское склонение по числу: 1 задача, 2 задачи, 5 задач. */
export const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10,
    mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11
    ? one
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? few
      : many;
};
// Сетевой отказ fetch — английское «Failed to fetch»: для человека это
// «сервер не отвечает», с адресом, который он открыл.
export function humanError(message: string) {
  return /failed to fetch|networkerror|load failed/i.test(message)
    ? `Сервер DevContour не отвечает по адресу ${window.location.host}. Проверьте, что devcontour serve запущен.`
    : message;
}
