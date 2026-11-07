import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError, z } from 'zod';
import { DevContour, loadedDigest, operationalKeys, type OperationalKey } from '../core/service.ts';
import { DomainError, type Config } from '../core/model.ts';
import { Store } from '../core/store.ts';
import { repositories } from '../core/repositories.ts';
import { executionOf } from '../harness/execution.ts';
import { loadConfig } from './config.ts';

/**
 * Применение конфигурации — только по запросу операции изменения контракта
 * (`state.reconfigure`): ожидаемый digest загруженной конфигурации записала
 * операция, и без запроса работающий процесс правки файла не подхватывает.
 * Это не hot reload: применяется ровно ожидаемое, после drain, и отличаться
 * от действующего может только закрепление context packs.
 *
 * Второй источник запроса — `config-apply` (`requestConfigApply`):
 * эксплуатационные пределы `budgets` и `prices`. Тот же запрос с ожидаемым
 * digest и тот же drain; отличаться от действующей может только названная
 * часть, а итог — событие журнала `config.applied` или `config.apply-refused`.
 * Запрос снимает сам сервер: операции, которая повторила бы его, нет.
 */

/**
 * Работы, идущие под действующей конфигурацией — правило движка
 * (`busyWork`): попытки, совместные проверки, задания ведущего и операции
 * корпуса с живым сроком, а также работы хоста (поставка, preview).
 */
export function busyWork(h: DevContour) {
  const { engine } = executionOf(h);
  return engine.read((view) => engine.busyWork(view));
}

/**
 * Применить конфигурацию из файла в этом процессе, если digest загруженной
 * конфигурации равен ожидаемому. Расхождение — отказ с обоими digest.
 */
export function applyConfig(
  h: DevContour,
  path: string,
  expected: string,
  keys?: readonly OperationalKey[],
) {
  const text = readFileSync(path, 'utf8');
  const next = loadConfig(path, text);
  const actual = loadedDigest(next);
  if (actual !== expected)
    throw new Error(
      `Конфигурация не совпадает с ожидаемой операцией: ожидался digest ${expected.slice(0, 16)}, загружен ${actual.slice(0, 16)}`,
    );
  // Всегда через reconfigure, даже при совпадающем содержимом: так процесс
  // фиксирует поколение применённой конфигурации и момент её получения.
  h.reconfigure(next, keys);
}

/**
 * Обработать запрос применения в работающем сервере. Запрос перечитывается,
 * конфигурация применяется и подтверждается в одной транзакции: снятый или
 * заменённый запрос не применяется. Без запроса процесс, отставший от уже
 * применённой другим процессом конфигурации, догоняет её тем же правилом
 * (тот же digest, отличие только в закреплении); иначе он не выдаёт и не
 * принимает попыток до перезапуска.
 */
export function serveReconfigure(h: DevContour, path: string, by: string) {
  h.store.atomic(() => {
    const { engine } = executionOf(h);
    const state = engine.policyState();
    const request = state.reconfigure;
    if (request && !request.appliedAt && !request.error) {
      if (busyWork(h).length) return;
      const keys = configApplyKeys(request.operation);
      const before = keys && operationalValues(h.config, keys);
      try {
        // Применяется ровно ожидаемая: после загрузки движок процесса — с ней,
        // и подтверждение применения — правило движка.
        applyConfig(h, path, request.digest, keys);
      } catch (error) {
        const message = failure(error);
        h.settleReconfigure(request.operation, request.digest, by, message);
        if (keys) {
          // Повторять запрос некому: снимается сразу, иначе он держал бы выдачу.
          h.clearReconfigure(request.operation);
          h.store.appendEvent('config.apply-refused', {
            operation: request.operation,
            keys,
            digest: request.digest,
            error: message,
          });
        }
        return;
      }
      h.settleReconfigure(request.operation, request.digest, by);
      if (keys) {
        h.clearReconfigure(request.operation);
        const after = operationalValues(h.config, keys);
        h.store.appendEvent('config.applied', {
          operation: request.operation,
          keys,
          digest: request.digest,
          changed: keys.filter((k) => JSON.stringify(before![k]) !== JSON.stringify(after[k])),
          before,
          after,
        });
      }
      return;
    }
    if (!request && state.applied && state.stale)
      try {
        applyConfig(h, path, state.applied.digest);
      } catch {
        /* Догнать нельзя: процесс остаётся остановленным до перезапуска. */
      }
  });
}

