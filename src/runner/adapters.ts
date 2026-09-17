import { evaluationResult } from '../core/evaluation.ts';
import type { ToolProfile } from '../core/integrations.ts';
import { codexTools, claudeMcp, claudeRules } from './tools.ts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { planResult, planSchema } from '../core/plan.ts';
import { command } from './process.ts';
import { discoveryInput, type RuntimeName, type Task } from '../core/model.ts';
export const implementationResult = z.object({
  completed: z.boolean(),
  summary: z.string(),
  discoveries: z.array(discoveryInput).max(20).default([]),
});
export const reviewResult = z.object({
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
  required: ['approved', 'summary', 'findings', 'discoveries'],
};
export interface AgentRequest {
  purpose?: 'plan' | 'evaluation';
  toolProfile?: ToolProfile;
  execution?: { env: NodeJS.ProcessEnv; redact: (text: string) => string };
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
  data: unknown;
  log: string;
  command: string[];
}
export interface AgentAdapter {
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
      ...(r.toolProfile ? codexTools(r.toolProfile) : []),
      '-',
    ];
  return [
    'claude',
    '--print',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--permission-mode',
    r.review ? 'dontAsk' : 'acceptEdits',
    '--tools',
    (r.review
      ? ['Read', 'Glob', 'Grep']
      : (r.toolProfile?.claudeTools ?? ['Read', 'Glob', 'Grep', 'Edit', 'Write'])
    ).join(','),
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
      const result = await command(argv, r.cwd, {
        signal: r.signal,
        timeoutMs: r.timeoutMs,
        input: r.prompt,
        ...(r.resourcesJson
          ? { env: { ...process.env, HARNESS_RESOURCES_JSON: r.resourcesJson } }
          : {}),
        ...(r.execution
          ? {
              env: {
                ...r.execution.env,
                ...(r.resourcesJson ? { HARNESS_RESOURCES_JSON: r.resourcesJson } : {}),
              },
              redact: r.execution.redact,
            }
          : {}),
      });
      const log = result.stdout + '\n' + result.stderr;
      await writeFile(join(r.artifactDir, 'runtime.log'), log);
      if (result.code !== 0 || result.timedOut || r.signal.aborted)
        throw new Error(
          `${name}: runtime завершился с кодом ${result.code}${result.timedOut ? ' (timeout)' : ''}. Лог: ${r.artifactDir}`,
        );
      let data: unknown;
      if (name === 'codex') {
        const raw = await readFile(resultPath, 'utf8');
        const cleaned = r.execution ? r.execution.redact(raw) : raw;
        await writeFile(resultPath, cleaned);
        data = JSON.parse(cleaned);
      } else {
        const output = JSON.parse(result.stdout);
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
      return { data, log, command: argv };
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
