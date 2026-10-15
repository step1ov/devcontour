import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DevContour, digest } from '../core/service.ts';
import type { DevContourState } from '../core/model.ts';
import { CURRENT_PROCESS, ownerGone } from './live-calls.ts';
import {
  callDurationMs,
  endActive,
  startActive,
  unknownUsage,
  priceUsage,
  usageSchema,
  type Usage,
  type UsageRecord,
} from '../core/usage.ts';
import type { AgentAdapter, AgentRequest } from './adapters.ts';
import { assertBudget, callBudgets, usageRecords } from '../core/budget.ts';
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
const PROCESS = CURRENT_PROCESS;

/**
 * Закрывает записи вызовов, чей процесс умер, исходом `abandoned`. Запись
 * без процесса (до появления учёта процесса) закрывается, когда её попытка
 * уже не активна, а без попытки — спустя два предела времени вызова. Иначе
 * она осталась бы «идущей» навсегда и неотличимой от настоящего вызова.
 */
export function abandonCalls(h: DevContour, at = Date.now()) {
  const s = h.store.read();
  const activeRuns = new Set(s.runs.filter((r) => r.status === 'active').map((r) => r.id));
  const dead = (r: UsageRecord) =>
    r.outcome === 'active' &&
    (r.process
      ? ownerGone(r)
      : r.runId
        ? !activeRuns.has(r.runId)
        : at - Date.parse(r.startedAt) > 2 * h.config.runTimeoutMs);
  const candidates = usageRecords(h).filter(dead);
  if (!candidates.length) return [];
  // Под блокировкой записи запись перечитывается: вызов мог завершиться между
  // сканированием и транзакцией, и его исход и стоимость не затираются
  // устаревшим снимком.
  return h.store.atomic(() => {
    const closed: string[] = [];
    // Каждый владелец перечитывается один раз, а не на каждого кандидата.
    const owners = new Map<string | undefined, Record<string, UsageRecord>>();
    for (const seen of candidates) {
      if (!owners.has(seen.repositoryId))
        owners.set(seen.repositoryId, h.store.localRecords<UsageRecord>('usage', seen.repositoryId));
      const r = owners.get(seen.repositoryId)![seen.id];
      if (!r || !dead(r)) continue;
      // Время прерванного вызова фиксируется монотонно (часы ОС, сохранённый
      // замер), пока запись ещё идущая: откат системных часов его не уменьшает.
      const elapsed = callDurationMs(r, at);
      if (elapsed !== null) r.durationMs = elapsed;
      r.outcome = 'abandoned';
      r.abandonedAt = new Date(at).toISOString();
      h.store.saveLocal('usage', r.repositoryId, r.id, r);
      closed.push(r.id);
    }
    return closed;
  });
}

/**
 * Закрепляет происхождение прежних записей вызовов (без `boardId`): задачу и
 * доску вызова о задаче, задачи доски — у вызова о доске, по текущему графу.
 * Выполняется до того, как синхронизация или планировщик изменят граф, —
 * иначе перенос задачи снял бы или разделил уже учтённый расход доски.
 * Запись перечитывается под блокировкой записи: вызов, завершившийся после
 * чтения, не затирается устаревшим снимком.
 */
export function pinLegacyCalls(h: DevContour) {
  const s = h.store.read();
  // Недостающая атрибуция дозаполняется: и у записей без доски, и у вызовов
  // о доске, записанных с доской, но без задач.
  const unpinned = (r: UsageRecord) => !r.taskIds && (!r.taskId || !r.boardId);
  const legacy = usageRecords(h).filter(unpinned);
  if (!legacy.length) return 0;
  return h.store.atomic(() => {
    let pinned = 0;
    const owners = new Map<string | undefined, Record<string, UsageRecord>>();
    for (const seen of legacy) {
      if (!owners.has(seen.repositoryId))
        owners.set(seen.repositoryId, h.store.localRecords<UsageRecord>('usage', seen.repositoryId));
      const r = owners.get(seen.repositoryId)![seen.id];
      if (!r || !unpinned(r)) continue;
      const subject = callSubject(s, { runId: r.runId, subjectId: r.subjectId ?? r.boardId });
      const board = s.boards.find((b) => b.id === (r.boardId ?? subject.boardId));
      if (!board) continue;
      // Уже закреплённое при вызове не меняется: дозаполняется только недостающее.
      r.boardId ??= board.id;
      if (subject.taskId) r.taskId ??= subject.taskId;
      // У прежнего вызова о доске — все её задачи, а не только открытые.
      if (!r.taskId) r.taskIds = [...new Set(board.revisions.flatMap((x) => x.taskIds))];
      h.store.saveLocal('usage', r.repositoryId, r.id, r);
      pinned++;
    }
    return pinned;
  });
}

