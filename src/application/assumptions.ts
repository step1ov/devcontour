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
export function assumptionLines(run: Pick<Run, 'assumptions' | 'inputPolicy'>) {
  // Развилка не ниже порога, закреплённого в попытке, — это вопрос, которым
  // попытка остановилась, а не решение «без остановки». Движок пишет её в
  // `assumptions` остановленной попытки тоже; блок решений её не показывает —
  // она видна карточкой вопроса. У попыток без закреплённой политики
  // (прежние версии) порога нет — показываются все записи.
  const threshold = run.inputPolicy?.threshold;
  return (run.assumptions ?? [])
    .filter((a) => threshold === undefined || a.effectiveSeverity < threshold)
    .slice(0, LIMIT)
    .map((a) => ({
      question: text(a.question),
      chosen: text(a.chosen),
      rationale: text(a.rationale),
      severity: a.severity,
      effectiveSeverity: a.effectiveSeverity,
      floors: [...a.floors],
      affects: [...a.affects],
    }));
}
export type AssumptionLine = ReturnType<typeof assumptionLines>[number];
