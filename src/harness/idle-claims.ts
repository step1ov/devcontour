// Выдача без перемен (F77).
//
// Такт очереди сервера идёт раз в 750 мс, и каждый, пока очередь не на паузе
// и есть свободный слот, вызывал выдачу движка. Выдача строит учёт бюджета по
// всем попыткам (копии записей вызовов), проверяет каждое готовое поручение и
// его основания — на большой истории это сотни миллисекунд. Когда выдавать
// нечего, она повторялась с тем же ответом на каждом такте: четверть ядра на
// простое при идущей очереди.
//
// Шлюз пропускает выдачу, только если с прошлой пустой выдачи изменились
// данные (ревизия и счётчик сроков хранилища — их растит любая запись любого
// процесса) или конфигурация процесса, либо прошло `maxMs`: то, что зависит
// только от времени (окна бюджета, срок чужой поставки), выдача увидит не
// позже. Шлюз действует только для такта сервера (`Scheduler.start`): явный
// запуск очереди, `drain` и прямая выдача выдают как прежде.

import type { DevContour } from '../core/service.ts';

export class IdleClaimGate {
  /** Предел, после которого выдача повторяется и без перемен, мс. */
  maxMs = 10_000;
  /** Сколько выдач шлюз пропустил (тесты и диагностика). */
  skipped = 0;
  /** Сколько выдач шлюз пропустил к движку. */
  passed = 0;
  private armed = false;
  private attempted = false;
  /** Отпечаток, который видела последняя пропущенная к движку выдача (в её транзакции). */
  private observed?: string;
  private idle?: { print: string; at: number };
  constructor(
    private readonly print: () => string,
    private readonly now: () => number = () => performance.now(),
  ) {}
  /** Вызов из `claimBarrier`: true — выдачу пропустить. */
  holds(): boolean {
    if (!this.armed) return false;
    const idle = this.idle;
    const print = this.print();
    if (idle && idle.print === print && this.now() < idle.at + this.maxMs) {
      this.skipped++;
      return true;
    }
    this.passed++;
    this.attempted = true;
    this.observed = print;
    return false;
  }
  /**
   * Такт очереди под шлюзом: `issued` — число идущих попыток процесса. Если
   * выдача была и ничего не выдала, ответ запоминается до перемены данных или
   * предела; выдала — следующий такт выдаёт снова.
   */
  async around<T>(issued: () => number, tick: () => Promise<T>): Promise<T> {
    const before = issued();
    this.armed = true;
    this.attempted = false;
    this.observed = undefined;
    try {
      return await tick();
    } finally {
      this.armed = false;
      // Запоминается отпечаток, который видела сама выдача: запись другого
      // процесса после неё (новая готовая работа) — уже другой отпечаток, и
      // следующий такт выдаст.
      if (this.attempted)
        this.idle =
          issued() > before || this.observed === undefined
            ? undefined
            : { print: this.observed, at: this.now() };
    }
  }
}

/** Шлюз такта сервера по прикладному слою: его читает `claimBarrier` хоста. */
export const idleClaimGates = new WeakMap<DevContour, IdleClaimGate>();
