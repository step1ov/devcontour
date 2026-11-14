// Хранитель аренды сервера: продление аренды своих попыток и роли controller
// не зависит от того, свободен ли event loop сервера.
//
// Аренда попытки (`leaseMs`) продлевается интервалом основного потока раз в
// треть срока. Под нагрузкой хоста синхронная работа сервера задерживала
// интервал дольше оставшихся двух третей: попытка с живым gate этого же
// процесса истекала (`lease-expired`), готовые gates пропадали, а роль
// controller уходила и возвращалась тому же владельцу. Хранитель держит
// отдельный поток (`lease-keeper-worker.ts`): пока основной поток отвечает,
// поток ничего не делает; когда основной молчит дольше `stallMs`, поток сам
// продлевает аренду живых job этого процесса. Молчание дольше `maxStallMs` —
// зависание: поток перестаёт продлевать, и другой controller перенимает работу.
//
// Основной поток заодно замечает собственные задержки: задержка, при которой
// аренда могла истечь, пишется событием `server.loop-stalled` — по нему
// восстановление отличает потерю аренды живым, но перегруженным сервером от
// отказа окружения (`core/repair.ts`).
import { Worker } from 'node:worker_threads';
import type { ComponentLocation } from '../core/component-storage.ts';
import {
  LEASE_KEEPER_WORKER,
  type LeaseKeeperWorkerData,
  type Renewed,
} from './lease-keeper-worker.ts';

export interface LiveAttempt {
  id: string;
  token: string;
}

export interface LoopStall {
  /** Последний такт основного потока до задержки. */
  from: number;
  /** Такт, на котором основной поток снова ответил. */
  to: number;
  ms: number;
  /** Сколько продлений сделал поток хранителя с прошлого отчёта. */
  renewed: number;
}

export interface LeaseKeeperOptions {
  file: string;
  locations?: ComponentLocation[];
  owner: string;
  leaseMs: number;
  /** Попытки, чьи job сейчас идут в этом процессе. */
  live: () => LiveAttempt[];
  /** Задержка основного потока не короче трети срока аренды. */
  onStall?: (stall: LoopStall) => void;
  /** Отказ продления в потоке (для диагностики). */
  onError?: (message: string) => void;
  stallMs?: number;
  maxStallMs?: number;
  tickMs?: number;
}

/** Путь модуля потока: исходник под tsx, сборка — `.js` рядом. */
const workerUrl = () =>
  new URL(
    import.meta.url.endsWith('.ts') ? './lease-keeper-worker.ts' : './lease-keeper-worker.js',
    import.meta.url,
  );

export class LeaseKeeper {
  private readonly worker: Worker;
  private readonly beat: BigInt64Array;
  private readonly timer: NodeJS.Timeout;
  private lastTick = Date.now();
  private sent = '';
  private renewedSince = 0;
  private closed?: Promise<void>;
  readonly stallMs: number;
  readonly maxStallMs: number;
  /** Задержка, о которой сообщается: та, при которой аренда могла истечь. */
  readonly reportMs: number;

  constructor(private readonly options: LeaseKeeperOptions) {
    const { leaseMs } = options;
    // Порог — меньше трети срока: поток успевает продлить до того, как
    // опоздавший интервал основного потока станет опасен.
    this.stallMs = options.stallMs ?? Math.max(1000, Math.floor(leaseMs / 6));
    this.maxStallMs = options.maxStallMs ?? Math.max(10 * leaseMs, 5 * 60_000);
    this.reportMs = Math.max(this.stallMs, Math.floor(leaseMs / 3));
    const tickMs = options.tickMs ?? Math.max(100, Math.min(1000, Math.floor(this.stallMs / 4)));
    const shared = new SharedArrayBuffer(8);
    this.beat = new BigInt64Array(shared);
    Atomics.store(this.beat, 0, BigInt(Date.now()));
    const data: LeaseKeeperWorkerData = {
      [LEASE_KEEPER_WORKER]: true,
      file: options.file,
      ...(options.locations ? { locations: options.locations } : {}),
      owner: options.owner,
      leaseMs,
      stallMs: this.stallMs,
      maxStallMs: this.maxStallMs,
      tickMs,
      beat: shared,
    };
    this.worker = new Worker(workerUrl(), { workerData: data });
    // Поток не держит процесс: CLI, закончивший drain, завершается.
    this.worker.unref();
    this.worker.on('message', (message: { renewed?: Renewed; error?: string }) => {
      if (message.renewed) this.renewedSince += message.renewed.runs.length;
      if (message.error) this.options.onError?.(message.error);
    });
    this.worker.on('error', (error) => this.options.onError?.(String(error)));
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref();
    this.tick();
  }

  /** Такт основного потока: отметка жизни, состав живых job, своя задержка. */
  private tick() {
    const now = Date.now();
    Atomics.store(this.beat, 0, BigInt(now));
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap >= this.reportMs) {
      // Сообщения потока о продлениях за время задержки ещё в очереди порта:
      // отчёт — после них.
      const report = setTimeout(() => {
        const renewed = this.renewedSince;
        this.renewedSince = 0;
        this.options.onStall?.({ from: now - gap, to: now, ms: gap, renewed });
      }, 100);
      report.unref();
    }
    let live: LiveAttempt[];
    try {
      live = this.options.live();
    } catch {
      live = [];
    }
    const pairs = live.map((a) => [a.id, a.token] as [string, string]).sort();
    const key = JSON.stringify(pairs);
    if (key !== this.sent) {
      this.sent = key;
      this.worker.postMessage({ live: pairs });
    }
  }

  /** Остановить поток; повторный вызов ждёт той же остановки. */
  stop(): Promise<void> {
    if (this.closed) return this.closed;
    clearInterval(this.timer);
    this.closed = new Promise<void>((done) => {
      // Пока поток останавливается, он держит процесс: иначе `stop` ждал бы
      // выхода, которого процесс без других дел уже не дождётся.
      this.worker.ref();
      const timeout = setTimeout(() => void this.worker.terminate().finally(done), 2000);
      this.worker.once('exit', () => {
        clearTimeout(timeout);
        done();
      });
      this.worker.postMessage({ stop: true });
    });
    return this.closed;
  }
}

/**
 * Живые job исполнителя harness: id попытки и её token. Публичного API у
 * исполнителя для этого нет (`Runner.jobs` закрыт), поэтому форма проверяется:
 * при другой форме список пуст, и хранитель ничего не продлевает — поведение
 * прежнее, без продления из потока.
 */
export function runnerJobs(runner: unknown): LiveAttempt[] {
  const jobs = (runner as { jobs?: unknown } | undefined)?.jobs;
  if (!(jobs instanceof Map)) return [];
  const out: LiveAttempt[] = [];
  for (const [id, job] of jobs as Map<unknown, unknown>) {
    const token = (job as { token?: unknown } | undefined)?.token;
    if (typeof id === 'string' && typeof token === 'string') out.push({ id, token });
  }
  return out;
}
