import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Отчёт генеративной проверки: эталон, генератор, свойства и уменьшение входа
 * живут в проекте, а контур задаёт seed, читает отчёт при любом исходе и
 * сохраняет его как доказательство.
 *
 * Приёмка из отдельных точек проверяла примеры, а не обещание: контрпример
 * находил ревьюер после полной попытки, и решение подгонялось под точки.
 * Генеративная проверка находит его сама, а seed контура делает отказ
 * воспроизводимым — даже если проверка зависла и ничего не успела записать.
 */
const value = z.unknown();
export const propertyReport = z.object({
  version: z.literal(1),
  properties: z
    .array(
      z.object({
        /** Стабильный id свойства — тот же, что testcase в JUnit и критерий приёмки. */
        testId: z.string().min(1).max(200),
        /**
         * `running` — проверка оборвалась на этом свойстве (таймаут): `current`
         * называет вход, на котором она шла.
         */
        status: z.enum(['passed', 'failed', 'running']),
        cases: z.number().int().min(0),
        current: value.optional(),
        counterexample: z
          .object({
            original: value,
            reduced: value.optional(),
            expected: value.optional(),
            actual: value.optional(),
            /** Уменьшение не уложилось в свой предел — сохранён исходный вход. */
            reductionTimedOut: z.boolean().optional(),
          })
          .optional(),
      }),
    )
    .max(100),
});
export type PropertyReport = z.infer<typeof propertyReport>;

/** Seed контура: свой у каждой попытки, фазы и гейта, но воспроизводимый. */
export function propertySeed(runId: string, phase: string, gateId: string) {
  return createHash('sha256').update(`${runId}:${phase}:${gateId}`).digest().readUInt32BE(0);
}

const brief = (v: unknown) => {
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 400 ? text.slice(0, 400) + '…' : text;
};

/** Строка для итога гейта: её видит следующая попытка в истории отказов. */
export function propertyFailure(report: PropertyReport) {
  return report.properties
    .filter((p) => p.status !== 'passed')
    .map((p) =>
      p.status === 'running'
        ? `свойство ${p.testId} не завершилось на входе ${brief(p.current)}`
        : `свойство ${p.testId} нарушено на ${brief(p.counterexample?.reduced ?? p.counterexample?.original)}` +
          (p.counterexample && 'expected' in p.counterexample
            ? `: ожидалось ${brief(p.counterexample.expected)}, получено ${brief(p.counterexample.actual)}`
            : ''),
    )
    .join('; ');
}