/* ------------------------------------------------------------------ */
/* config-apply: бюджеты и тарифы без перезапуска                      */
/* ------------------------------------------------------------------ */

const configApplyPrefix = 'config-apply:';

/** Ключи запроса `config-apply`; у запроса другой операции — `undefined`. */
export function configApplyKeys(operation: string): OperationalKey[] | undefined {
  if (!operation.startsWith(configApplyPrefix)) return undefined;
  const keys = operation.slice(configApplyPrefix.length).split(':')[0].split(',');
  return keys.every((k): k is OperationalKey => (operationalKeys as readonly string[]).includes(k))
    ? keys
    : undefined;
}

/**
 * Ключи без `--keys` — прежний состав запроса (`budgets,prices`). Сервер
 * версии до `stallSweep` не знает этого ключа: запрос с ним он прочитал бы не
 * как config-apply, а как применение конфигурации операцией, и отклонил бы
 * его. Поэтому `stallSweep` отправляется только названным явно: такой
 * запрос старый сервер не применит, а запрос без флага остаётся прежним.
 */
export const defaultOperationalKeys = ['budgets', 'prices'] as const satisfies OperationalKey[];

/**
 * Ключи `--keys`: подмножество `budgets,prices,stallSweep,inputPolicy`; без
 * флага — `budgets,prices`. `inputPolicy`, как и `stallSweep`, — только
 * названным явно: прежний сервер этого ключа не знает.
 */
export function parseOperationalKeys(value?: string): OperationalKey[] {
  if (value === undefined) return [...defaultOperationalKeys];
  const keys = [...new Set(value.split(',').map((k) => k.trim()))].filter(Boolean);
  const unknown = keys.filter((k) => !(operationalKeys as readonly string[]).includes(k));
  if (!keys.length || unknown.length)
    throw new Error(
      `config-apply применяет без перезапуска только ${operationalKeys.join(', ')}` +
        (unknown.length ? `; не поддерживается: ${unknown.join(', ')}` : '') +
        '. Прочие ключи применяет перезапуск serve',
    );
  return operationalKeys.filter((k) => keys.includes(k));
}

const operationalValues = (config: Config, keys: readonly OperationalKey[]) =>
  Object.fromEntries(keys.map((k) => [k, config[k] ?? null])) as Record<OperationalKey, unknown>;

const failure = (error: unknown) =>
  error instanceof ZodError
    ? error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')
    : error instanceof Error
      ? error.message
      : String(error);

export type ConfigApplyResult =
  | { status: 'unchanged' | 'deferred'; keys: OperationalKey[]; digest: string; detail: string }
  | {
      status: 'applied';
      keys: OperationalKey[];
      digest: string;
      operation: string;
      changed: OperationalKey[];
      after: Record<string, unknown>;
    }
  | { status: 'refused'; keys: OperationalKey[]; digest: string; operation: string; error: string }
  | {
      status: 'pending';
      keys: OperationalKey[];
      digest: string;
      operation: string;
      waitingFor: string[];
      detail: string;
    };

/**
 * `devcontour config-apply`: запросить у работающего сервера применение
 * `budgets`/`prices` из `config.json`. Файл проверяется до запроса тем же
 * загрузчиком, что и сервер: невалидный — отказ, применённые значения не
 * меняются. Сервер применяет на своём такте, когда нет работ под прежней
 * конфигурацией, и только если файл отличается от действующей конфигурации
 * лишь названными ключами; до применения новые попытки не выдаются (правило
 * запроса). Без живого сервера запрос не пишется: `serve` прочитает файл при
 * запуске.
 */
