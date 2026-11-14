// Задержки основного потока сервера (F46).
//
// Аренда попыток и роли controller продлевается интервалом основного потока
// раз в треть срока. Синхронная работа сервера под нагрузкой хоста задерживала
// этот интервал дольше оставшихся двух третей, и попытка живого процесса
// истекала. Монитор замечает такую задержку и записывает её событием
// `server.loop-stalled` — по нему восстановление (`core/repair.ts`) отличает
// потерю аренды живым, но перегруженным сервером от отказа окружения.
//
// Задержка меряется монотонными часами (`performance.now()`): они не идут во
// время сна машины и не прыгают при переводе системных часов. Если стенные
// часы ушли заметно дальше монотонных, это сон или перевод часов, а не
// перегрузка: такой разрыв пишется отдельным событием `server.clock-jump`, и
// истечение, пришедшееся на него, перегрузкой не считается.
//
// Проверка вызывается и своим интервалом, и в начале такта очереди до
// recovery и истечения: задержка записана раньше, чем этот же процесс
// истечёт свою попытку и решит о её восстановлении.

export interface LoopGap {
  /** Стенное время последней проверки до разрыва. */
  from: number;
  /** Стенное время проверки после разрыва. */
  to: number;
  /** Разрыв по монотонным часам: сколько процесс не исполнял JS, бодрствуя. */
  monoMs: number;
  /** Разрыв по стенным часам. */
  wallMs: number;
}

export interface LoopMonitorOptions {
  leaseMs: number;
  /** Задержка, при которой аренда могла истечь (не короче трети срока). */
  onStall: (gap: LoopGap) => void;
  /** Сон машины или перевод часов: стенные часы ушли от монотонных. */
  onClockJump: (gap: LoopGap) => void;
  /** Расхождение часов, которое считается скачком, мс. */
  jumpToleranceMs?: number;
  intervalMs?: number;
  mono?: () => number;
  wall?: () => number;
}

export class LoopMonitor {
  private lastMono: number;
  private lastWall: number;
  private timer?: NodeJS.Timeout;
  readonly stallMs: number;
  readonly jumpToleranceMs: number;
  private readonly mono: () => number;
  private readonly wall: () => number;

  constructor(private readonly options: LoopMonitorOptions) {
    this.mono = options.mono ?? (() => performance.now());
    this.wall = options.wall ?? Date.now;
    this.stallMs = Math.max(1000, Math.floor(options.leaseMs / 3));
    this.jumpToleranceMs = options.jumpToleranceMs ?? 2000;
    this.lastMono = this.mono();
    this.lastWall = this.wall();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.options.intervalMs ?? 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Разрыв с прошлой проверки; о задержке или скачке часов сообщает сразу. */
  check(): LoopGap | undefined {
    const mono = this.mono(),
      wall = this.wall();
    const gap: LoopGap = {
      from: this.lastWall,
      to: wall,
      monoMs: Math.round(mono - this.lastMono),
      wallMs: wall - this.lastWall,
    };
    this.lastMono = mono;
    this.lastWall = wall;
    // Сон или перевод часов — не перегрузка, даже если процесс и стоял.
    if (Math.abs(gap.wallMs - gap.monoMs) > this.jumpToleranceMs) {
      this.options.onClockJump(gap);
      return gap;
    }
    if (gap.monoMs >= this.stallMs) {
      this.options.onStall(gap);
      return gap;
    }
    return undefined;
  }
}