/** Задача и доска вызова на момент вызова: за ними остаётся его расход. */
function callSubject(s: DevContourState, meta: { runId?: string; subjectId?: string }) {
  const taskId =
    s.runs.find((r) => r.id === meta.runId)?.taskId ??
    s.tasks.find((t) => t.id === meta.subjectId)?.id;
  const boardId = taskId
    ? s.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(taskId)))?.id
    : s.boards.find((b) => b.id === meta.subjectId)?.id;
  const board = !taskId && boardId ? s.boards.find((b) => b.id === boardId) : undefined;
  const taskIds = board
    ? s.tasks
        .filter(
          (t) =>
            board.revisions.some((r) => r.taskIds.includes(t.id)) &&
            !['done', 'cancelled'].includes(t.status),
        )
        .map((t) => t.id)
    : undefined;
  return {
    ...(taskId ? { taskId } : {}),
    ...(boardId ? { boardId } : {}),
    ...(taskIds ? { taskIds } : {}),
  };
}

export async function measuredExecute(
  h: DevContour,
  adapter: AgentAdapter,
  request: AgentRequest,
  meta: { repositoryId?: string; runId?: string; subjectId?: string; stage: string },
) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const startedHr = process.hrtime.bigint().toString();
  // Тарифы закрепляются на старте вызова: правка цен во время вызова или
  // после него оценку не меняет.
  const tariffs = h.config.prices.map((p) => ({ ...p }));
  const priceFor = (model: string | null | undefined) => {
    const matched = tariffs
      .filter(
        (p) =>
          p.runtime === adapter.name &&
          p.model === model &&
          Date.parse(p.effectiveAt) <= Date.parse(startedAt),
      )
      .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
    return matched ? { ...matched } : undefined;
  };
  // Тариф подбирается только по модели, которую сообщил runtime: запрошенная
  // модель не подтверждает, что работала именно она.
  let price: ReturnType<typeof priceFor>;
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
    process: PROCESS,
    startedHr,
  };
  const save = () =>
    h.store.atomic(() => h.store.saveLocal('usage', meta.repositoryId, record.id, record));
  // До траты, в одной транзакции записи с регистрацией идущего вызова:
  // превышенный или неопределённый бюджет не даёт начать вызов, и два процесса
  // не проходят проверку оба, не видя друг друга.
  h.store.atomic(() => {
    const s = h.store.read();
    Object.assign(record, callSubject(s, meta));
    if (h.config.budgets) assertBudget(h, callBudgets(h, s, meta, usageRecords(h)));
    h.store.saveLocal('usage', meta.repositoryId, record.id, record);
  });
  startActive(record.id);
  // Время идущего вызова сохраняется по ходу: другой процесс не увидит его
  // ниже этого замера при откате часов.
  const progress = setInterval(() => {
    record.elapsedMs = Math.round(performance.now() - started);
    save();
  }, 15_000);
  progress.unref();
  try {
    const result = await adapter.execute({
      ...request,
      onDiagnostics: (diagnostics) => {
        record.diagnostics = diagnostics;
        save();
        request.onDiagnostics?.(diagnostics);
      },
      onUsage: (usage, version, model) => {
        record.usage = usageSchema.parse(usage);
        record.runtimeVersion = version ?? record.runtimeVersion;
        // Модель, которую runtime выбрал сам, а не только запрошенную: иначе
        // в учёте остаётся null, и переход на дорогой вариант не виден.
        record.model = model ?? record.model;
        // Тариф — по модели, которую сообщил runtime: без сообщённой модели или
        // без тарифа на неё стоимость неизвестна.
        price = model ? priceFor(model) : undefined;
        record.price = price;
        Object.assign(record, priceUsage(record.usage, price));
        save();
        request.onUsage?.(usage, version, model);
      },
    });
    record.outcome = 'returned';
    return result;
  } catch (e) {
    record.outcome = 'error';
    throw e;
  } finally {
    record.finishedAt = new Date().toISOString();
    clearInterval(progress);
    record.durationMs = Math.round(performance.now() - started);
    save();
    endActive(record.id);
  }
}
