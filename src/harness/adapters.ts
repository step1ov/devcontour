// Runtime исполнения DevContour для runner harness.
//
// Живые codex и claude — адаптеры CLI пакета harness. Продуктовое демо и
// runtime, которые передают тесты и оценки DevContour (`AgentAdapter`),
// подключаются оболочкой: она находит задачу вызова по его предмету и
// переводит ответ в форму harness. Правил приёмки в оболочке нет — ответ
// разбирает и проверяет runner.
import {
  HarnessError,
  cliAdapter,
  type ExecutionPolicy,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeRequest,
  type RuntimeResponse,
} from 'devcontour-harness';
import { adapters, type AgentAdapter } from '../runner/adapters.ts';
import { redactor } from '../runner/redaction.ts';
import { unknownUsage, type Usage } from '../core/usage.ts';
import type { DevContour } from '../core/service.ts';
import type { Task } from '../core/model.ts';

/** Runtime DevContour (`demo`) — fixture harness. */
const hostName = (runtime: RuntimeName) => (runtime === 'fixture' ? 'demo' : runtime);

/**
 * Оболочка `AgentAdapter` DevContour: тот же вызов с задачей DevContour,
 * ответ — сырой структурированный вывод для runner.
 */
export function fromAgentAdapter(
  h: DevContour,
  agent: AgentAdapter,
  runtime: RuntimeName,
): RuntimeAdapter {
  return {
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
    async invoke(request: RuntimeRequest, signal: AbortSignal): Promise<RuntimeResponse> {
      const workId = request.subject?.workId;
      const task = h.store.read().tasks.find((t) => t.id === workId);
      // Ревью плана и контракта идёт не о задаче — как и прежде, с пустой задачей.
      const subjectless = request.task === 'review-plan' || request.task === 'review-contract';
      if (!task && !subjectless)
        throw new HarnessError('NOT_FOUND', `Задача вызова ${request.callId} не найдена`);
      let usage: Usage = unknownUsage();
      let model: string | null = null;
      let runtimeVersion: string | null = agent.version ?? null;
      const result = await agent.execute({
        cwd: request.cwd,
        artifactDir: request.artifactDir ?? request.cwd,
        prompt: request.prompt,
        review: request.task !== 'implement',
        // Разбор ведущего по свойству — свой вид вызова продукта.
        ...(request.subject?.phase === 'property-recovery' ? { purpose: 'recovery' as const } : {}),
        task: task ?? ({} as Task),
        ...(request.binding.model ? { model: request.binding.model } : {}),
        ...(request.binding.effort ? { effort: request.binding.effort } : {}),
        signal,
        timeoutMs: request.timeoutMs,
        execution: { env: request.env, redact: redactor(request.secrets ?? []) },
        ...(request.env.DEVCONTOUR_RESOURCES_JSON
          ? { resourcesJson: request.env.DEVCONTOUR_RESOURCES_JSON }
          : {}),
        onUsage: (reported, version, reportedModel) => {
          usage = reported;
          runtimeVersion = version ?? runtimeVersion;
          model = reportedModel ?? model;
        },
      });
      return {
        status: 'ok',
        output: result.data,
        model,
        runtimeVersion,
        text: result.log,
        usage,
        diagnostics: { exitCode: 0 },
        ...(result.inspection ? { inspection: result.inspection } : {}),
      };
    },
  };
}

/**
 * Runtime исполнения: живые CLI — адаптеры harness с профилями политики;
 * переданные хостом `runtimes` (демо, тестовые) — оболочкой.
 */
export function runtimeAdapters(
  h: DevContour,
  policy: ExecutionPolicy,
  runtimes: Record<string, AgentAdapter> = adapters,
): Partial<Record<RuntimeName, RuntimeAdapter>> {
  const out: Partial<Record<RuntimeName, RuntimeAdapter>> = {};
  for (const runtime of ['codex', 'claude', 'fixture'] as const) {
    const agent = runtimes[hostName(runtime)];
    if (!agent) continue;
    out[runtime] =
      agent === adapters[hostName(runtime)] && runtime !== 'fixture'
        ? cliAdapter(runtime, { toolProfiles: policy.toolProfiles })
        : fromAgentAdapter(h, agent, runtime);
  }
  return out;
}
