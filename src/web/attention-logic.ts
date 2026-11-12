// Чистые правила интерфейса центра внимания: без DOM и без запросов, чтобы
// их проверяли модульные тесты. Интерфейс не решает, существует ли карточка:
// набор, порядок, actor и действия приходят из проекции сервера.
import type {
  AttentionActor,
  AttentionCategory,
  AttentionHistoryItem,
  AttentionItem,
  AttentionSubjectKind,
} from '../core/attention-model.ts';
import type { AttentionView } from '../application/attention.ts';
import { plural } from './lib/utils.ts';

export type { AttentionItem, AttentionHistoryItem, AttentionView };

type BadgeVariant = 'default' | 'secondary' | 'warning' | 'destructive';

const operatorCategory: Record<AttentionCategory, { text: string; variant: BadgeVariant }> = {
  access: { text: 'Нужен доступ', variant: 'destructive' },
  budget: { text: 'Бюджет исчерпан', variant: 'destructive' },
  question: { text: 'Вопрос к вам', variant: 'warning' },
  decision: { text: 'Ваше решение', variant: 'default' },
  technical: { text: 'Нужно ваше действие', variant: 'warning' },
};
const leadCategory: Record<AttentionCategory, string> = {
  access: 'доступ и среда',
  budget: 'бюджет',
  question: 'вопрос',
  decision: 'решение',
  technical: 'техническое',
};

/**
 * Подпись категории решается сначала по тому, кто действует: карточка
 * ведущего агента никогда не называется «Ваше решение» или «Вопрос к вам».
 */
export function categoryLabel(item: Pick<AttentionItem, 'actor' | 'category'>): {
  text: string;
  variant: BadgeVariant;
} {
  if (item.actor !== 'operator')
    return { text: `Ведущий агент · ${leadCategory[item.category]}`, variant: 'secondary' };
  return operatorCategory[item.category];
}

export const actorLabel = (actor: AttentionActor) =>
  actor === 'operator' ? 'Вы' : 'Ведущий агент';

/** «Что блокирует» одной фразой; без задач — ничего. */
export function impactLine(impact: AttentionItem['impact']) {
  if (!impact.tasks && !impact.waiting) return '';
  if (impact.tasks === 1 && !impact.waiting) return 'Держит задачу';
  return (
    `Держит ${impact.tasks} ${plural(impact.tasks, 'задачу', 'задачи', 'задач')}` +
    `; ждут результата: ${impact.waiting}`
  );
}

const openLabels: Record<AttentionSubjectKind, string> = {
  change: 'Открыть изменение',
  task: 'Открыть задачу',
  run: 'Открыть задачу',
  request: 'Открыть вопрос',
  board: 'Открыть доску',
  changeset: 'Открыть изменения',
  preview: 'Открыть изменения',
  suite: 'Открыть контракты',
  operation: 'Открыть контракты',
  queue: 'Открыть обзор',
  budget: 'Открыть обзор',
};
export function openLabel(item: Pick<AttentionItem, 'source' | 'subject'>) {
  if (item.source === 'prep-question') return 'Открыть вопрос';
  return openLabels[item.subject.kind] ?? 'Открыть';
}

const statusTexts: Record<string, string> = {
  'prep-question/answer': 'Ответ сохранён. Ведущий агент превратит его в решение.',
  'prep-stage/approve': 'Утверждено.',
  'prep-stage/request-changes': 'Возвращено на доработку.',
  'plan/approve': 'План утверждён: задачи доступны очереди.',
  'discussion-needs-answer/answer': 'Ответ отправлен ведущему агенту.',
  'stand-in/confirm': 'Решение подтверждено.',
  'stand-in/reverse': 'Решение отменено: ведущий агент получил обращение с вашим вариантом.',
  'queue/resume': 'Очередь запущена.',
  'wait/resume': 'Очередь запущена.',
  'input/answer': 'Ответ сохранён. Дальше ведущий готовит контекст новой попытки.',
  'input/apply': 'Ответ применён: он уйдёт в следующую попытку.',
  'changeset/accept': 'Изменение принято.',
  'changeset/deploy-preview': 'Выкладка preview начата.',
  'corpus/approve': 'Версия корпуса подтверждена.',
};
export const statusText = (source: string, action: string) =>
  statusTexts[`${source}/${action}`] ?? 'Выполнено';

/**
 * Подпись ответа для обнаружения изменений: ревизия данных не меняется у
 * фактов без записи (зависание, Git быстрого маршрута), поэтому в подписи и
 * карточки с версиями и отметками. Та же подпись — без перерисовки.
 */
export function signatureOf(view: AttentionView) {
  return [
    view.revision,
    view.counts.active,
    view.counts.unread,
    view.items
      .map(
        (i) =>
          `${i.id}:${i.sourceVersion}:${Number(i.state.unread)}${Number(i.state.acknowledged)}`,
      )
      .join(','),
    view.lead.present,
    view.truncated?.count ?? '',
  ].join('|');
}

