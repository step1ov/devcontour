// Состояние вопроса исполнителя словами оператора — по порядку плана:
// «Нужен ответ» → «Ответ сохранён» (нужна подготовка и проверка контекста) →
// проверка → «Передано в новую попытку». «Передано» — только после начала
// вызова исполнителя с ответом (`delivered`), а не после применения;
// «агент прочитал» панель не утверждает. Отклонённое ревью — своё состояние.
export const inputStateLabels: Record<string, string> = {
  'awaiting-answer': 'Нужен ответ',
  'answer-saved': 'Ответ сохранён — нужна подготовка и проверка контекста',
  'context-review': 'Контекст проверен, применить пока нельзя',
  'review-rejected': 'Ревью отклонило ответ',
  'ready-to-apply': 'Контекст с ответом проверен',
  'applied-awaiting-claim': 'Ответ применён, ждёт попытки',
  delivered: 'Передано в новую попытку',
  stale: 'Ответ устарел: нужен новый контекст',
  cancelled: 'Вопрос снят',
  superseded: 'Вопрос заменён',
};

/** Порядок состояний основного пути: подписи следуют ему. */
export const inputStateOrder = [
  'awaiting-answer',
  'answer-saved',
  'ready-to-apply',
  'applied-awaiting-claim',
  'delivered',
] as const;

/**
 * Задачу держит вопрос исполнителя: среди блокеров есть `input:<requestId>`.
 * Только тогда повтор скрыт (продолжение — ответ); снятый вопрос оставляет
 * обычную упавшую задачу, которую можно повторить.
 */
export const heldByInput = (task: { blockers?: readonly string[] }) =>
  (task.blockers ?? []).some((id) => id.startsWith('input:'));

/**
 * Следующий шаг по вопросу исполнителя словами оператора. Поле `next` сводки
 * запроса — указание ведущему агенту (операции агентского API, по-английски);
 * панель и центр внимания показывают этот текст.
 */
export function inputNextText(r: {
  state: string;
  actor: 'operator' | 'lead';
  kind?: string;
  operatorMode?: boolean;
}): string {
  if (r.kind === 'follow-up')
    return 'ведущий агент принимает решение исполнителя или заменяет вопрос новой постановкой';
  switch (r.state) {
    case 'awaiting-answer':
      return r.actor === 'operator'
        ? 'ответьте на вопрос в карточке задачи'
        : 'ответит ведущий агент; ответить можно и в карточке задачи';
    case 'answer-saved':
      return 'ведущий агент готовит контекст с ответом, проводит его ревью и применяет ответ';
    case 'stale':
      return 'ведущий агент заново готовит контекст с ответом и применяет его';
    case 'context-review':
    case 'ready-to-apply':
      return r.actor === 'operator' ? 'примените ответ' : 'ведущий агент применяет ответ';
    case 'review-rejected':
      return r.actor === 'operator'
        ? 'прочитайте находки ревью и исправьте ответ' +
            (r.operatorMode ? ' или примените его с подтверждением' : '')
        : 'ведущий агент читает находки ревью и исправляет ответ или постановку задачи';
    case 'applied-awaiting-claim':
      return 'ответ применён, задача ждёт новой попытки';
    default:
      return '';
  }
}
