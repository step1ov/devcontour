import { z } from 'zod';

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const envKey = name.refine((s) => !s.startsWith('DEVCONTOUR_'), 'DEVCONTOUR_* задаёт runner');
export const environmentSchema = z.object({
  inherit: z.array(envKey).default([]),
  values: z.record(envKey, z.string()).default({}),
  secrets: z.record(envKey, name).default({}),
});
export type Environment = z.infer<typeof environmentSchema>;
export const stepSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  command: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(3_600_000).default(120000),
});
export type Step = z.infer<typeof stepSchema>;
export const lifecycleSchema = z.object({
  setup: z.array(stepSchema).default([]),
  ready: z.array(stepSchema).default([]),
  teardown: z.array(stepSchema).min(1),
});
export type Lifecycle = z.infer<typeof lifecycleSchema>;
const mcpSchema = z
  .object({
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.array(envKey).default([]),
    url: z.url().optional(),
    bearerTokenEnv: envKey.optional(),
    tools: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).min(1),
  })
  .superRefine((s, ctx) => {
    if (s.transport === 'stdio' ? !s.command || s.url : !s.url || s.command)
      ctx.addIssue({ code: 'custom', message: 'MCP требует command для stdio либо url для http' });
    if (s.url && (new URL(s.url).username || new URL(s.url).password))
      ctx.addIssue({
        code: 'custom',
        message: 'Учётные данные MCP передаются через bearerTokenEnv',
      });
  });
export const toolProfileSchema = z.object({
  runtime: z.enum(['codex', 'claude']),
  environment: environmentSchema.optional(),
  mcp: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), mcpSchema).default({}),
  // Claude rules are explicit; Codex uses its OS sandbox and a shell capability toggle.
  claudeTools: z.array(z.enum(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'])).optional(),
  claudeAllowedTools: z.array(z.string().min(1)).default([]),
  codexShell: z.boolean().default(true),
  codexNetwork: z.boolean().default(false),
});
export type ToolProfile = z.infer<typeof toolProfileSchema>;
export const forgeSchema = z.object({
  connection: z.string().min(1),
  project: z.string().min(1),
  remote: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .default('origin'),
  targetBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/),
  requiredChecks: z.array(z.string().min(1)).default([]),
});
export const forgeConnectionSchema = z
  .object({
    provider: z.enum(['gitlab', 'github', 'command']),
    url: z
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          (u.protocol === 'https:' ||
            (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
        );
      }, 'Forge требует HTTPS (HTTP разрешён для localhost fixture)')
      .optional(),
    tokenEnv: name.optional(),
    probe: stepSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.provider === 'command' ? !v.probe : !v.url)
      ctx.addIssue({ code: 'custom', message: 'Нужен URL API либо read-only probe command' });
  });
export type ForgeConnection = z.infer<typeof forgeConnectionSchema>;

export interface DependencySnapshot {
  repositoryId: string;
  sha: string;
  tree: string;
  path: string;
  artifacts: { path: string; digest: string }[];
}
export interface DeliveryComponent {
  sha: string;
  sourceBranch: string;
  tree: string;
  state: 'pending' | 'published' | 'merged';
  remoteTree?: string;
  checks?: { name: string; sha: string; status: string; url?: string }[];
  mr?: number;
  url?: string;
  mergedSha?: string;
}
export interface Delivery {
  id: string;
  verificationId: string;
  manifestDigest: string;
  policyDigest: string;
  token: string;
  leaseUntil: number;
  status: 'active' | 'failed' | 'prepared' | 'waiting' | 'delivered';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  components: Record<string, DeliveryComponent>;
}

export class CleanupFailure extends Error {}

/** Preview: локальная выкладка проверенного результата в Docker (см. core/preview.ts). */
export const previewSchema = z.object({
  /** Compose-файл относительно корня сборки, где компоненты лежат в `<repositoryId>/`. */
  compose: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/),
  /** Сервис, публикующий URL на `${DEVCONTOUR_PREVIEW_PORT}`. */
  service: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/),
  /** Публичный порт preview: URL — http://127.0.0.1:<port>. */
  port: z.number().int().min(1024).max(65535),
  health: z
    .object({
      path: z
        .string()
        .regex(/^\/[^\s]*$/)
        .default('/health'),
      timeoutMs: z.number().int().min(1000).max(600000).default(60000),
    })
    .default({ path: '/health', timeoutMs: 60000 }),
  /**
   * Путь, отвечающий идентификатором релиза. Без него принадлежность URL
   * новому релизу подтверждается только тем, какой compose-проект держит
   * порт; с ним — ещё и ответом самого приложения.
   */
  version: z.object({ path: z.string().regex(/^\/[^\s]*$/) }).optional(),
  /** Пользовательский сценарий против URL (переменная PREVIEW_URL). */
  smoke: z
    .object({
      command: z.array(z.string().min(1)).min(1),
      timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
    })
    .optional(),
  /** Окружение сборки и запуска: только явно перечисленное, секреты — по имени. */
  environment: environmentSchema.optional(),
});
export type PreviewConfig = z.infer<typeof previewSchema>;
