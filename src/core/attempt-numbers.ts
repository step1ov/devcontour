// Сквозной номер попытки задачи. Счётчик бюджета (`Run.attempt`) — не
// идентификатор: после перезапуска счёта новой постановкой (D47) или сброса
// человеком (`retry --reset`) он начинается снова с 1, а возвращённая попытка
// (отказ окружения) повторяет номер. Номер выводится из порядка записей
// попыток: формат состояния не меняется.

/**
 * Номер каждой попытки (по `id`) — её место в истории попыток своей задачи,
 * с 1. Записи — в порядке выдачи, как `state.runs`; передавайте всю историю,
 * а не её конец: иначе номер сдвинется.
 */
export function attemptNumbers(
  runs: readonly { id: string; taskId: string }[],
): Map<string, number> {
  const count = new Map<string, number>();
  const numbers = new Map<string, number>();
  for (const run of runs) {
    const n = (count.get(run.taskId) ?? 0) + 1;
    count.set(run.taskId, n);
    numbers.set(run.id, n);
  }
  return numbers;
}
