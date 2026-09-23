import { parseUsage, runtimeVersion } from './usage.ts';
import type { Usage } from '../core/usage.ts';
import { evaluationResult } from '../core/evaluation.ts';
import type { ToolProfile } from '../core/integrations.ts';
import { codexTools, claudeMcp, claudeRules } from './tools.ts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { reviewExecution, validateExecution, type ReviewInspection } from '../core/review.ts';
import { inspectReview } from './review.ts';
import { runtimeEvents, claudeResult } from './runtime-events.ts';
import { appendFileSync } from 'node:fs';
import type { Redactor } from './redaction.ts';
import type { RuntimeDiagnostics } from '../core/runtime-diagnostics.ts';
import { planResult, planSchema } from '../core/plan.ts';
import { command } from './process.ts';
import { BlockedError, discoveryInput, type RuntimeName, type Task } from '../core/model.ts';
export const implementationResult = z.object({
  completed: z.boolean(),
  summary: z.string(),
  discoveries: z.array(discoveryInput).max(20).default([]),
});
// Отказ runtime объясняет сам runtime: «Not logged in», исчерпанный лимит,
// недоступная модель. Код выхода про это не говорит ничего, поэтому короткую
// причину достаём из его собственного вывода и кладём рядом с кодом.
function runtimeReason(
  name: string,
  stdout: string,
  stderr: string,
  redact?: (value: string) => string,
): string | undefined {
  let reason: string | undefined;
  if (name === 'claude') {
    const last = runtimeEvents(stdout).events.findLast((e) => e.type === 'result') as
      | { result?: unknown }
      | undefined;
    if (typeof last?.result === 'string') reason = last.result;
  }
  reason ??= stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!reason) return undefined;
  const cleaned = (redact ? redact(reason) : reason).slice(0, 300);
  return `: ${cleaned}`;
}

