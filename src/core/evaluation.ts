import { z } from 'zod';
export const evaluationResult = z.strictObject({
  decision: z.enum(['proceed', 'block', 'refresh']),
  reason: z.string().min(1).max(2000),
  actions: z
    .array(z.strictObject({ operation: z.string().max(80), inputJson: z.string().max(10000) }))
    .max(8),
});
export type EvaluationResult = z.infer<typeof evaluationResult>;
