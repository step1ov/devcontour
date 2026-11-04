import { PauseCircle } from 'lucide-react';
import type { QueueStopView } from '../core/work-status.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { cn } from '@/lib/utils.ts';

/**
 * Баннер остановленной очереди в шапке каждого экрана. Причина остановки
 * была видна только на экране этапа разработки: пауза из-за отставшей базы
 * или ожидания её проверки выглядела на остальных экранах как обычная
 * работа. Текст — общий вид остановки с сервера (`queue`), тот же, что в
 * `/api/state` и CLI `queue`; пока очередь идёт, баннера нет.
 */
export function QueueStopBanner({
  queue,
  compact = false,
}: {
  queue?: QueueStopView;
  /** В ячейке «Сейчас» полосы состояния: строка без плашки, в зарезервированной высоте. */
  compact?: boolean;
}) {
  if (!queue?.paused || !queue.stopReason) return null;
  if (compact) {
    // Тихая строка в тон полосе: янтарь (или красный при сбое) — только у
    // точки и короткой подписи, причина и «что сделать» — приглушённым
    // текстом с переносом, без обрезки. Команды выделены как код.
    const action = queue.action?.split(/(devcontour [a-z-]+(?: --[a-z-]+)*)/);
    return (
      <div
        role="status"
        aria-label="Очередь остановлена"
        data-queue-stop={queue.reason}
        className="grid min-w-0 gap-0.5 text-sm"
      >
        <p className="m-0 min-w-0 [overflow-wrap:anywhere]">
          <span
            className={cn(
              'mr-1.5 inline-flex items-center gap-1.5 font-medium',
              queue.failed ? 'text-destructive' : 'text-warning',
            )}
          >
            <span aria-hidden="true" className="inline-block size-2 rounded-full bg-current" />
            {queue.failed ? 'Очередь остановлена' : 'Очередь на паузе'}
          </span>
          <span className="text-muted-foreground">
            {queue.stopReason}
            {/[.!?…]$/.test(queue.stopReason) ? '' : '.'}
          </span>
        </p>
        {action && (
          <p className="text-muted-foreground m-0 min-w-0 pl-3.5 text-xs [overflow-wrap:anywhere]">
            Что сделать:{' '}
            {action.map((part, i) =>
              i % 2 ? (
                <code key={i} className="bg-active text-foreground rounded-xs px-1 py-px">
                  {part}
                </code>
              ) : (
                part
              ),
            )}
          </p>
        )}
      </div>
    );
  }
  return (
    <Alert
      variant={queue.failed ? 'destructive' : 'warning'}
      role="status"
      aria-label="Очередь остановлена"
      data-queue-stop={queue.reason}
      className="mb-4 flex items-start gap-3"
    >
      <PauseCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {/* Не заголовок: баннер стоит над h1 экрана и не должен ломать
            порядок заголовков. */}
        <strong className="mb-1 block leading-none font-medium">Очередь остановлена</strong>
        <AlertDescription className="grid gap-1">
          <p className="m-0">{queue.stopReason}</p>
          {queue.action && <p className="text-foreground m-0">Что сделать: {queue.action}</p>}
        </AlertDescription>
      </div>
    </Alert>
  );
}
