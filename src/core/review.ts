import { z } from 'zod';

export const reviewExecution = z.strictObject({
  commands: z
    .array(
      z.strictObject({
        command: z.string().min(1).max(12000),
        exitCode: z.number().int(),
        summary: z.string().min(1).max(4000),
      }),
    )
    .max(100),
  noCommandsReason: z.string().min(1).max(4000).nullable(),
});
export function validateExecution(value: unknown) {
  const result = reviewExecution.parse(value);
  if (Boolean(result.commands.length) === Boolean(result.noCommandsReason))
    throw new Error('Укажите выполненные команды либо причину их отсутствия');
  return result;
}
export interface ReviewInspection {
  mode: 'commands' | 'diff-only';
  source: 'codex-events' | 'unavailable';
  commands: { command: string; exitCode: number; output: string }[];
  reason: string | null;
}
export const unobservedReview = (): ReviewInspection => ({
  mode: 'diff-only',
  source: 'unavailable',
  commands: [],
  reason: 'Runtime не предоставил подтверждение выполненных команд.',
});
