// Засчитанная запись проверки базы и решение «повторы исчерпаны» — одно
// правило для проверки базы циклом задания (`checkBase`) и для подсказок
// (`liftsPause`, `session_handoff` host.next, центр внимания): иначе цикл
// пропускает прогон и оставляет провал, а подсказка обещает, что цикл
// проверит базу. Модуль без тяжёлых зависимостей: его читает и проекция.
import { execFileSync } from 'node:child_process';
import { baseMovesOf, type DevContour } from '../core/service.ts';
import type { DevContourState } from '../core/model.ts';
import { dependsOnRepository, repositories, repository } from '../core/repositories.ts';
import { heldBaseOf } from '../core/work-status.ts';
import type { BaseCheck } from './base-check.ts';

/** Локальная запись проверки базы: компонент, SHA базы, договор и исход. */
export const BASE_CHECK = 'base-check';
/**
 * Повторов провалившейся проверки базы. Провал gate базы бывает и сбоем среды
 * (бюджет времени под нагрузкой), поэтому один повтор — автоматически; после
 * него провал стоит до переноса базы, смены договора или `queue --start`.
 */
export const BASE_CHECK_RETRIES = 1;

/** Те же базы поставщиков (запись без поля — без поставщиков). */
export const sameProviders = (r: Pick<BaseCheck, 'providers'>, providers: Record<string, string>) =>
  JSON.stringify(Object.entries(r.providers ?? {}).sort()) ===
  JSON.stringify(Object.entries(providers).sort());

/** База компонента: SHA его целевой ветки. */
export interface BaseSha {
  repositoryId: string;
  sha: string;
}

/**
 * Основание проверки базы `base` из снимка баз `bases`: договор компонента,
 * базы его поставщиков (`dependsOn`, транзитивно) и запись той же базы,
 * которую засчитает `checkBase` — того же договора и тех же поставщиков:
 * сдвиг поставщика — тоже перенос.
 */
export function baseCheckBasis(h: DevContour, base: BaseSha, bases: readonly BaseSha[]) {
  const policyDigest = h.policyDigest(base.repositoryId);
  const dependencies = bases.filter((b) =>
    dependsOnRepository(h.config, base.repositoryId, b.repositoryId),
  );
  const providers = Object.fromEntries(dependencies.map((b) => [b.repositoryId, b.sha]));
  const previous = h.store.localRecord<BaseCheck>(BASE_CHECK, base.repositoryId, base.sha);
  const record =
    previous?.policyDigest === policyDigest && sameProviders(previous, providers)
      ? previous
      : undefined;
  return { policyDigest, dependencies, providers, record };
}

/**
 * Прогон записи больше не нужен: она есть и прошла или исчерпала повторы
 * (иначе — её нет или она не прошла и повтор ещё есть).
 */
export const baseCheckSettled = (record: BaseCheck | undefined) =>
  !!record && (record.passed || (record.tries ?? 1) > BASE_CHECK_RETRIES);

/** SHA целевой ветки компонента — синхронно. */
export const targetSha = (path: string, branch: string) =>
  execFileSync('git', ['-C', path, 'rev-parse', 'refs/heads/' + branch], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  }).trim();

/** Начала причин ожидания, которые `checkBase` пишет после непрошедшей проверки. */
const SPENT_DETAILS = ['Проверка базы не пройдена', 'Проверка базы прервана'];

/**
 * Повторы проверки базы исчерпаны: `checkBase` не исполнит ни одного gate и
 * оставит ожидание провалом (`failed`). Те же условия, что у неё: режим
 * агента, неудержанное ожидание с диапазоном этого переноса, у каждого
 * компонента с gates — засчитанная запись на SHA его целевой ветки (тот же
 * договор, те же базы поставщиков), прошедшая или с исчерпанными повторами,
 * и хотя бы одна не прошла. Возвращает непрошедшие компоненты/gates.
 *
 * Git читается (rev-parse целевых веток), только когда ожидание уже названо
 * непрошедшей проверкой или перенесённая база компонента уже исчерпала
 * повторы (перенос вернул базу на проверенный SHA): иначе цикл ещё
 * проверит базу, и опрос подсказок не запускает git.
 */
export function baseCheckSpent(
  h: DevContour,
  state: Readonly<DevContourState>,
): { failures: string[] } | undefined {
  if ((h.config.approvalMode ?? 'agent') !== 'agent') return undefined;
  const wait = state.waits?.find((w) => w.kind === 'base-check');
  const moves = baseMovesOf(state);
  if (!state.paused || !wait || !moves || heldBaseOf(state)) return undefined;
  const named = SPENT_DETAILS.some((x) => wait.detail.startsWith(x));
  const spentMove = moves.some((m) => {
    const r = h.store.localRecord<BaseCheck>(BASE_CHECK, m.repositoryId, m.to);
    return !!r && !r.passed && baseCheckSettled(r);
  });
  if (!named && !spentMove) return undefined;
  let bases: BaseSha[];
  try {
    bases = repositories(h.config).map((r) => ({
      repositoryId: r.id,
      sha: targetSha(r.path, r.targetBranch),
    }));
  } catch {
    // Базу не прочитать — цикл тоже не проверит её сейчас; подсказка прежняя.
    return undefined;
  }
  const failures: string[] = [];
  for (const base of bases) {
    if (!repository(h.config, base.repositoryId).gates.length) continue;
    const { record } = baseCheckBasis(h, base, bases);
    if (!record || !baseCheckSettled(record)) return undefined;
    if (!record.passed)
      failures.push(
        ...(record.failures.length
          ? record.failures.map((f) => `${base.repositoryId}/${f.gate}`)
          : [`${base.repositoryId}`]),
      );
  }
  return failures.length ? { failures } : undefined;
}
