// Исходная остановка вопроса после изменения контракта (F39).
//
// Движок продолжает остановку (`applyInput`), только если содержание
// постановки задачи то же, что при вопросе (`originBasis.contentDigest`).
// Изменение контракта (contract-change) перепривязывает задачу к новой
// редакции договора — id и digest контракта в постановке другие, и прежде
// остановка с уже проверенным ответом оказывалась тупиком. Здесь — точная
// проверка, что постановка изменилась ТОЛЬКО так: заменив каждый контракт
// одной из его прежних редакций той же цепочки, получаем ровно запомненный
// digest. Любое другое изменение (заголовок, приёмка, область, другой
// договор) проверку не проходит.
import { digestOf, type WorkOrder } from 'devcontour-harness';
import type { Contract } from '../core/model.ts';

/**
 * Digest содержания постановки — формула `contentDigest` движка: поручение
 * без ревизии источника. Другая формула в будущей версии движка даст
 * несовпадение, и проверка останется строгой.
 */
export const orderContentDigest = (order: WorkOrder) =>
  digestOf({ ...order, source: { connector: order.source.connector, ref: order.source.ref } });

/**
 * Редакции одного договора — та же цепочка, что у contract-change
 * (`ContractChanges.revisions`): тот же компонент и файл, а без файла —
 * тот же заголовок.
 */
const sameChain = (a: Contract, b: Contract) =>
  (a.repositoryId ?? undefined) === (b.repositoryId ?? undefined) &&
  (a.source || b.source ? a.source === b.source : a.title === b.title);

/** Предел перебираемых сочетаний прежних редакций: больше — строгая проверка. */
const MAX_CANDIDATES = 256;

/**
 * Постановка `order` отличается от запомненной (`originContent`) только
 * заменой закреплённых контрактов их более поздними редакциями (порядок
 * регистрации в состоянии). Совпадение без замены — не перепривязка.
 */
export function reboundOnly(
  order: WorkOrder,
  contracts: readonly Contract[],
  originContent: string | undefined,
): boolean {
  if (!originContent || orderContentDigest(order) === originContent) return false;
  const choices = order.contracts.map((pinned) => {
    const at = contracts.findIndex((c) => c.id === pinned.id);
    if (at < 0) return [pinned];
    const current = contracts[at];
    const earlier = contracts
      .slice(0, at)
      .filter((c) => sameChain(c, current))
      .map((c) => ({ id: c.id, digest: c.digest }));
    return [pinned, ...earlier];
  });
  const total = choices.reduce((n, c) => n * c.length, 1);
  if (total <= 1 || total > MAX_CANDIDATES) return false;
  for (let index = 1; index < total; index++) {
    let rest = index;
    const candidate = choices.map((c) => {
      const pick = c[rest % c.length];
      rest = Math.floor(rest / c.length);
      return pick;
    });
    if (orderContentDigest({ ...order, contracts: candidate }) === originContent) return true;
  }
  return false;
}
