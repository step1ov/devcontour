import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DevContour, digest } from '../core/service.ts';
import {
  unknownUsage,
  priceUsage,
  usageSchema,
  type Usage,
  type UsageRecord,
} from '../core/usage.ts';
import type { AgentAdapter, AgentRequest } from './adapters.ts';
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
export async function measuredExecute(
  h: DevContour,
  adapter: AgentAdapter,
  request: AgentRequest,
  meta: { repositoryId?: string; runId?: string; subjectId?: string; stage: string },
) {
  const startedAt = new Date().toISOString();
  const matchedPrice = h.config.prices
    .filter(
      (p) =>
        p.runtime === adapter.name &&
        p.model === request.model &&
        Date.parse(p.effectiveAt) <= Date.parse(startedAt),
    )
    .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
  const price = matchedPrice ? { ...matchedPrice } : undefined;
  const record: UsageRecord = {
    ...meta,
    id: randomUUID(),
    runtime: adapter.name,
    model: request.model ?? null,
    runtimeVersion: adapter.version ?? null,
    startedAt,
    outcome: 'active',
    promptBytes: Buffer.byteLength(request.prompt),
    promptDigest: digest(request.prompt),
    usage: unknownUsage(),
    costUsd: null,
    costSource: 'unknown',
    price,
  };
  const save = () =>
    h.store.atomic(() => h.store.saveLocal('usage', meta.repositoryId, record.id, record));
  save();
  try {
    const result = await adapter.execute({
      ...request,
      onDiagnostics: (diagnostics) => {
        record.diagnostics = diagnostics;
        save();
        request.onDiagnostics?.(diagnostics);
      },
      onUsage: (usage, version) => {
        record.usage = usageSchema.parse(usage);
        record.runtimeVersion = version ?? record.runtimeVersion;
        Object.assign(record, priceUsage(record.usage, price));
        save();
        request.onUsage?.(usage, version);
      },
    });
    record.outcome = 'returned';
    return result;
  } catch (e) {
    record.outcome = 'error';
    throw e;
  } finally {
    record.finishedAt = new Date().toISOString();
    save();
  }
}
