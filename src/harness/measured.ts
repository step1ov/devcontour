// Продуктовые вызовы модели (планирование, оценки, разбор ведущего) — под
// учётом harness: бюджет проверяется до вызова в одной транзакции с записью
// идущего вызова, тариф и расход считает harness. Здесь только оболочка
// вызова `AgentAdapter` DevContour; собственного учёта у DevContour нет.
import { randomUUID } from 'node:crypto';
import {
  callRecords,
  measuredInvoke,
  TaskFailure,
  type CallMeta,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeTask,
} from 'devcontour-harness';
import type { DevContour } from '../core/service.ts';
import { unknownUsage, type Usage } from '../core/usage.ts';
import type { AgentAdapter, AgentRequest, AgentResult } from '../runner/adapters.ts';
import type { RuntimeDiagnostics } from '../core/runtime-diagnostics.ts';
import { executionOf, toDomain } from './execution.ts';

const taskOf = (request: AgentRequest): RuntimeTask =>
  request.purpose === 'plan' ? 'plan' : request.review ? 'review-plan' : 'implement';

/** Вызов `agent` под учётом и бюджетами harness; отказ бюджета — до вызова. */
export async function measuredAgentCall(
  h: DevContour,
  agent: AgentAdapter,
  request: AgentRequest,
  meta: Omit<CallMeta, 'stage'> & { stage: string },
): Promise<AgentResult> {
  const { engine } = executionOf(h);
  const runtime: RuntimeName = agent.name === 'demo' ? 'fixture' : agent.name;
  let result: AgentResult | undefined;
  // Отказ вызова — тоже вызов: его расход, версия и диагностика процесса
  // остаются в учёте, а исходная ошибка возвращается вызывающему после записи.
  let failure: { error: unknown } | undefined;
  let diagnostics: RuntimeDiagnostics | undefined;
  const callId = randomUUID();
  const adapter: RuntimeAdapter = {
    runtime,
    capabilities: () =>
      Promise.resolve({
        runtime,
        ...(agent.version ? { version: agent.version } : {}),
        structuredOutput: true,
        sandbox: ['none'],
        cancellation: true,
        usage: true,
        fixture: runtime === 'fixture',
      }),
    async invoke(_request, signal) {
      let usage: Usage = unknownUsage();
      let model: string | null = null;
      let version: string | null = agent.version ?? null;
      try {
        result = await agent.execute({
          ...request,
          signal,
          onUsage: (reported, reportedVersion, reportedModel) => {
            usage = reported;
            version = reportedVersion ?? version;
            model = reportedModel ?? model;
            request.onUsage?.(reported, reportedVersion, reportedModel);
          },
          onDiagnostics: (reported) => {
            diagnostics = reported;
            request.onDiagnostics?.(reported);
          },
        });
      } catch (error) {
        failure = { error };
        return {
          status: signal.aborted ? 'cancelled' : 'failed',
          output: null,
          model,
          runtimeVersion: version,
          text: '',
          usage,
          diagnostics: { exitCode: diagnostics?.exitCode ?? null },
        };
      }
      return {
        status: 'ok',
        output: result.data,
        model,
        runtimeVersion: version,
        text: result.log,
        usage,
        diagnostics: { exitCode: 0 },
        ...(result.inspection ? { inspection: result.inspection } : {}),
      };
    },
  };
  try {
    await measuredInvoke(
      engine,
      adapter,
      {
        callId,
        task: taskOf(request),
        binding: {
          runtime,
          ...(request.model ? { model: request.model } : {}),
        },
        cwd: request.cwd,
        prompt: request.prompt,
        outputSchema: {},
        session: { kind: 'fresh' },
        sandbox: {
          mode: 'none',
          writable: [],
          denied: [],
          readable: [request.cwd],
          network: { domains: [] },
        },
        timeoutMs: request.timeoutMs,
        env: {},
        artifactDir: request.artifactDir,
      },
      request.signal,
      meta,
    );
  } catch (error) {
    // Отказ бюджета — тот же класс отказа, что и раньше (`budget`).
    if (error instanceof TaskFailure) throw error;
    throw toDomain(error);
  } finally {
    // Диагностика процесса (хвосты потоков, код, таймаут) — в записи вызова,
    // как и прежде; harness её формы от адаптера не получает.
    if (diagnostics) {
      const record = engine.read((v) => callRecords(v).find((r) => r.id === callId));
      if (record) engine.saveCall({ ...record, diagnostics });
    }
  }
  if (failure) throw failure.error;
  return result!;
}
