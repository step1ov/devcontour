import type { InputQuestion } from 'devcontour-harness';
import type { Run } from '../core/model.ts';
import { DIAGNOSTIC, short } from './bounded.ts';

const text = (value: string) => short(value, DIAGNOSTIC) ?? '';

/** Сколько решений исполнителя показывает одна попытка (предел harness тот же). */
const LIMIT = 20;

/**
 * Решения, которые исполнитель принял сам ниже порога `inputPolicy`
 * (`assumptions` попытки, записывает движок): вопрос, выбор, основание,
 * самооценка и действующая серьёзность с минимумами. Без них оператор видит
 * результат попытки, но не развилки, на которых он построен. Тексты —
 * сокращённые, порядок — как записал движок.
 */
export function assumptionLines(
  run: Pick<Run, 'assumptions' | 'inputPolicy'> & Partial<Pick<Run, 'failureKind'>>,
  /** Вопрос блокирующего запроса этой попытки (`stopQuestions`), если он есть. */
  asked?: InputQuestion,
) {
  // Развилка не ниже порога, закреплённого в попытке, — не решение «без
  // остановки». Движок делает вопросом самую серьёзную из них (действующая
  // серьёзность, затем самооценка, затем порядок записи), только когда
  // исполнитель завершил работу; запрос копирует развилку дословно (вопрос,
  // единственный вариант — выбранное, основание). Такую развилку блок
  // решений не показывает — она видна карточкой вопроса. Если исполнитель
  // спросил сам (незавершённая попытка с запросом), вопрос — его запрос, а
  // развилки движок только записывает: ни одна не скрыта. Поэтому скрывается
  // лишь развилка, совпавшая с вопросом запроса попытки; нет совпадения —
  // не скрывается ничего. Остальные развилки не ниже порога у попытки,
  // остановленной вопросом, помечены `unresolved`: исполнитель их не решил,
  // и без пометки их не было бы видно нигде. У попыток, не остановленных
  // вопросом, движок развилки не оценивал — пометки нет. У попыток без
  // закреплённой политики (прежние версии) порога нет — показываются все
  // записи как решения.
  const threshold = run.inputPolicy?.threshold;
  const all = run.assumptions ?? [];
  const stopped = run.failureKind === 'needs-input';
  const above = (a: (typeof all)[number]) =>
    stopped && threshold !== undefined && a.effectiveSeverity >= threshold;
  const isQuestion = (a: (typeof all)[number]) =>
    !!asked &&
    asked.question === a.question &&
    asked.rationale === a.rationale &&
    asked.options.length === 1 &&
    asked.options[0].label === a.chosen;
  const hidden = all
    .filter((a) => above(a) && isQuestion(a))
    .reduce<(typeof all)[number] | undefined>(
      (top, a) =>
        !top ||
        a.effectiveSeverity > top.effectiveSeverity ||
        (a.effectiveSeverity === top.effectiveSeverity && a.severity > top.severity)
          ? a
          : top,
      undefined,
    );
  return all
    .filter((a) => a !== hidden)
    .slice(0, LIMIT)
    .map((a) => ({
      question: text(a.question),
      chosen: text(a.chosen),
      rationale: text(a.rationale),
      severity: a.severity,
      effectiveSeverity: a.effectiveSeverity,
      floors: [...a.floors],
      affects: [...a.affects],
      ...(above(a) ? { unresolved: true as const } : {}),
    }));
}
export type AssumptionLine = ReturnType<typeof assumptionLines>[number];
