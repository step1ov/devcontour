import { readFileSync } from 'node:fs';
import type { DevContour } from '../core/service.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { CheckCorpus } from '../core/check-store.ts';
import { repositories } from '../core/repositories.ts';
import { loadConfig } from './config.ts';
import { loadedDigest } from './config-lock.ts';

/**
 * Применение конфигурации — только по запросу операции изменения контракта
 * (`state.reconfigure`): ожидаемый digest загруженной конфигурации записала
 * операция, и без запроса работающий процесс правки файла не подхватывает.
 * Это не hot reload: применяется ровно ожидаемое, после drain, и отличаться
 * от действующего может только закрепление context packs.
 */

/**
 * Работы, идущие под действующей конфигурацией. Запись с истёкшим lease не
 * держит drain: её результат и так не будет принят (владение проверяется при
 * каждой записи), а держать применение из-за неё значило бы ждать вечно.
 */
export function busyWork(h: DevContour) {
  const s = h.store.read();
  const now = Date.now();
  const live = (x: { status: string; leaseUntil?: number }, status = 'active') =>
    x.status === status && (x.leaseUntil ?? 0) > now;
  return [
    ...s.runs.filter((r) => live(r)).map((r) => r.id),
    ...s.changeSets.flatMap((c) => [
      ...c.verifications.filter((v) => live(v)).map((v) => v.id),
      ...(c.deliveries ?? []).filter((d) => live(d)).map((d) => d.id),
    ]),
    ...(s.previewLock && s.previewLock.leaseUntil > now ? ['preview'] : []),
    ...[undefined, ...repositories(h.config).map((r) => r.id)]
      .flatMap((owner) => new LeadWorkflow(h).list(owner))
      .filter((j) => live(j, 'running'))
      .map((j) => j.key),
    ...new CheckCorpus(h).all().flatMap((suite) =>
      Object.values(suite.operations)
        .filter((op) => live(op, 'running'))
        .map((op) => `${suite.id}:${op.key}`),
    ),
  ];
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
  if (loadedDigest(h.config) !== expected) h.reconfigure(next);
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
    const s = h.store.read();
    const request = s.reconfigure;
    if (request && !request.appliedAt && !request.error) {
      if (busyWork(h).length) return;
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
      return;
    }
    if (s.appliedConfig && s.appliedConfig.digest !== loadedDigest(h.config) && !request)
      try {
        applyConfig(h, path, s.appliedConfig.digest);
      } catch {
        /* Догнать нельзя: процесс остаётся остановленным до перезапуска. */
      }
  });
}
