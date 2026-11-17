// Остановка такта «база прогонов отстала» (`Scheduler.assertBaseCurrent`) и её
// снятие. Одно правило для всех, кто её снимает: такт очереди и шаг `base`
// операции изменения контракта (F40). Иного пути снять эту остановку нет.
import type { DevContour } from '../core/service.ts';
import { waitBaseCheck } from '../core/service.ts';
import type { DevContourState } from '../core/model.ts';
import { repositories } from '../core/repositories.ts';
import { staleBaseStop } from '../core/work-status.ts';
import { holdSensitiveBaseMove } from './base-check.ts';
import { git } from './process.ts';

export interface BaseDrift {
  repositoryId: string;
  branch: string;
  behind: number;
  ahead: number;
}

/**
 * Снимок баз прогонов: вершина целевой ветки каждого компонента (`tips`) и
 * отставание базы от рабочей ветки (`drift`) — по тем же прочитанным
 * вершинам. Остановка записывает именно эти вершины, без отдельного чтения:
 * иначе сдвиг ref между чтениями записал бы уже сдвинутую вершину.
 */
export async function readBases(h: Pick<DevContour, 'config'>) {
  const tips: Record<string, string> = {};
  const drift: BaseDrift[] = [];
  for (const repo of repositories(h.config)) {
    const target = `refs/heads/${repo.targetBranch}`;
    const head = await git(repo.path, 'rev-parse', 'HEAD');
    const tip = await git(repo.path, 'rev-parse', target);
    tips[repo.id] = tip;
    if (head === tip) continue;
    const behind = Number(await git(repo.path, 'rev-list', '--count', `${tip}..${head}`));
    if (!behind) continue;
    drift.push({
      repositoryId: repo.id,
      branch: repo.targetBranch,
      behind,
      ahead: Number(await git(repo.path, 'rev-list', '--count', `${head}..${tip}`)),
    });
  }
  return { tips, drift };
}

export type StaleBaseOutcome =
  /** Остановки нет (или она уже другая). */
  | 'none'
  /** База всё ещё отстаёт: остановка остаётся. */
  | 'lagging'
  /** Базы на записанных вершинах: коммиты ушли с рабочей ветки, остановка снята. */
  | 'released'
  /** База сдвинута мимо `base-update` или вершины не записаны: ожидание `base-check`. */
  | 'base-check';

/**
 * Снять остановку «база прогонов отстала» (`staleBaseStop`), когда
 * отставания больше нет.
 *
 * - Базы на вершинах, записанных при остановке (`targets` в её
 *   `scheduler.error`), — значит, коммиты ушли с рабочей ветки: пауза
 *   снимается (`scheduler.stale-base.cleared`).
 * - База сдвинута иначе (git напрямую, слияние в ветку интеграции) — это
 *   перенос базы, а не повод выдавать: очередь встаёт на ожидание
 *   `base-check` с диапазоном от записанной вершины
 *   (`scheduler.stale-base.target-moved`), удержание чувствительных путей
 *   (D42) записывается сразу; дальше — gates базы или подтверждение
 *   оператора.
 * - Вершина не записана (остановка прежней версии, компонент добавлен после
 *   остановки) — перенос неизвестен: то же ожидание `base-check` на текущей
 *   вершине, gates базы исполняются. Остановка не становится тупиком.
 *
 * `performed` — сдвиги, сделанные самим вызывающим по своему доказательству
 * (шаг `base` операции изменения контракта): компонент, чья база сдвинута
 * ровно так (с записанной вершины на `to`), считается несдвинутым.
 * `released` — запись вызывающего в той же транзакции, что снятие. Всё —
 * CAS по времени паузы: паузу, поставленную за время чтения git, это не
 * снимает и не переписывает.
 */
export async function settleStaleBaseStop(
  h: DevContour,
  dataRoot: string,
  options: {
    by: 'tick' | 'contract-change';
    read?: () => ReturnType<typeof readBases>;
    performed?: { repositoryId: string; from: string; to: string }[];
    released?: () => void;
  },
): Promise<StaleBaseOutcome> {
  const view = h.store.view();
  const errors = h.store.latestEvents(['scheduler.error'], 50);
  if (!staleBaseStop(view, errors)) return 'none';
  const since = view.pausedAt!;
  // Сбой, который `staleBaseStop` назвал причиной: последний после паузы.
  const from = Date.parse(since) - 1000;
  const cause = errors.find((e) => Date.parse(e.at) >= from);
  const targets = (cause?.data as { targets?: Record<string, string> } | undefined)?.targets;
  const { tips, drift } = await (options.read ?? (() => readBases(h)))();
  if (drift.length) return 'lagging';
  const moved: { repositoryId: string; from: string; to: string }[] = [];
  for (const [repositoryId, to] of Object.entries(tips)) {
    const recorded = targets?.[repositoryId];
    if (recorded === to) continue;
    if (
      recorded &&
      options.performed?.some(
        (p) => p.repositoryId === repositoryId && p.from === recorded && p.to === to,
      )
    )
      continue;
    // Неизвестная вершина: диапазона нет, gates исполняются на текущей.
    moved.push({ repositoryId, from: recorded ?? to, to });
  }
  const same = (s: DevContourState) =>
    s.paused &&
    !s.pauseReason &&
    !s.pauseFailures?.length &&
    !s.waits?.length &&
    s.pausedAt === since;
  if (!moved.length) {
    const cleared = h.store.change('scheduler.stale-base.cleared', (s) => {
      // CAS: та же пауза, что прочитана до сверки базы.
      if (!same(s)) return { cleared: false };
      s.paused = false;
      delete s.pausedAt;
      delete s.pauseActor;
      options.released?.();
      return { cleared: true, by: options.by, pausedAt: since };
    });
    return cleared.cleared ? 'released' : 'none';
  }
  const unknown = moved.filter((m) => !targets?.[m.repositoryId]).map((m) => m.repositoryId);
  const recorded = h.store.change('scheduler.stale-base.target-moved', (s) => {
    if (!same(s)) return { recorded: false };
    s.pauseReason = 'base-check';
    s.pausedAt = new Date().toISOString();
    waitBaseCheck(
      s,
      moved,
      `База прогонов перенесена мимо base-update (${moved.map((m) => m.repositoryId).join(', ')}): проверьте её гейтами и продолжите очередь`,
    );
    return {
      recorded: true,
      by: options.by,
      pausedAt: since,
      updated: moved,
      ...(unknown.length ? { unknown } : {}),
    };
  });
  if (!recorded.recorded) return 'none';
  await holdSensitiveBaseMove(h, dataRoot);
  return 'base-check';
}
