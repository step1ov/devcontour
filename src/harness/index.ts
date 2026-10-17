// Подключение исполнения DevContour к пакету devcontour-harness.
//
// Исполнение и техническая приёмка поручений принадлежат пакету: DevContour
// подключает к нему своё хранилище, продуктовые запреты и источники через
// порты. Импортируется только публичный корень пакета (и `/contracts`) —
// глубокие импорты внутренних модулей запрещены линтером.
import { HARNESS_VERSION } from 'devcontour-harness';

/** Версия установленного пакета harness, с которой работает DevContour. */
export const harnessVersion: string = HARNESS_VERSION;

export { DevContourExecutionStore, MAX_EVENTS_PER_TRANSACTION, withoutTokens } from './store.ts';
export type { HostTransaction } from './store.ts';
export { UNASSIGNED_GRAPH, type ProjectionOptions } from './projection.ts';