export async function requestConfigApply(
  root: string,
  keys: OperationalKey[],
  options: { waitMs?: number; workspaceRoot?: string } = {},
): Promise<ConfigApplyResult> {
  const waitMs = options.waitMs ?? 30000;
  if (!Number.isFinite(waitMs) || waitMs < 0)
    throw new Error('--wait-ms — неотрицательное число миллисекунд');
  const path = join(root, 'config.json');
  let next: Config;
  try {
    next = loadConfig(path);
  } catch (error) {
    throw new Error(
      `config.json не прошёл проверку, применённые значения не изменились: ${failure(error)}`,
    );
  }
  if (options.workspaceRoot !== undefined && next.workspaceRoot !== options.workspaceRoot)
    throw new Error(
      'Конфигурация не принадлежит выбранному workspace; для прежней конфигурации используйте --data',
    );
  const digest = loadedDigest(next);
  const store = new Store(
    join(root, 'state.sqlite'),
    next.storage === 'component' ? repositories(next) : undefined,
  );
  try {
    const h = new DevContour(store, next);
    const { engine } = executionOf(h);
    if (engine.policyState().applied?.digest === digest)
      return {
        status: 'unchanged',
        keys,
        digest,
        detail: 'Работающий контур уже применил эту конфигурацию',
      };
    const leader = store.read().leader;
    if (!leader || leader.leaseUntil <= Date.now())
      return {
        status: 'deferred',
        keys,
        digest,
        detail: 'Работающего сервера нет: serve применит config.json целиком при следующем запуске',
      };
    const operation = `${configApplyPrefix}${keys.join(',')}:${randomUUID().slice(0, 8)}`;
    let seen = store.lastEventId();
    // Слот запроса один на контур. Запрос другой операции занят и после
    // `appliedAt`, пока она его не сняла: изменение контракта между применением
    // и снятием ещё ждёт своего подтверждения, и чужой запрос подменил бы его.
    // Движок отказывает только неприменённому, поэтому проверка — здесь, в той
    // же транзакции, что и запрос. Завершённый (применённый или отклонённый)
    // запрос прежнего config-apply никто не ждёт: сервер снимает его сразу, а
    // оставшийся после падения между подтверждением и снятием снимается здесь.
    store.atomic(() => {
      const current = store.read().reconfigure;
      if (current && configApplyKeys(current.operation) && (current.appliedAt || current.error))
        h.clearReconfigure(current.operation);
      else if (current)
        throw new Error(
          `Конфигурацию сейчас применяет операция ${current.operation}` +
            (current.appliedAt ? ' (применена, ещё не завершена)' : '') +
            (current.error ? ` (сервер отклонил: ${current.error})` : '') +
            `: дождитесь её или отмените (devcontour contract-change --id ${current.operation} --abandon) и повторите config-apply`,
        );
      h.requestReconfigure(operation, digest);
    });
    const deadline = Date.now() + waitMs;
    for (;;) {
      for (const event of store.eventsAfter(seen, 100)) {
        seen = event.id;
        const data = event.data as {
          operation?: string;
          changed?: OperationalKey[];
          after?: Record<string, unknown>;
          error?: string;
        } | null;
        if (data?.operation !== operation) continue;
        if (event.type === 'config.applied')
          return {
            status: 'applied',
            keys,
            digest,
            operation,
            changed: data.changed ?? [],
            after: data.after ?? {},
          };
        if (event.type === 'config.apply-refused')
          return { status: 'refused', keys, digest, operation, error: data.error ?? '' };
      }
      // Сервер отклонил запрос, но не снял его: так поступает сервер версии,
      // не знающей ключа (`stallSweep`), — он читает запрос как применение
      // конфигурации операцией. Неснятый запрос держал бы выдачу; он
      // завершён (`error`), и его снимает команда — как и завершённый
      // запрос прежнего config-apply перед новым.
      const refused = store.atomic(() => {
        const current = store.read().reconfigure;
        if (current?.operation !== operation || !current.error || current.appliedAt) return;
        h.clearReconfigure(operation);
        store.appendEvent('config.apply-refused', {
          operation,
          keys,
          digest,
          error: current.error,
          clearedBy: 'config-apply',
        });
        return current.error;
      });
      if (refused !== undefined)
        return {
          status: 'refused',
          keys,
          digest,
          operation,
          // Сервер отклонил и не снял запрос (вероятно, его версия не знает
          // ключа): запрос снят, применит перезапуск serve.
          error: `${refused}. Запрос снят командой: сервер его не снял (вероятно, его версия не знает ключа ${keys.join(', ')}); примените конфигурацию перезапуском serve`,
        };
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      status: 'pending',
      keys,
      digest,
      operation,
      waitingFor: busyWork(h),
      detail:
        'Сервер применит запрос, когда закончатся работы под прежней конфигурацией; до применения новые попытки не выдаются. Итог — событие config.applied или config.apply-refused в журнале',
    };
  } finally {
    store.close();
  }
}