export const reviewResult = z.object({
  execution: reviewExecution.optional(),
  approved: z.boolean(),
  summary: z.string(),
  discoveries: z.array(discoveryInput).max(20).default([]),
  findings: z.array(
    z.object({
      severity: z.enum(['blocking', 'note']),
      message: z.string(),
      path: z.string().nullable().optional(),
      line: z.number().int().positive().nullable().optional(),
      rule: z.string().nullable().optional(),
      consequence: z.string().nullable().optional(),
      evidence: z.string().nullable().optional(),
    }),
  ),
});
const implementationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    completed: { type: 'boolean' },
    summary: { type: 'string' },
    discoveries: {
      type: 'array',
      maxItems: 20,
      items: z.toJSONSchema(discoveryInput, { target: 'draft-7' }),
    },
  },
  required: ['completed', 'summary', 'discoveries'],
};
const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    execution: z.toJSONSchema(reviewExecution, { target: 'draft-7' }),
    approved: { type: 'boolean' },
    summary: { type: 'string' },
    discoveries: {
      type: 'array',
      maxItems: 20,
      items: z.toJSONSchema(discoveryInput, { target: 'draft-7' }),
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocking', 'note'] },
          message: { type: 'string' },
          path: { type: ['string', 'null'] },
          line: { type: ['integer', 'null'], minimum: 1 },
          rule: { type: ['string', 'null'] },
          consequence: { type: ['string', 'null'] },
          evidence: { type: ['string', 'null'] },
        },
        required: ['severity', 'message', 'path', 'line', 'rule', 'consequence', 'evidence'],
      },
    },
  },
  required: ['approved', 'summary', 'findings', 'discoveries', 'execution'],
};
export interface AgentRequest {
  onDiagnostics?: (diagnostics: RuntimeDiagnostics) => void;
  onUsage?: (usage: Usage, runtimeVersion?: string | null) => void;
  purpose?: 'plan' | 'evaluation';
  toolProfile?: ToolProfile;
  execution?: { env: NodeJS.ProcessEnv; redact: Redactor };
  mcpConfigPath?: string;
  cwd: string;
  artifactDir: string;
  prompt: string;
  review: boolean;
  task: Task;
  model?: string;
  resourcesJson?: string;
  signal: AbortSignal;
  timeoutMs: number;
}
export interface AgentResult {
  inspection?: ReviewInspection;
  data: unknown;
  log: string;
  command: string[];
}
export interface AgentAdapter {
  version?: string;
  name: RuntimeName;
  execute(request: AgentRequest): Promise<AgentResult>;
}
export function cliArguments(
  runtime: 'claude' | 'codex',
  r: AgentRequest,
  schemaPath: string,
  resultPath: string,
): string[] {
  const schema =
    r.purpose === 'evaluation'
      ? z.toJSONSchema(evaluationResult, { target: 'draft-7' })
      : r.purpose === 'plan'
        ? planSchema
        : r.review
          ? reviewSchema
          : implementationSchema;
  if (runtime === 'codex')
    return [
      'codex',
      'exec',
      '--json',
      '--sandbox',
      r.review ? 'read-only' : 'workspace-write',
      '-c',
      'approval_policy="never"',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      resultPath,
      ...(r.model ? ['--model', r.model] : []),
      // Без объявленного профиля инструментов codex брал глобальную
      // конфигурацию оператора вместе с её MCP-серверами. Чужой сервер,
      // который не смог авторизоваться, убивал прогон на стадии ревью —
      // работа была сделана и проверена, а результат терялся из-за сервера,
      // к контуру отношения не имеющего. Прогон начинается с пустого набора.
      ...(r.toolProfile ? codexTools(r.toolProfile) : ['--ignore-user-config', '-c', 'mcp_servers={}']),
      '-',
    ];
  return [
    'claude',
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(schema),
    '--permission-mode',
    r.review ? 'dontAsk' : 'acceptEdits',
    '--tools',
    (r.review
      ? ['Read', 'Glob', 'Grep']
      : (r.toolProfile?.claudeTools ?? ['Read', 'Glob', 'Grep', 'Edit', 'Write'])
    ).join(','),
    ...(r.review ? ['--disallowedTools', 'Bash,Edit,Write,NotebookEdit'] : []),
    ...(r.toolProfile
      ? [
          '--allowedTools',
          claudeRules(r.toolProfile)
            .filter((rule) => !r.review || !rule.startsWith('Bash'))
            .join(','),
        ]
      : []),
    ...(r.mcpConfigPath ? ['--mcp-config', r.mcpConfigPath] : []),
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    ...(r.model ? ['--model', r.model] : []),
  ];
}
export function cliAdapter(name: 'codex' | 'claude'): AgentAdapter {
  return {
    name,
    async execute(r) {
      await mkdir(r.artifactDir, { recursive: true });
      const schemaPath = join(r.artifactDir, 'schema.json'),
        resultPath = join(r.artifactDir, 'result.json');
      await writeFile(
        schemaPath,
        JSON.stringify(
          r.purpose === 'evaluation'
            ? z.toJSONSchema(evaluationResult, { target: 'draft-7' })
            : r.purpose === 'plan'
              ? planSchema
              : r.review
                ? reviewSchema
                : implementationSchema,
        ),
      );
      if (name === 'claude' && r.toolProfile) {
        r.mcpConfigPath = join(r.artifactDir, 'mcp.json');
        await writeFile(r.mcpConfigPath, JSON.stringify(claudeMcp(r.toolProfile), null, 2));
      }
      const argv = cliArguments(name, r, schemaPath, resultPath);
      // Отсутствующий или незапускаемый исполняемый файл — тоже отказ
      // окружения, хотя он приходит обычной ошибкой запуска, а не кодом
      // выхода. Без этого «команда не найдена» тратила попытку задачи.
      const blockedStart = (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
      };
      const version = await runtimeVersion(name, r.execution?.env);
      const logPath = join(r.artifactDir, 'runtime.log');
      await writeFile(logPath, `Runtime ${name}; started ${new Date().toISOString()}\n`);
      let loggedBytes = 0;
      const result = await command(argv, r.cwd, {
        onOutput: (stream, text) => {
          // Keep live logs bounded; final diagnostics retain both stream tails.
          if (loggedBytes >= 10_000_000) return;
          const entry = `[${new Date().toISOString()} ${stream}] ${text}`;
          appendFileSync(logPath, entry);
          loggedBytes += Buffer.byteLength(entry);
        },
        signal: r.signal,
        timeoutMs: r.timeoutMs,
        input:
          r.prompt +
          (r.review && !r.purpose
            ? '\nReport execution.commands with command, exitCode and summary, or an empty list and a concrete execution.noCommandsReason. Never claim a command was run based only on the supplied diff.'
            : ''),
        ...(r.resourcesJson
          ? { env: { ...process.env, DEVCONTOUR_RESOURCES_JSON: r.resourcesJson } }
          : {}),
        ...(r.execution
          ? {
              env: {
                ...r.execution.env,
                ...(r.resourcesJson ? { DEVCONTOUR_RESOURCES_JSON: r.resourcesJson } : {}),
              },
              redact: r.execution.redact,
            }
          : {}),
      }).catch((error: unknown) => {
        if (blockedStart(error))
          throw new BlockedError(`${name}: runtime не запускается: ${String(error)}`);
        throw error;
      });
      await writeFile(
        join(r.artifactDir, 'runtime.json'),
        JSON.stringify(result.diagnostics, null, 2),
      );
      r.onDiagnostics?.(result.diagnostics);
      r.onUsage?.(
        parseUsage(
          name,
          result.stdout,
          result.code === 0 &&
            !result.timedOut &&
            !r.signal.aborted &&
            result.stdout.length < 2_000_000,
        ),
        version,
      );
      const log = result.stdout + '\n' + result.stderr;
      // Отказ окружения — это когда runtime не начал работать: не запустился,
      // не авторизовался, оборвался до первой попытки. Отсутствие кандидата
      // этого не доказывает: агент мог править файлы и упасть по таймауту,
      // истратив прогон, — такую попытку возвращать нельзя.
      //
      // Признак берётся из вывода самого runtime, но считаются не любые
      // события: незалогиненный claude тоже печатает system и result. Работой
      // считается ход агента — ответ, вызов инструмента, сообщение. Таймаут —
      // всегда работа: он израсходовал весь отведённый бюджет.
      const bookkeeping = ['system', 'result', 'error', 'session.created', 'thread.started'];
      const started =
        result.timedOut ||
        runtimeEvents(result.stdout).events.some((e) => !bookkeeping.includes(String(e.type)));
      if (result.code !== 0 || result.timedOut || r.signal.aborted)
        throw new (started ? Error : BlockedError)(
          `${name}: runtime завершился с кодом ${result.code}${result.timedOut ? ' (timeout)' : ''}` +
            // Причина отказа приходит от самого runtime — «Not logged in», исчерпанный
            // лимит, недоступная модель. Без неё сообщение говорит только «код 1», и
            // отказ окружения выглядит как провал задачи, пока кто-то не откроет лог.
            `${runtimeReason(name, result.stdout, result.stderr, r.execution?.redact) ?? ''}. Лог: ${r.artifactDir}`,
        );
      let data: unknown;
      if (name === 'codex') {
        const raw = await readFile(resultPath, 'utf8');
        const cleaned = r.execution ? r.execution.redact(raw) : raw;
        await writeFile(resultPath, cleaned);
        data = JSON.parse(cleaned);
      } else {
        const output = claudeResult.parse(
          runtimeEvents(result.stdout).events.findLast((e) => e.type === 'result'),
        );
        if (output.is_error) throw new Error(`Claude: ${output.result ?? 'ошибка runtime'}`);
        data = output.structured_output;
      }
      (r.purpose === 'evaluation'
        ? evaluationResult
        : r.purpose === 'plan'
          ? planResult
          : r.review
            ? reviewResult
            : implementationResult
      ).parse(data);
      if (r.review && !r.purpose) validateExecution(reviewResult.parse(data).execution);
      return {
        data,
        log,
        command: argv,
        ...(r.review ? { inspection: inspectReview(name, result.stdout) } : {}),
      };
    },
  };
}
// Deterministic fixture only. Never claim these outputs were produced by a model.
export const demoAdapter: AgentAdapter = {
  name: 'demo',
  async execute(r) {
    if (r.signal.aborted) throw new Error('Отменено');
    if (r.review) {
      const value = JSON.parse(
        await readFile(join(r.cwd, 'deliverables', `${r.task.id}.json`), 'utf8'),
      );
      return {
        data: {
          approved: value.id === r.task.id,
          summary: 'Детерминированная проверка demo-артефакта; это не AI-review.',
          findings: [],
        },
        log: 'Demo fixture review',
        command: ['internal:demo-review'],
      };
    }
    await mkdir(join(r.cwd, 'deliverables'), { recursive: true });
    await writeFile(
      join(r.cwd, 'deliverables', `${r.task.id}.json`),
      JSON.stringify(
        {
          id: r.task.id,
          title: r.task.title,
          acceptance: r.task.acceptance,
          dependsOn: r.task.dependsOn,
        },
        null,
        2,
      ) + '\n',
    );
    return {
      data: { completed: true, summary: 'Создан проверяемый demo-артефакт' },
      log: 'Demo fixture writer; no model invoked',
      command: ['internal:demo-writer'],
    };
  },
};
export const adapters: Record<RuntimeName, AgentAdapter> = {
  codex: cliAdapter('codex'),
  claude: cliAdapter('claude'),
  demo: demoAdapter,
};
