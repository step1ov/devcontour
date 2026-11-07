// Черновики форм карточек центра внимания — вне компонентов: карточка,
// перешедшая в другую группу, перемонтируется, а набранный текст остаётся.
// Черновик относится к одному появлению (`sourceKey#occurrenceId`) и помнит
// версию, которую оператор видел, когда открыл форму: действие называет её,
// а не версию, пришедшую опросом позже.
import { useSyncExternalStore } from 'react';
import type { AttentionItem } from './attention-logic.ts';

export interface Draft {
  open: string | null;
  text: string;
  option: string | null;
  kind: 'clarification' | 'requirement-change';
  /** Ключ повтора открытой формы: повтор после обрыва — без второго эффекта. */
  key: string;
  /** Показанная версия при открытии формы; её называет действие. */
  pin: { occurrenceId: string; sourceVersion: string; title: string; reason: string } | null;
}

export const emptyDraft = (): Draft => ({
  open: null,
  text: '',
  option: null,
  kind: 'clarification',
  key: crypto.randomUUID(),
  pin: null,
});

/** Ключ черновика — появление карточки (как `id` карточки). */
export const draftKey = (i: Pick<AttentionItem, 'sourceKey' | 'occurrenceId'>) =>
  `${i.sourceKey}#${i.occurrenceId}`;

/** Набранный текст есть — черновик нельзя терять молча. */
export const hasText = (d: Draft | undefined) => !!d && !!d.text.trim();

/**
 * Карточка изменилась после открытия формы: версия не та, что видел
 * оператор. Тогда форма не отправляется, пока он не подтвердит новую версию.
 */
export const pinStale = (d: Draft, item: Pick<AttentionItem, 'occurrenceId' | 'sourceVersion'>) =>
  !!d.open &&
  !!d.pin &&
  (d.pin.occurrenceId !== item.occurrenceId || d.pin.sourceVersion !== item.sourceVersion);

/** Черновики с текстом, чьих появлений больше нет в ответе: их показывают отдельно. */
export function orphanDrafts(
  all: ReadonlyMap<string, Draft>,
  items: readonly Pick<AttentionItem, 'id'>[],
) {
  const present = new Set(items.map((i) => i.id));
  return [...all].filter(([key, d]) => !present.has(key) && hasText(d));
}

const store = new Map<string, Draft>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, Draft> = new Map();
const emit = () => {
  snapshot = new Map(store);
  for (const l of listeners) l();
};

export function setDraft(key: string, patch: Partial<Draft>) {
  const next = { ...(store.get(key) ?? emptyDraft()), ...patch };
  if (next.open === null && !next.text) store.delete(key);
  else store.set(key, next);
  emit();
}
export function removeDraft(key: string) {
  if (store.delete(key)) emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
/** Все черновики вкладки. */
export const useDrafts = () => useSyncExternalStore(subscribe, () => snapshot);
/** Черновик одного появления. */
export function useDraft(key: string): [Draft, (patch: Partial<Draft>) => void] {
  const all = useDrafts();
  return [all.get(key) ?? emptyDraft(), (patch) => setDraft(key, patch)];
}
