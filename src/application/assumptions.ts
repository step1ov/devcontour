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
) {
  // Развилка не ниже порога, закреплённого в попытке, — не решение «без
  // остановки». Если попытка остановилась вопросом, движок делает вопросом
  // самую серьёзную из них (действующая серьёзность, затем самооценка, затем
  // порядок записи); её блок решений не показывает — она видна карточкой
  // вопроса. Остальные развилки не ниже порога остаются в списке с пометкой
  // `unresolved`: исполнитель их не решил, и без пометки их не было бы видно
  // нигде. Вопрос, заданный отдельным запросом, а не развилкой, в
  // `assumptions` не пишется; тогда под это правило попадает самая серьёзная
  // развилка — её тоже видно карточкой вопроса, где исполнитель спросил.
  // У попыток без закреплённой политики (прежние версии) порога нет —
  // показываются все записи как решения.
  const threshold = run.inputPolicy?.threshold;
  const all = run.assumptions ?? [];
  const above = (a: (typeof all)[number]) =>
    threshold !== undefined && a.effectiveSeverity >= threshold;
  const asked =
    run.failureKind === 'needs-input'
      ? all
          .filter(above)
          .reduce<(typeof all)[number] | undefined>(
            (top, a) =>
              !top ||
              a.effectiveSeverity > top.effectiveSeverity ||
              (a.effectiveSeverity === top.effectiveSeverity && a.severity > top.severity)
                ? a
                : top,
            undefined,
          )
      : undefined;
  return all
    .filter((a) => a !== asked)
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
