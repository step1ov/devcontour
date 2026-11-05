import { resolve } from 'node:path';
import { fencedRefMove, moveBase, type ExecutionView, type RefMove } from 'devcontour-harness';
import { executionOf } from '../harness/execution.ts';
import { repositories } from '../core/repositories.ts';
import type { Config } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { policyFromConfig } from '../harness/policy.ts';
import { checkoutRootFor, checkoutRootOption } from './checkout-root.ts';

// Прогон ответвляется от ветки интеграции, а контракты, схемы и каркас
// готовятся на рабочей ветке репозитория. Перенос базы сводит эти линии явно и
// целиком: очередь стоит, попыток нет, результат — один SHA на репозиторий.
// Сам перенос (fast-forward или слияние без hooks, CAS ref) — `moveBase`
// пакета harness; здесь — ветки DevContour и подсказки оператору.
export async function updateBase(
  config: Config,
  dataRoot: string,
  /**
   * Перенести только эти компоненты и ровно на эти commit, а не на текущий
   * HEAD: операция, проверившая одну редакцию, не переносит ту, что появилась
   * в рабочей ветке после проверки.
   */
  only?: Record<string, string>,
  /**
   * Сдвиг ref — единственный внешний эффект переноса. По умолчанию он идёт
   * обычной командой; владелец операции передаёт сюда синхронный сдвиг внутри
   * своей транзакции (`fencedRefMove`), чтобы проверка владения и сдвиг не
   * разделялись окном.
   */
  move?: RefMove,
) {
  // Перенос не исполняет gates: достаточно репозиториев политики.
  const policy = policyFromConfig(config, { purpose: 'review' });
  const moved = await moveBase({
    policy,
    baseDir: dataRoot,
    stateDir: dataRoot,
    // Дерево слияния — под корнем рабочих деревьев workspace, как у попыток.
    ...checkoutRootOption(checkoutRootFor(config, dataRoot)),
    ...(only ? { only } : {}),
    ...(move ? { move } : {}),
  });
  const branch = (repositoryId: string) =>
    repositories(config).find((r) => r.id === repositoryId)!.targetBranch;
  const updated = moved.updated.map((u) => ({
    repositoryId: u.repositoryId,
    branch: branch(u.repositoryId),
    from: u.from,
    to: u.to,
    commits: u.commits,
    kind: u.kind,
  }));
  // Обратное направление: принятая работа, которой нет в рабочей ветке. Правки
  // контракта, подготовленные на такой ветке, ложатся на старые файлы приёмки
  // и схемы и расходятся с принятыми при следующем переносе.
  const workingBehind = (moved.workingBehind ?? []).map((w) => ({
    repositoryId: w.repositoryId,
    branch: branch(w.repositoryId),
    commits: w.commits,
  }));
  return {
    updated,
    ...(workingBehind.length
      ? {
          workingBehind,
          warning: `Рабочая ветка не содержит принятой работы (${workingBehind
            .map((w) => `${w.repositoryId}: ${w.commits}`)
            .join(
              ', ',
            )}). Перед правкой контрактов и файлов приёмки выполните git merge ${workingBehind[0].branch}, иначе правки лягут на устаревшие файлы.`,
        }
      : {}),
    next: updated.length
      ? config.approvalMode === 'agent'
        ? 'База обновлена; очередь ждёт проверки базы (base-check). Запущенный workflow доски проверит её gates и продолжит очередь; без workflow проверьте базу гейтами и выполните queue --start.'
        : 'База обновлена. Проверьте её гейтами и запустите очередь: queue --start.'
      : 'База уже содержит рабочую ветку; менять нечего.',
  };
}

/**
 * Команда `base-update`: перенос на остановленной очереди без попыток. В
 * режиме агента перенос сам ставит работающую очередь на ожидание
 * `base-check` (`holdForBaseUpdate`); если переносить нечего или перенос не
 * удался, поставленное им ожидание снимается — очередь остаётся такой, какой
 * была. Перенесённая база ждёт проверки (`baseUpdated`).
 */
/** Отказы переноса — одни и те же в проверке до переноса и в транзакции сдвига. */
const NOT_PAUSED = 'Сначала приостановите очередь: queue --pause';
const ACTIVE = 'Дождитесь завершения попыток перед переносом базы';

export async function baseUpdateOperation(
  h: DevContour,
  dataRoot: string,
  options: {
    /**
     * Кто переносит (`base.moved`): `operator` — человек (по умолчанию для
     * CLI), `host` — ведущий агент, актёр не назван.
     */
    by?: 'operator' | 'host';
    /** Дополнительная проверка в транзакции сдвига каждого репозитория (тесты). */
    fence?: (view: ExecutionView) => void;
  } = {},
) {
  const s = h.store.read();
  const held = !s.paused && h.config.approvalMode === 'agent' && h.holdForBaseUpdate().held;
  if (!h.store.read().paused) throw new Error(NOT_PAUSED);
  if (h.store.read().runs.some((r) => r.status === 'active')) throw new Error(ACTIVE);
  // Сдвиг ref — в транзакции проверки (очередь стоит, попыток нет) и
  // событием `base.moved` с актёром переноса.
  const fenced = fencedRefMove(
    executionOf(h).store,
    (view) => {
      if (!view.control().paused) throw new Error(NOT_PAUSED);
      if (view.attempts().some((a) => a.status === 'active')) throw new Error(ACTIVE);
      options.fence?.(view);
    },
    undefined,
    options.by ?? 'operator',
  );
  // Перенесённые до отказа репозитории: их база уже сдвинута и ждёт проверки.
  const moved: { repositoryId: string; from: string; to: string }[] = [];
  const idOf = (path: string) =>
    repositories(h.config).find((r) => resolve(r.path) === resolve(path))?.id ?? path;
  const move: RefMove = async (path, target, to, from) => {
    await fenced(path, target, to, from);
    moved.push({ repositoryId: idOf(path), from, to });
  };
  let base;
  try {
    base = await updateBase(h.config, dataRoot, undefined, move);
  } catch (error) {
    // Частичный перенос (сдвиг следующего репозитория отклонён) — как у
    // перемотки диспетчером: сдвинутые базы ждут проверки base-check.
    if (moved.length) h.baseUpdated(moved);
    else if (held) h.pause(false);
    throw error;
  }
  if (base.updated.length) h.baseUpdated(base.updated);
  else if (held) h.pause(false);
  return base;
}
