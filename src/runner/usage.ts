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
// Какую модель runtime выбрал на самом деле. Записывалась запрошенная, а при
// незакреплённой модели — null: оператор не мог увидеть, что прогон ушёл на
// длинноконтекстный вариант, который подпиской не покрыт и требует кредитов.
// Имя приходит от самого runtime: у claude — в событии system, у codex — в
// ключах modelUsage.
export function eventModel(event: Record<string, unknown>): string | undefined {
  if (typeof event.model === 'string' && event.model && event.model !== '<synthetic>')
    return event.model;
  const usage = event.modelUsage as Record<string, unknown> | undefined;
  return Object.keys(usage ?? {})[0];
}
/** Строка потока длиннее — не разбирается и делает телеметрию неполной. */
const LINE_LIMIT = 64_000_000;
/**
 * Телеметрия, собранная по ходу потока runtime, а не из хвоста вывода. Хвост
 * stdout и runtime.log ограничены, и у долгого вызова итоговое событие
 * `result` (стоимость и счётчики claude) или ранние `turn.completed` codex
 * оказывались за пределом: стоимость, сообщённая провайдером, терялась или
 * учитывалась неполной. Каждая строка разбирается сразу; хранятся только поля
 * телеметрии — последнее `result`, события `turn.completed` и первая
 * сообщённая модель, — а не текст вывода.
 */
export function usageStream(runtime: 'codex' | 'claude') {
  let partial = '',
    overflow = false,
    malformed = false,
    model: string | undefined,
    result: string | undefined;
  const turns: string[] = [];
  const line = (text: string) => {
    if (!text.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      malformed = true;
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      malformed = true;
      return;
    }
    const e = event as Record<string, unknown>;
    model ??= eventModel(e);
    if (runtime === 'claude' && e.type === 'result')
      result = JSON.stringify({ type: e.type, usage: e.usage, total_cost_usd: e.total_cost_usd });
    if (runtime === 'codex' && e.type === 'turn.completed')
      turns.push(JSON.stringify({ type: e.type, usage: e.usage }));
  };
  const flush = () => {
    if (overflow) malformed = true;
    else line(partial);
    partial = '';
    overflow = false;
  };
  return {
    /** Очередной фрагмент stdout runtime. */
    push(text: string) {
      let start = 0;
      for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', start)) {
        if (!overflow) partial += text.slice(start, end);
        flush();
        start = end + 1;
      }
      if (overflow) return;
      partial += text.slice(start);
      if (partial.length > LINE_LIMIT) {
        partial = '';
        overflow = true;
      }
    },
    /** Телеметрия всего потока; `completed` — вызов завершился штатно. */
    usage(completed: boolean): Usage {
      flush();
      return parseUsage(
        runtime,
        [...turns, ...(result ? [result] : [])].join('\n'),
        completed && !malformed,
      );
    },
    model: () => model,
  };
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
