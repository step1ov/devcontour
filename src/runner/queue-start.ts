import type { DevContour } from '../core/service.ts';
import { queueStopOf } from '../application/queue-stop.ts';

/**
 * Исход `queue --start` из CLI. Снятие паузы пишет общий документ, но выдачу
 * ведёт работающий сервер (`serve`): если база прогонов отстала или есть иная
 * причина остановки, его такт сразу снова ставит очередь на паузу. CLI
 * отвечал `{"paused": false}` по собственной записи, хотя очередь так и не
 * пошла. Поэтому при живой роли controller команда дожидается двух тактов
 * сервера после снятия паузы (такт продлевает роль; второй начинается только
 * после окончания первого) и отвечает тем, что увидел сервер.
 */
export async function startQueue(
  h: DevContour,
  options: { timeoutMs?: number; pollMs?: number } = {},
) {
  const started = h.pause(false);
  const leaseOf = () => h.store.read().leader;
  const lease = leaseOf();
  if (!lease || lease.leaseUntil <= Date.now()) return { ...started, server: 'none' as const };
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const seen = new Set([lease.leaseUntil]);
  let s = h.store.read();
  while (!s.paused && seen.size < 3 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, options.pollMs ?? 100));
    s = h.store.read();
    if (s.leader?.owner === lease.owner) seen.add(s.leader.leaseUntil);
  }
  if (s.paused) {
    // Тот же вид остановки, что в панели и API: причина и подсказка.
    const stop = queueStopOf(h, s);
    return {
      ...stop,
      paused: true,
      // Кто поставил паузу в этом окне — сервер или другой участник, — не
      // известно: ответ называет состояние и причину, а не виновника.
      error: 'Очередь осталась на паузе' + (stop.stopReason ? ': ' + stop.stopReason : ''),
    };
  }
  // Сервер не сделал двух тактов за отведённое время: снятие паузы записано,
  // но подтвердить, что очередь пошла, нечем.
  return { ...started, server: seen.size < 3 ? ('unconfirmed' as const) : ('running' as const) };
}