export const SEEN_LIMIT = 2000;

/**
 * Новые карточки для уведомления. Первый ответ только заполняет `seen` и
 * не уведомляет; дальше уведомляют карточки оператора с непрочитанным
 * новым появлением (`id` = ключ#появление), которых ещё не было. Новая
 * версия того же появления, карточка ведущего, вернувшийся тот же `id` и
 * отметки из другой вкладки не уведомляют. `seen` ограничен 2000 ключами,
 * старые выбрасываются.
 */
export function freshItems(
  seen: Set<string> | undefined,
  items: readonly AttentionItem[],
): { fresh: AttentionItem[]; seen: Set<string> } {
  const next = new Set(seen ?? []);
  const fresh = seen
    ? items.filter((i) => i.actor === 'operator' && i.state.unread && !seen.has(i.id))
    : [];
  for (const i of items) {
    // Повторно встреченный id переезжает в конец: вытесняются давние.
    next.delete(i.id);
    next.add(i.id);
  }
  while (next.size > SEEN_LIMIT) next.delete(next.values().next().value!);
  return { fresh, seen: next };
}

/** Текст уведомления по новым карточкам ответа. */
export const toastText = (fresh: readonly Pick<AttentionItem, 'title'>[]) =>
  fresh.length === 1 ? `Нужно действие: ${fresh[0].title}` : `Новых действий: ${fresh.length}`;

/** Id элемента карточки: цель фокуса после перехода и уведомления. */
export const cardDomId = (sourceKey: string) => 'attention-' + sourceKey;

/** Ключ отметки появления: отметки относятся к появлению и показанной версии. */
export const markKey = (i: Pick<AttentionItem, 'sourceKey' | 'occurrenceId'>) =>
  `${i.sourceKey}#${i.occurrenceId}`;

export type Optimistic = Map<string, { version: string; read: boolean; ack: boolean }>;

/**
 * Карточки с локальными отметками до подтверждения опросом: отметка
 * показанной версии; более новая версия остаётся непрочитанной.
 */
export function withOptimistic(items: readonly AttentionItem[], optimistic: Optimistic) {
  if (!optimistic.size) return items as AttentionItem[];
  return items.map((i) => {
    const o = optimistic.get(markKey(i));
    if (!o || o.version !== i.sourceVersion) return i;
    const read = i.state.read || o.read || o.ack;
    const acknowledged = i.state.acknowledged || o.ack;
    return { ...i, state: { read, acknowledged, unread: !read } };
  });
}

/** Непрочитанные карточки оператора — значок; сервер считает и обрезанные. */
export function unreadCount(view: AttentionView, items: readonly AttentionItem[]) {
  const shown = view.items.filter((i) => i.actor === 'operator' && i.state.unread).length;
  const now = items.filter((i) => i.actor === 'operator' && i.state.unread).length;
  return Math.max(0, view.counts.unread - (shown - now));
}

/**
 * Куда перевести фокус, когда карточка исчезла: на ту, что встала на её
 * место (следующую), иначе на предыдущую; `undefined` — список пуст.
 */
export function nextFocusKey(before: readonly string[], after: readonly string[], gone: string) {
  const index = before.indexOf(gone);
  const remaining = new Set(after);
  if (index < 0) return after[0];
  for (let i = index + 1; i < before.length; i++) if (remaining.has(before[i])) return before[i];
  for (let i = index - 1; i >= 0; i--) if (remaining.has(before[i])) return before[i];
  return after[0];
}

/** Группы «Кто действует»: порядок внутри — серверный. */
export function groupByActor<T extends Pick<AttentionItem, 'actor'>>(items: readonly T[]) {
  return {
    operator: items.filter((i) => i.actor === 'operator'),
    lead: items.filter((i) => i.actor === 'lead'),
  };
}

/**
 * Заголовок обзора: сводка сервера без решений, дополненная карточками
 * центра внимания. Прежний порядок: доступ и бюджет, решение по готовому
 * изменению, другие решения оператора, затем «можно попробовать», затем
 * техника ведущего. Пока задач нет, говорит сводка.
 */
export function headlineOf(
  overview: { headline: string; tryNow?: unknown; counts: { tasks: number } },
  items: readonly Pick<AttentionItem, 'actor' | 'category' | 'source'>[],
) {
  if (!overview.counts.tasks) return overview.headline;
  const operator = items.filter((i) => i.actor === 'operator');
  if (operator.some((i) => i.category === 'access' || i.category === 'budget'))
    return 'Работа стоит: нужен внешний доступ или бюджет.';
  if (operator.some((i) => i.source === 'changeset'))
    return 'Нужно ваше решение по готовому изменению.';
  if (operator.length) return 'Нужно ваше решение.';
  if (overview.tryNow) return overview.headline;
  if (items.some((i) => i.actor === 'lead'))
    return 'Работа остановилась на технической проблеме — разбирает ведущий агент.';
  return overview.headline;
}
