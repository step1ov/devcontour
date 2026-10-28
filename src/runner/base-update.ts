import { moveBase, type RefMove } from 'devcontour-harness';
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
export async function baseUpdateOperation(h: DevContour, dataRoot: string) {
  const s = h.store.read();
  const held = !s.paused && h.config.approvalMode === 'agent' && h.holdForBaseUpdate().held;
  if (!h.store.read().paused) throw new Error('Сначала приостановите очередь: queue --pause');
  if (h.store.read().runs.some((r) => r.status === 'active'))
    throw new Error('Дождитесь завершения попыток перед переносом базы');
  let base;
  try {
    base = await updateBase(h.config, dataRoot);
  } catch (error) {
    if (held) h.pause(false);
    throw error;
  }
  if (base.updated.length) h.baseUpdated(base.updated);
  else if (held) h.pause(false);
  return base;
}
