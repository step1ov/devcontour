import { readFileSync } from 'node:fs';
import type { DevContour } from '../core/service.ts';
import { executionOf } from '../harness/execution.ts';
import { loadConfig } from './config.ts';
import { loadedDigest } from '../core/service.ts';

/**
 * Применение конфигурации — только по запросу операции изменения контракта
 * (`state.reconfigure`): ожидаемый digest загруженной конфигурации записала
 * операция, и без запроса работающий процесс правки файла не подхватывает.
 * Это не hot reload: применяется ровно ожидаемое, после drain, и отличаться
 * от действующего может только закрепление context packs.
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
export function applyConfig(h: DevContour, path: string, expected: string) {
  const text = readFileSync(path, 'utf8');
  const next = loadConfig(path, text);
  const actual = loadedDigest(next);
  if (actual !== expected)
    throw new Error(
      `Конфигурация не совпадает с ожидаемой операцией: ожидался digest ${expected.slice(0, 16)}, загружен ${actual.slice(0, 16)}`,
    );
  // Всегда через reconfigure, даже при совпадающем содержимом: так процесс
  // фиксирует поколение применённой конфигурации и момент её получения.
  h.reconfigure(next);
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
      try {
        // Применяется ровно ожидаемая: после загрузки движок процесса — с ней,
        // и подтверждение применения — правило движка.
        applyConfig(h, path, request.digest);
      } catch (error) {
        h.settleReconfigure(
          request.operation,
          request.digest,
          by,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      h.settleReconfigure(request.operation, request.digest, by);
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
