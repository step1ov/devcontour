import { z } from 'zod';
import { unobservedReview, type ReviewInspection } from '../core/review.ts';

const completedCommand = z.object({
  type: z.literal('item.completed'),
  item: z.object({
    type: z.literal('command_execution'),
    command: z.string().min(1).max(12000),
    exit_code: z.number().int(),
    aggregated_output: z.string().default(''),
    status: z.enum(['completed', 'failed']),
  }),
});
export function inspectReview(runtime: string, output: string): ReviewInspection {
  if (runtime !== 'codex') return unobservedReview();
  const commands: ReviewInspection['commands'] = [];
  for (const line of output.split('\n')) {
    try {
      const event = completedCommand.safeParse(JSON.parse(line));
      if (event.success) {
        const item = event.data.item;
        commands.push({
          command: item.command,
          exitCode: item.exit_code,
          output: item.aggregated_output.slice(-4000),
        });
      }
    } catch {
      /* Truncated/non-JSON lines cannot assert command execution. */
    }
  }
  const observed = commands.some((c) => c.exitCode === 0);
  return {
    mode: observed ? 'commands' : 'diff-only',
    source: 'codex-events',
    commands: commands.slice(-100),
    reason: observed ? null : 'Нет подтверждённой успешной команды в событиях Codex.',
  };
}
