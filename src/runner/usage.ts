// Разбор телеметрии runtime DevContour (продуктовые CLI-адаптеры планирования
// и оценок). Учёт вызовов и бюджеты — harness (`src/harness/measured.ts`).
import { tmpdir } from 'node:os';
import { unknownUsage, usageSchema, type Usage } from '../core/usage.ts';
import { command } from './process.ts';
import { runtimeEvents } from './runtime-events.ts';
import { z } from 'zod';

const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const tokens = (v: unknown) => (Number.isSafeInteger(v) ? number(v) : null);
// Parse only runtime telemetry, never the model's structured response or its claims about cost.
export function parseUsage(runtime: 'codex' | 'claude', stdout: string, completed: boolean): Usage {
  try {
    if (runtime === 'claude') {
      const stream = runtimeEvents(stdout);
      const result = stream.events.findLast((e) => e.type === 'result');
      if (!result) return unknownUsage();
      const u = z.record(z.string(), z.unknown()).parse(result.usage);
      if (result.type !== 'result' || !u) return unknownUsage();
      const input = tokens(u.input_tokens),
        read = tokens(u.cache_read_input_tokens),
        write = tokens(u.cache_creation_input_tokens);
      return usageSchema.parse({
        inputTokens:
          input !== null && read !== null && write !== null ? input + read + write : null,
        outputTokens: tokens(u.output_tokens),
        cacheReadTokens: read,
        cacheWriteTokens: write,
        reportedUsd: number(result.total_cost_usd),
        complete: completed && !stream.malformed,
        source: 'claude-result',
      });
    }
    const { events, malformed } = runtimeEvents(stdout);
    const turns = events.filter((e) => e.type === 'turn.completed');
    if (!turns.length) return unknownUsage();
    const sum = (key: string) => {
      const values = turns.map((e) =>
        tokens(z.record(z.string(), z.unknown()).parse(e.usage)[key]),
      );
      return values.every((v) => v !== null) ? values.reduce<number>((s, v) => s + v, 0) : null;
    };
    return usageSchema.parse({
      inputTokens: sum('input_tokens'),
      outputTokens: sum('output_tokens'),
      cacheReadTokens: sum('cached_input_tokens'),
      cacheWriteTokens: 0,
      reportedUsd: null,
      complete: completed && !malformed,
      source: 'codex-turn-events',
    });
  } catch {
    return unknownUsage();
  }
}
const versions = new Map<string, Promise<string | null>>();
export function runtimeVersion(runtime: string, env?: NodeJS.ProcessEnv) {
  const key = JSON.stringify([runtime, env?.PATH ?? process.env.PATH]);
  if (!versions.has(key))
    versions.set(
      key,
      runtime === 'demo'
        ? Promise.resolve('fixture')
        : command([runtime, '--version'], tmpdir(), { timeoutMs: 5000, env })
            .then((r) => (r.code ? null : r.stdout.trim().split('\n')[0].slice(0, 200)))
            .catch(() => null),
    );
  return versions.get(key)!;
}
