// Поток хранителя аренды (`LeaseKeeper`): продлевает аренду попыток и роль
// controller своего сервера, пока его основной поток занят.
//
// Продление в harness — интервал основного потока. Синхронная работа сервера
// (разбор и запись документа состояния, проекции, ответы панели) под
// нагрузкой хоста задерживала этот интервал дольше срока аренды: попытка
// живого сервера с идущим gate истекала как «отказ окружения», а роль
// controller уходила и возвращалась тому же процессу. Поток не делит event
// loop с сервером, поэтому продлевает и тогда, когда основной поток занят.
//
// Правила безопасности те же, что у heartbeat движка, и ничего сверх них:
// - продлевается только своё: попытка `active` этого владельца с токеном
//   живого job основного потока; роль — только своего владельца;
// - только не истёкшая аренда. Истёкшая — предмет recovery и истечения у
//   любого controller; поток её не возвращает;
// - основной поток молчит дольше `maxStallMs` — процесс считается зависшим,
//   и аренда истекает обычным порядком: другой controller перенимает работу.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Store } from '../core/store.ts';
import type { ComponentLocation } from '../core/component-storage.ts';

/** Метка workerData потока хранителя: модуль импортируется и основным потоком. */
export const LEASE_KEEPER_WORKER = 'devcontourLeaseKeeper';

export interface LeaseKeeperWorkerData {
  [LEASE_KEEPER_WORKER]: true;
  file: string;
  locations?: ComponentLocation[];
  owner: string;
  leaseMs: number;
  /** Молчание основного потока, после которого поток продлевает сам. */
  stallMs: number;
  /** Самое долгое молчание, которое поток покрывает. */
  maxStallMs: number;
  /** Шаг проверки потока. */
  tickMs: number;
  /** Отметка основного потока: `Date.now()` его последнего такта (BigInt64Array[0]). */
  beat: SharedArrayBuffer;
}

export interface Renewed {
  runs: string[];
  controller: boolean;
}

/**
 * Продлить аренду своих живых попыток и свою роль controller одной
 * транзакцией `heartbeat`: журнал событий не растёт, ревизия данных тоже.
 * `live` — попытки, чьи job идут в основном потоке (id → token).
 */
export function renewOwnLeases(
  store: Store,
  owner: string,
  live: ReadonlyMap<string, string>,
  leaseMs: number,
  now = Date.now(),
): Renewed {
  return store.update('heartbeat', (draft) => {
    const until = now + leaseMs;
    const due = draft.current.runs
      .filter(
        (r) =>
          r.status === 'active' &&
          r.owner === owner &&
          live.get(r.id) === r.token &&
          r.leaseUntil > now &&
          r.leaseUntil < until,
      )
      .map((r) => r.id);
    if (due.length) {
      const state = draft.edit();
      for (const run of state.runs) if (due.includes(run.id)) run.leaseUntil = until;
    }
    const leader = draft.leader;
    const controller =
      !!leader && leader.owner === owner && leader.leaseUntil > now && leader.leaseUntil < until;
    if (controller) draft.leader = { ...leader, leaseUntil: until };
    return { runs: due, controller };
  });
}

/**
 * Класс хранилища для потока. Поток из исходников (тесты, `npm run
 * devcontour`) не получает загрузчик tsx основного потока: он подключается
 * здесь, до импорта хранилища. Сборка (`lib/`) загружает `.js` напрямую.
 */
async function storeClass(): Promise<typeof Store> {
  if (import.meta.url.endsWith('.ts')) {
    const api = 'tsx/esm/api';
    const { register } = (await import(api)) as { register: () => unknown };
    register();
  }
  return (await import('../core/store.ts')).Store;
}

function run(data: LeaseKeeperWorkerData, StoreClass: typeof Store) {
  const port = parentPort!;
  const beat = new BigInt64Array(data.beat);
  let live = new Map<string, string>();
  let store: Store | undefined;
  let lastRenewAt = 0;
  const close = () => {
    clearInterval(timer);
    try {
      store?.close();
    } catch {
      /* Соединение уже закрыто. */
    }
    store = undefined;
    port.close();
  };
  port.on('message', (message: { live?: [string, string][]; stop?: true }) => {
    if (message.live) live = new Map(message.live);
    if (message.stop) close();
  });
  const timer = setInterval(() => {
    const now = Date.now();
    const silent = now - Number(Atomics.load(beat, 0));
    // Основной поток отвечает — продлевает он сам; молчит слишком долго —
    // процесс зависший, и аренде положено истечь.
    if (silent < data.stallMs || silent > data.maxStallMs) return;
    if (!live.size || now - lastRenewAt < data.leaseMs / 3) return;
    lastRenewAt = now;
    try {
      store ??= new StoreClass(data.file, data.locations);
      const renewed = renewOwnLeases(store, data.owner, live, data.leaseMs, now);
      port.postMessage({ renewed: { ...renewed, at: now, silent } });
    } catch (error) {
      // Отказ хранилища (занято, закрыто): следующий шаг повторит, а без
      // продления аренда истечёт обычным порядком.
      port.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  }, data.tickMs);
}

if (!isMainThread && (workerData as Partial<LeaseKeeperWorkerData> | null)?.[LEASE_KEEPER_WORKER])
  void storeClass().then(
    (StoreClass) => run(workerData as LeaseKeeperWorkerData, StoreClass),
    (error: unknown) => {
      parentPort!.postMessage({ error: `Поток хранителя не запустился: ${String(error)}` });
      parentPort!.close();
    },
  );