/* ------------------------------------------------------------------ */
/* Порог вопросов исполнителя из панели                                */
/* ------------------------------------------------------------------ */

export const inputPolicyRequest = z.strictObject({
  threshold: z.number().int().min(1).max(11),
  criticalPaths: z.array(z.string()).max(50).optional(),
  /** Digest config.json, который видел оператор: файл сдвинулся — отказ без записи. */
  expectedConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * Изменить `inputPolicy` оператором (панель, без ручной правки JSON): файл
 * перечитывается и сверяется с digest, который видел оператор, новая
 * конфигурация проверяется тем же загрузчиком, записывается атомарно, и
 * пишется запрос применения `config-apply:inputPolicy` — его применяет такт
 * сервера тем же правилом, что и `devcontour config-apply --keys inputPolicy`.
 * Только оператор: автономность — выбор пользователя, не операция агента.
 */
export function requestInputPolicy(h: DevContour, root: string, raw: unknown) {
  const input = inputPolicyRequest.parse(raw);
  const path = join(root, 'config.json');
  const text = readFileSync(path, 'utf8');
  const current = loadConfig(path, text);
  if (loadedDigest(current) !== input.expectedConfigDigest)
    throw new DomainError(
      'config.json изменился после того, как его прочитала панель: обновите страницу и повторите',
      409,
    );
  const file = JSON.parse(text) as Record<string, unknown>;
  file.inputPolicy = {
    threshold: input.threshold,
    ...(input.criticalPaths ? { criticalPaths: input.criticalPaths } : {}),
  };
  const nextText = JSON.stringify(file, null, 2) + '\n';
  let next: Config;
  try {
    next = loadConfig(path, nextText);
  } catch (error) {
    throw new DomainError(`inputPolicy не принят: ${failure(error)}`, 400);
  }
  const digest = loadedDigest(next);
  const operation = `${configApplyPrefix}inputPolicy:${randomUUID().slice(0, 8)}`;
  h.store.atomic(() => {
    const busy = h.store.read().reconfigure;
    if (busy && !(configApplyKeys(busy.operation) && (busy.appliedAt || busy.error)))
      throw new DomainError(
        `Конфигурацию сейчас применяет операция ${busy.operation}: дождитесь её и повторите`,
        409,
      );
    if (busy) h.clearReconfigure(busy.operation);
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temp, nextText, { mode: statSync(path).mode & 0o777 });
    renameSync(temp, path);
    h.requestReconfigure(operation, digest);
  });
  return { status: 'requested' as const, operation, digest, inputPolicy: next.inputPolicy };
}
