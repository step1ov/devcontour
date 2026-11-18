import { randomUUID } from 'node:crypto';

/**
 * Ответ частого опроса панели, посчитанный один раз на версию данных.
 *
 * Панель опрашивает сводку, обзор автора, центр внимания и экран подготовки
 * каждые 2–3 секунды из каждой вкладки, а каждый ответ — проекция всего
 * состояния. На большом состоянии одна проекция стоила секунды процессора,
 * и опрос занимал сервер целиком (F60). Ответ хранится по области запроса
 * (`scope`: маршрут и параметры) и действует, пока не изменились:
 *
 * - `stamp` — версия данных (ревизия хранилища и всё, что ответ читает вне
 *   него, например отметка присутствия ведущего);
 * - `deps` — то, что ответ читает из процесса, а не из базы (подключённый
 *   движок по тождеству, конфигурация текстом): их смена не пишет в базу;
 * - срок — `until` проекции (ближайший lease, после которого ответ меняется
 *   без записи) и не дольше `maxAgeMs`: всё, что зависит от времени и не
 *   названо сроком, пересчитывается не реже этого.
 *
 * Областей не больше `size`: вытесняется давно не читанная. Значение может
 * быть обещанием — тогда одновременные запросы ждут одно вычисление, а отказ
 * убирает запись.
 */
export class ProjectionCache<T> {
  /** Сколько раз проекция считалась (тесты и диагностика). */
  computations = 0;
  private readonly entries = new Map<
    string,
    { stamp: string; deps: readonly unknown[]; until: number; value: T }
  >();
  constructor(readonly options: { maxAgeMs: number; size?: number; now?: () => number }) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  get(
    scope: string,
    stamp: string,
    deps: readonly unknown[],
    /** Прежнее значение области (если было) — для сравнения с новым. */
    compute: (previous: T | undefined) => { value: T; until?: number },
  ): T {
    const now = this.now();
    const entry = this.entries.get(scope);
    this.entries.delete(scope);
    if (
      entry &&
      entry.stamp === stamp &&
      now < entry.until &&
      entry.deps.length === deps.length &&
      entry.deps.every((d, i) => d === deps[i])
    ) {
      this.entries.set(scope, entry);
      return entry.value;
    }
    this.computations++;
    const { value, until } = compute(entry?.value);
    const next = {
      stamp,
      deps,
      until: Math.min(until ?? Infinity, now + this.options.maxAgeMs),
      value,
    };
    this.entries.set(scope, next);
    while (this.entries.size > (this.options.size ?? 8))
      this.entries.delete(this.entries.keys().next().value!);
    if (value instanceof Promise)
      value.catch(() => {
        if (this.entries.get(scope) === next) this.entries.delete(scope);
      });
    return value;
  }
  /** Сократить срок значения области, когда он стал известен после вычисления. */
  limit(scope: string, value: T, until: number) {
    const entry = this.entries.get(scope);
    if (entry?.value === value) entry.until = Math.min(entry.until, until);
  }
}

/** Тело ответа с меткой содержимого `etag`. */
export interface Etagged {
  etag: string;
  body: string;
  /** Тело без метки и полей момента чтения — по нему сравнивается пересчёт. */
  comparable: string;
}

const instance = randomUUID().slice(0, 8);
let minted = 0;

/**
 * Тело ответа с меткой: пересчёт с тем же содержимым (кроме полей момента
 * чтения `volatile`, например `generatedAt`) сохраняет прежнюю метку, и
 * клиент, приславший её, получает «без изменений». Метка уникальна для
 * процесса: после перезапуска сервера прежняя метка не совпадёт ни с одной.
 */
export function etagged(
  value: Record<string, unknown>,
  previous: Etagged | undefined,
  volatile: readonly string[] = [],
): Etagged {
  const stable = Object.fromEntries(Object.entries(value).filter(([k]) => !volatile.includes(k)));
  const comparable = JSON.stringify(stable);
  const etag = previous?.comparable === comparable ? previous.etag : `${instance}.${(minted += 1)}`;
  const head = [
    ['etag', etag],
    ...volatile.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
  ]
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',');
  const body = comparable === '{}' ? `{${head}}` : `{${head},${comparable.slice(1)}`;
  return { etag, body, comparable };
}

/** Тело для клиента: «без изменений», если он прислал текущую метку. */
export const etaggedBody = (result: Etagged, known: string | null | undefined) =>
  known === result.etag ? JSON.stringify({ unchanged: true, etag: result.etag }) : result.body;
