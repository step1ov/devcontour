import { readFileSync } from 'node:fs';
import type { DevContour } from '../core/service.ts';
import type { DevContourState } from '../core/model.ts';
import { loadConfig } from './config.ts';
import { configDigest } from './context.ts';

/**
 * Применение конфигурации — только по запросу операции изменения контракта
 * (`state.reconfigure`): ожидаемый digest `config.json` записала операция, и
 * без запроса работающий процесс правки файла не подхватывает. Это не hot
 * reload: применяется ровно ожидаемое содержимое, после drain, и отличаться
 * от действующего может только закрепление context packs.
 */

/** Нет работ, начатых под действующей конфигурацией. */
export function drained(s: DevContourState) {
  return (
    !s.runs.some((r) => r.status === 'active') &&
    !s.changeSets.some(
      (c) =>
        c.verifications.some((v) => v.status === 'active') ||
        c.deliveries?.some((d) => d.status === 'active'),
    )
  );
}

/**
 * Применить конфигурацию из файла в этом процессе, если её digest равен
 * ожидаемому. Расхождение — отказ с обоими digest, а не «то, что есть».
 */
export function applyConfig(h: DevContour, path: string, expected: string) {
  const text = readFileSync(path, 'utf8');
  const actual = configDigest(text);
  if (actual !== expected)
    throw new Error(
      `config.json не совпадает с ожидаемым операцией: ожидался digest ${expected.slice(0, 16)}, в файле ${actual.slice(0, 16)}`,
    );
  const next = loadConfig(path);
  if (readFileSync(path, 'utf8') !== text)
    throw new Error('config.json изменился во время применения');
  h.reconfigure(next);
}

/**
 * Обработать запрос применения в работающем сервере: после drain применить
 * и подтвердить, при расхождении записать отказ. Без запроса — ничего.
 */
export function serveReconfigure(h: DevContour, path: string, by: string) {
  const s = h.store.read();
  const request = s.reconfigure;
  if (!request || request.appliedAt || request.error || !drained(s)) return;
  try {
    applyConfig(h, path, request.digest);
    h.settleReconfigure(request.operation, request.digest, by);
  } catch (error) {
    h.settleReconfigure(
      request.operation,
      request.digest,
      by,
      error instanceof Error ? error.message : String(error),
    );
  }
}
