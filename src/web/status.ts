// Единый словарь статусов задачи для всех представлений панели: граф,
// список, колонки, инспектор, ход работ и полоса состояния. Раньше граф и
// «Ход работ» называли одно и то же по-разному («Готова к запуску» и
// «Готова к выдаче»), а задачу с незакрытыми зависимостями ход работ
// показывал готовой.

export type StatusTone = 'neutral' | 'ready' | 'waiting' | 'active' | 'done' | 'failed';
export type StatusKey =
  | 'draft'
  | 'ready'
  | 'blocked'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'integrating'
  | 'done'
  | 'failed'
  | 'cancelled';

export const statusNames: Record<StatusKey, string> = {
  draft: 'Черновик',
  ready: 'Готова к запуску',
  blocked: 'Ждёт зависимостей',
  running: 'Разработка',
  verifying: 'Проверки',
  reviewing: 'Ревью',
  integrating: 'Интеграция',
  done: 'Проверена локально',
  failed: 'Сбой',
  cancelled: 'Отменена',
};

const tones: Record<StatusKey, StatusTone> = {
  draft: 'neutral',
  ready: 'ready',
  blocked: 'waiting',
  running: 'active',
  verifying: 'active',
  reviewing: 'active',
  integrating: 'active',
  done: 'done',
  failed: 'failed',
  cancelled: 'neutral',
};

/** Вариант метки (`ui/badge.tsx`) для тона статуса. */
export const badgeOf: Record<
  StatusTone,
  'secondary' | 'ready' | 'waiting' | 'success' | 'destructive'
> = {
  neutral: 'secondary',
  ready: 'ready',
  waiting: 'waiting',
  active: 'ready',
  done: 'success',
  failed: 'destructive',
};

/** Цвет следа изменения статуса (`data-changed`) — цвет нового статуса. */
export const flashOf: Record<StatusTone, string> = {
  neutral: 'var(--text-secondary)',
  ready: 'var(--status-ready)',
  waiting: 'var(--status-waiting)',
  active: 'var(--status-active)',
  done: 'var(--status-done)',
  failed: 'var(--status-failed)',
};

type StatusInput = {
  status: string;
  /** Незакрытые зависимости; задача `ready` с ними ждёт, а не готова. */
  blockers?: readonly string[];
  /** Результат принят из Git участником команды. */
  sharedCompletion?: unknown;
};

export function statusKey(t: StatusInput): StatusKey {
  if (t.status === 'ready' && t.blockers?.length) return 'blocked';
  return (t.status in statusNames ? t.status : 'draft') as StatusKey;
}

export function taskStatus(t: StatusInput) {
  const key = statusKey(t);
  const tone = tones[key];
  return {
    key,
    tone,
    badge: badgeOf[tone],
    label: key === 'done' && t.sharedCompletion ? 'Принята из Git' : statusNames[key],
  };
}

/** Подпись и тон для известного ключа (история проверок, ревизии). */
export function statusOfKey(key: string) {
  const known = (key in statusNames ? key : 'draft') as StatusKey;
  return {
    key: known,
    tone: tones[known],
    badge: badgeOf[tones[known]],
    label: statusNames[known],
  };
}
