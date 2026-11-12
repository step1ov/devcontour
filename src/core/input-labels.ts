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

/**
 * Как попытка связана с вопросом исполнителя. Остановка вопросом возвращает
 * номер попытки, и продолжение после ответа идёт с тем же номером: без
 * пометки «попытка 2 из 3» дважды читалась как повтор. Остановленная попытка
 * — `failureKind: needs-input`, продолжение — выдана с ответом (`input`).
 * Остановка сверх предела вопросов (`counted`, см. `questionStops`) попытку
 * не вернула — пометка это называет.
 */
export function attemptInputNote(run: {
  failureKind?: string;
  input?: { requestId: string };
  counted?: boolean;
}): string | undefined {
  const counted = run.counted ? ' · засчитана: предел вопросов исчерпан' : '';
  if (run.input)
    return (
      'продолжение после ответа на вопрос' +
      (run.failureKind === 'needs-input' ? ' · снова остановлена вопросом' + counted : '')
    );
  if (run.failureKind === 'needs-input') return 'остановлена вопросом исполнителя' + counted;
  return undefined;
}

/** С какого числа остановок вопросом по задаче оператор и ведущий видят сигнал. */
export const REPEATED_QUESTION_STOPS = 2;

/**
 * Остановки вопросом исполнителя по задаче — правило движка harness
 * (0.1.0-alpha.38): первые `maxAttempts` остановок возвращают попытку,
 * каждая следующая засчитывается в предел попыток. Прерванные штатной
 * остановкой не считаются. `runs` — попытки одной задачи в порядке начала.
 *
 * `count`, `limit` и `exhausted` смотрят вперёд и считаются по текущему
 * `maxAttempts`. `counted` — история: засчитана ли остановка, движок решил
 * в момент остановки с тогдашним пределом и записал вердикт в журнал
 * (`attempt.diagnosed`, поле `counted`). Поэтому вердикт берётся из
 * `verdicts` (ID попытки → `counted`, см. `questionVerdicts`), и смена
 * `maxAttempts` позже его не переписывает. Порядок попыток выводит вердикт
 * только для попыток без такого события (журнал до 0.1.0-alpha.38: движок
 * тогда засчитывал каждую остановку, по попыткам это не различить).
 */
export function questionStops(
  runs: readonly { id: string; failureKind?: string; interrupted?: string }[],
  maxAttempts: number,
  verdicts?: ReadonlyMap<string, boolean>,
) {
  const stops = runs.filter((r) => r.failureKind === 'needs-input' && r.interrupted !== 'shutdown');
  return {
    count: stops.length,
    limit: maxAttempts,
    /** Свободные остановки израсходованы: следующая засчитывается в попытки. */
    exhausted: stops.length >= maxAttempts,
    counted: new Set(
      stops.filter((r, i) => verdicts?.get(r.id) ?? i >= maxAttempts).map((r) => r.id),
    ),
  };
}

/** Строка о повторных остановках вопросом словами оператора. */
export function repeatedQuestionText(q: { count: number; limit: number; exhausted: boolean }) {
  return (
    `Исполнитель останавливался вопросом по этой задаче ${q.count} раз(а); ` +
    (q.exhausted
      ? `без расхода попыток — только первые ${q.limit}, следующие засчитываются в попытки. Если вопросы повторяются, уточните постановку задачи.`
      : `без расхода попыток — первые ${q.limit}.`)
  );
}

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
  /** Текущее предложение ответа ведущего ждёт оператора (F37). */
  proposal?: unknown;
}): string {
  if (r.kind === 'follow-up')
    return 'ведущий агент принимает решение исполнителя или заменяет вопрос новой постановкой';
  switch (r.state) {
    case 'awaiting-answer':
      return r.actor === 'operator'
        ? r.proposal
          ? 'подтвердите ответ ведущего или ответьте иначе в карточке задачи'
          : 'ответьте на вопрос в карточке задачи'
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
        ? (r.proposal
            ? 'прочитайте находки ревью и подтвердите исправление ведущего или исправьте ответ сами'
            : 'прочитайте находки ревью и исправьте ответ') +
            (r.operatorMode ? ' или примените его с подтверждением' : '')
        : 'ведущий агент читает находки ревью и исправляет ответ или постановку задачи';
    case 'applied-awaiting-claim':
      return 'ответ применён, задача ждёт новой попытки';
    default:
      return '';
  }
}
