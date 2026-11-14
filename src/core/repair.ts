// Решение о восстановлении упавшей задачи доски — правило harness
// (`repairDecision`): класс отказа, одинаковые отпечатки среди прошлых
// попыток, бюджет попыток задачи и общий бюджет восстановлений. Здесь только
// перевод поручения harness в задачу DevContour — и одна поправка хоста:
// потеря аренды живым, но перегруженным сервером (`hostStarved`).
import { repairDecision as decide } from 'devcontour-harness';
import type { AttemptState, WorkState } from 'devcontour-harness/contracts';
import type { Task } from './model.ts';
import type { FailureKind } from './failure.ts';
import type { DevContour } from './service.ts';
import { executionOf } from '../harness/execution.ts';

export type RepairDecision =
  | {
      action: 'retry';
      taskId: string;
      kind: FailureKind;
      fingerprint: string;
      /** Класс держит выдачу: починив его, нужно снять его блокировку. */
      blocksQueue: boolean;
      reason: string;
      /** Повтор после потери аренды перегруженным сервером (`hostStarved`). */
      hostStarved?: true;
    }
  | { action: 'stop'; taskId?: string; kind?: FailureKind; reason: string };

/**
 * Начало причины, которую движок пишет, когда продление владения живым job
 * не удалось потому, что срок уже истёк (harness `HEARTBEAT_FAILED` и текст
 * `LEASE_STALE`). Продление вызывает интервал job, а он идёт только в живом
 * процессе-владельце: процесс был жив, но опоздал.
 */
export const LATE_HEARTBEAT = 'Продление владения не удалось: Устаревшая попытка';

export interface LoopGapEvent {
  owner: string;
  from: string;
  to: string;
}

export interface LoopGaps {
  /** Задержки основного потока (`server.loop-stalled`). */
  stalls: LoopGapEvent[];
  /** Сон машины или перевод часов (`server.clock-jump`). */
  jumps: LoopGapEvent[];
}

function gapEvents(h: DevContour, type: string, limit: number): LoopGapEvent[] {
  return h.store.latestEvents([type], limit).flatMap((e) => {
    const d = e.data as Partial<LoopGapEvent> | null;
    return d &&
      typeof d.owner === 'string' &&
      typeof d.from === 'string' &&
      typeof d.to === 'string'
      ? [{ owner: d.owner, from: d.from, to: d.to }]
      : [];
  });
}

/**
 * Разрывы основного потока серверов, последние (`runner/loop-monitor.ts`).
 * Окно — недавний журнал: решение о восстановлении принимается сразу после
 * отказа.
 */
export function loopGaps(h: DevContour, limit = 200): LoopGaps {
  return {
    stalls: gapEvents(h, 'server.loop-stalled', limit),
    jumps: gapEvents(h, 'server.clock-jump', limit),
  };
}

/** Разрыв владельца попытки, внутрь которого пришёлся конец срока аренды. */
const covers = (gaps: readonly LoopGapEvent[], owner: string, leaseUntil: number) =>
  gaps.some(
    (g) => g.owner === owner && Date.parse(g.from) < leaseUntil && Date.parse(g.to) >= leaseUntil,
  );

/**
 * Попытка истекла, потому что сервер-владелец был жив, но его основной поток
 * не успел продлить аренду: продление опоздало (`LATE_HEARTBEAT`) или сам
 * владелец записал задержку (`server.loop-stalled`), в которую пришёлся
 * конец срока аренды. Это перегрузка хоста, а не сеть, TLS или runtime.
 * Конец срока внутри сна машины или перевода часов владельца
 * (`server.clock-jump`) перегрузкой не считается и при опоздавшем продлении.
 */
export function hostStarved(
  attempt: Pick<AttemptState, 'status' | 'failureKind' | 'error' | 'owner' | 'leaseUntil'>,
  gaps: LoopGaps,
): boolean {
  if (attempt.status !== 'expired' || attempt.failureKind !== 'environment') return false;
  if (covers(gaps.jumps, attempt.owner, attempt.leaseUntil)) return false;
  return (
    !!attempt.error?.startsWith(LATE_HEARTBEAT) ||
    covers(gaps.stalls, attempt.owner, attempt.leaseUntil)
  );
}

const stripped = (fingerprint: string | undefined) =>
  fingerprint?.replace(/:host-starved:[^:]+$/, '');

/** Что делать с упавшими задачами доски; нечего чинить — `undefined`. */
export function repairDecision(
  h: DevContour,
  tasks: Pick<Task, 'id'>[],
  options: { budgetLeft: number; maxAttempts: number },
): RepairDecision | undefined {
  const gaps = loopGaps(h);
  return executionOf(h).engine.read((view) => {
    // Потеря аренды перегруженным сервером — не «та же причина ещё раз»:
    // отпечаток такой попытки свой. Предел отказов окружения harness
    // (`MAX_NEUTRAL_FAILURES`) она по-прежнему тратит: повтор сверх него
    // движок принимает только со сбросом, а сброс — решение человека.
    // Остальное решает правило harness.
    const starved = new Set<string>();
    const attempts = (workId?: string) =>
      view.attempts(workId).map((a) => {
        if (!a.failureFingerprint || !hostStarved(a, gaps)) return a;
        starved.add(a.id);
        return { ...a, failureFingerprint: `${a.failureFingerprint}:host-starved:${a.id}` };
      });
    // Остальные методы — у самого представления (`this` — оно, не обёртка).
    const adjusted = new Proxy(view, {
      get: (target, key) => {
        if (key === 'attempts') return attempts;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function'
          ? ((value as (...args: unknown[]) => unknown).bind(target) as unknown)
          : value;
      },
    });
    const lastOf = (workId: string) =>
      attempts(workId)
        .filter((a) => a.status !== 'active')
        .at(-1);
    const works = tasks.flatMap((t) => {
      const work = view.work(t.id);
      if (!work) return [];
      const last = lastOf(work.id);
      if (
        !last ||
        !starved.has(last.id) ||
        work.failureFingerprint !== stripped(last.failureFingerprint)
      )
        return [work];
      const next: WorkState = { ...work, failureFingerprint: last.failureFingerprint };
      return [next];
    });
    const decided = decide(adjusted, works, options);
    if (!decided) return undefined;
    const { workId, ...rest } = decided;
    const last = workId ? lastOf(workId) : undefined;
    return {
      ...rest,
      ...(workId ? { taskId: workId } : {}),
      ...(decided.action === 'retry' && last && starved.has(last.id) ? { hostStarved: true } : {}),
    } as RepairDecision;
  });
}
