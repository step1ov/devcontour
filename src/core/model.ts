import { preparationBinding, featureId, type PreparationState } from './preparation-model.ts';
import type { FailureKind } from './failure.ts';
import { priceSchema } from './usage.ts';
import type { ReviewInspection } from './review.ts';
import { z } from 'zod';
import type { CompletionReceipt } from './sync-model.ts';
import {
  environmentSchema,
  lifecycleSchema,
  stepSchema,
  toolProfileSchema,
  forgeSchema,
  forgeConnectionSchema,
  previewSchema,
  type DependencySnapshot,
  type Delivery,
} from './integrations.ts';
// Встроенные роли — умолчание для нового контура, а не полный список. Продукт
// с мобильным приложением, админкой и бэкендом не укладывается в четыре: у
// мобильной разработки своя область записи и свой инструментарий, а тестировщик
// веба и тестировщик приложения гоняют разные прогоны. Роли объявляет workspace,
// инструмент лишь требует, чтобы у объявленной роли были runtime и ревьюер.
export const roles = ['architect', 'backend', 'frontend', 'qa'] as const;
export const roleId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'Идентификатор роли: строчные латинские буквы, цифры и дефис');
export const taskStatuses = [
  'draft',
  'ready',
  'running',
  'verifying',
  'reviewing',
  'integrating',
  'done',
  'failed',
  'cancelled',
] as const;
export type Role = string;
export type TaskStatus = (typeof taskStatuses)[number];
export type RuntimeName = 'codex' | 'claude' | 'demo';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes(':') &&
      !/[*?\[\]]/.test(p) &&
      !p.split('/').some((part) => part === '..' || part === '.') &&
      !p.includes('\0'),
    'Ожидается относительный путь без glob, . или ..',
  );
export const discoveryInput = z.object({
  kind: z.enum(['bug', 'debt']),
  title: z.string().min(3).max(180),
  path: relativePath,
  line: z.number().int().positive(),
  observation: z.string().min(10).max(3000),
  consequence: z.string().min(3).max(1500),
  reproduction: z.string().min(3).max(3000),
});
export type Discovery = z.infer<typeof discoveryInput>;
export const contextPackSchema = z.object({
  id,
  version: z.string().min(1),
  repositoryId: id.default('main'),
  roles: z.array(roleId).default([]),
  files: z.array(relativePath).min(1).max(30),
  /**
   * Второй уровень пакета: файлы, которые исполнителю **названы**, но не
   * вложены в промпт. Правила, нужные в большинстве обращений, живут в `files`;
   * длинные примеры, таблицы и краевые случаи — здесь. Библиотека стандартов
   * на сотни килобайт иначе не помещается: вложить её целиком нельзя, а
   * выбросить — значит потерять именно те детали, ради которых её писали.
   *
   * Содержимое участвует в digest наравне с `files`: изменилась справка —
   * закрепление недействительно, как и для правил.
   */
  references: z.array(relativePath).max(60).default([]),
  revision: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ContextPack = z.infer<typeof contextPackSchema>;
export const resourceSchema = z.object({
  id,
  kind: z.enum(['device', 'port', 'account', 'service']),
  value: z.string().trim().min(1).max(300),
});
export type Resource = z.infer<typeof resourceSchema>;

export const requirementLink = z.strictObject({
  id: z.string().regex(/^REQ-[A-Za-z0-9_-]{1,64}$/),
  source: relativePath,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(3).max(12000),
  gate: id,
  scenario: z.string().min(3).max(1500),
  /**
   * Идентификатор testcase, который проверяет этот сценарий, — как его
   * называет отчёт проверки (`classname.name` в JUnit).
   *
   * Без него подтверждение означает лишь «на этом SHA у этого гейта есть
   * зелёное evidence»: зелёным гейт бывает и когда заявленное поведение не
   * проверяет никто. Поле необязательное намеренно — прежние задачи его не
   * содержат и читаются с прежним, более слабым уровнем доказательства,
   * названным прямо, а не переписываются задним числом.
   */
  testId: z.string().min(1).max(300).optional(),
});
export type RequirementLink = z.infer<typeof requirementLink>;
export const taskInput = z.object({
  preparation: preparationBinding.optional(),
  // Which approved product feature this task delivers, so the panel can show
  // feature readiness instead of a flat task count.
  featureId: featureId.optional(),
  requirements: z.array(requirementLink).max(30).optional(),
  assignee: z
    .string()
    .regex(/^[A-Za-z0-9_.@-]{1,80}$/)
    .optional(),
  repositoryId: id.default('main'),
  scope: z.enum(['component', 'workspace']).default('component'),
  relatedRepositories: z.array(id).optional(),
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().min(10).max(12000),
  role: roleId,
  dependsOn: z.array(id).max(100).default([]),
  acceptance: z.array(z.string().trim().min(3).max(1500)).min(1).max(30),
  contracts: z.array(id).max(30).default([]),
  contextPacks: z.array(id).max(30).optional(),
  writePaths: z.array(relativePath).min(1).max(100).optional(),
  // Область доказательства: подмножество проверок профиля, которым эта задача
  // доказывает себя. У задачи уже есть область записи; без области
  // доказательства параллельная декомпозиция упирается в общий набор, где
  // зелёный gate не различает, чьи ожидания закрыты. Полный набор остаётся
  // обязательным для приёмки доски и релиза.
  gates: z.array(id).max(20).optional(),
  resources: z.array(id).max(20).optional(),
  finding: discoveryInput
    .extend({
      fingerprint: z.string(),
      sourceTaskId: id,
      sourceRunId: z.string(),
      sourceSha: z.string(),
      verification: z.literal('proposed'),
    })
    .optional(),
});
export type TaskInput = z.infer<typeof taskInput>;
export interface Task extends TaskInput {
  sharedCompletion?: { receipt: CompletionReceipt; sourceCommit: string };
  id: string;
  status: TaskStatus;
  supersedes?: string;
  createdAt: string;
  approvedAt?: string;
  approvedDigest?: string;
  contractDigests: Record<string, string>;
  activeRunId?: string;
  attempt: number;
  resultSha?: string;
  failure?: string;
  /** Класс последнего отказа, поставленный в точке его обнаружения. */
  failureKind?: FailureKind;
  /** Отпечаток последнего отказа: по нему считаются одинаковые повторы. */
  failureFingerprint?: string;
  approval?: Approval;
}
export interface Approval {
  actor: 'operator' | 'agent';
  authorRuntime?: 'codex' | 'claude';
  reviewerRuntime?: 'codex' | 'claude';
  artifact?: string;
  digest?: string;
}
export interface Revision {
  number: number;
  status: 'active' | 'accepted';
  reason: string;
  taskIds: string[];
  createdAt: string;
  acceptedAt?: string;
  acceptance?: Approval;
  snapshot?: { tasks: Task[]; sha: string; digest: string; repositories?: Record<string, string> };
}
export interface Board {
  scope?: 'component' | 'workspace';
  repositoryId?: string;
  id: string;
  title: string;
  description: string;
  revisions: Revision[];
}
export interface Contract {
  repositoryId?: string;
  id: string;
  title: string;
  content: string;
  digest: string;
  /**
   * Файл репозитория, из которого прочитан контракт. Пока предложение несло
   * копию текста, на ревью можно было отправить устаревший снимок, а принятый
   * digest не относился ни к чему в дереве. Путь возвращает связь: видно, где
   * живёт контракт и что именно закреплено.
   */
  source?: string;
  approvedAt: string;
  approval?: Approval;
}
export interface Evidence {
  inspection?: ReviewInspection;
  id: string;
  runId: string;
  kind: 'test' | 'review';
  phase: 'candidate' | 'integration';
  sha: string;
  gate: string;
  passed: boolean;
  createdAt: string;
  command: string[];
  exitCode: number;
  log: string;
  digest: string;
  summary: string;
  /**
   * Находки ревью: путь, строка и следствие, а не только краткое изложение.
   * Без них следующая попытка знает, что «что-то не так», но не знает где и
   * что делать, — и круг повторяется с тем же замечанием.
   */
  findings?: { severity: string; message: string; path?: string | null; line?: number | null }[];
  /**
   * Что именно выполнилось: идентификаторы testcases и их исход. Итоговый код
   * возврата не говорит, проверялось ли заявленное поведение; манифест говорит.
   */
  /**
   * Выполненные testcases. `opaque` — имя изменено redaction или заменено
   * хешем из-за длины: для отображения годится, для подтверждения — нет,
   * иначе `case-[REDACTED]` совпал бы с тестом, которого никто не запускал.
   */
  tests?: { id: string; status: 'passed' | 'failed' | 'skipped'; opaque?: true }[];
  /**
   * Манифест обрезан по пределу размера: по нему нельзя судить об отсутствии
   * теста, поэтому подтверждение на уровне testcase по такому evidence не
   * выдаётся.
   */
  testsTruncated?: boolean;
}
export interface Run {
  memory?: { revision: string; ids: string[]; digest: string; bytes: number };
  dispatch?: {
    policy: 'fifo-ready-v1';
    at: string;
    eligible: { taskId: string; repositoryId?: string; attempt: number }[];
    activeCount: number;
    concurrency: number;
    inputDigest: string;
  };
  wait?: { approvedAt?: string; readyAt?: string };
  timings?: {
    id: string;
    stage: string;
    startedAt: string;
    finishedAt?: string;
    outcome?: 'passed' | 'failed';
  }[];
  requiredGates?: string[];
  id: string;
  taskId: string;
  repositoryId?: string;
  attempt: number;
  token: string;
  owner: string;
  runtime: RuntimeName;
  reviewer: RuntimeName;
  model?: string;
  reviewerModel?: string;
  policyDigest: string;
  status: 'active' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  phase: TaskStatus;
  startedAt: string;
  finishedAt?: string;
  leaseUntil: number;
  worktree?: string;
  baseSha?: string;
  candidateSha?: string;
  integrationSha?: string;
  error?: string;
  /** Отказ окружения: исполнителю не дали работать, попытка не засчитана. */
  blocked?: boolean;
  failureKind?: FailureKind;
  failureFingerprint?: string;
  evidence: Evidence[];
  context?: {
    id: string;
    version: string;
    repositoryId: string;
    revision: string;
    digest: string;
  }[];
  resources?: Resource[];
  dependencies?: DependencySnapshot[];
}
// Ревью контракта — работа с попытками: отклонение оставляет находки, которые
// стоили вызова модели. Без записи в состоянии они живут только файлами на
// диске, и панель показывает пустоту там, где шёл процесс.
export interface ContractAttempt {
  id: string;
  at: string;
  /** Что ревьюировали: контракт или план задач. */
  subject: string;
  /** Номер попытки для этого предмета: видно, сходится процесс или кружит. */
  attempt: number;
  title: string;
  repositoryId?: string;
  approved: boolean;
  summary: string;
  findings: { severity: string; message: string }[];
  artifact: string;
  authorRuntime: string;
  reviewerRuntime: string;
}
export interface DevContourState {
  preparation?: PreparationState;
  team?: { member: string };
  version: 1;
  boards: Board[];
  tasks: Task[];
  contracts: Contract[];
  contractAttempts?: ContractAttempt[];
  runs: Run[];
  changeSets: ChangeSet[];
  /** Выкладки preview проверенных ChangeSet; локальные, в sync не входят. */
  previews?: import('./preview.ts').Preview[];
  leader?: { owner: string; leaseUntil: number };
  paused: boolean;
  /** Кто остановил выдачу: человек, штатная остановка или отказ рантайма. */
  pauseReason?: 'operator' | 'shutdown' | 'runtime';
  /**
   * Классы отказов, держащие выдачу. Их несколько намеренно: временный
   * обрыв и отказ провайдера могут прийти с разных досок, и запомнив
   * только первый, контур снял бы паузу, оставив в силе более строгую
   * причину. Выдача возвращается, когда список пуст.
   */
  pauseFailures?: FailureKind[];
  /**
   * Когда выдачу остановили. По причине это не различить: исходное
   * «очередь ещё не запускали» записано так же, как решение человека.
   * Пауза раньше регистрации работы — часть состояния, из которого её
   * разрешили начать; пауза позже — новое решение, и цикл его не
   * отменяет.
   */
  pausedAt?: string;
  sequence: number;
}
export interface AuditEvent {
  id: number;
  at: string;
  type: string;
  data: unknown;
}
export interface Gate {
  id: string;
  kind: 'check' | 'test';
  command: string[];
  timeoutMs: number;
  report?: { type: 'junit'; path: string };
  dependsOn?: string[];
  cwd?: string;
  resources?: string[];
}
export const gateList = z
  .array(
    z.object({
      id,
      dependsOn: z.array(id).optional(),
      cwd: relativePath.optional(),
      resources: z.array(id).optional(),
      kind: z.enum(['check', 'test']),
      command: z.array(z.string().min(1)).min(1),
      timeoutMs: z.number().positive().default(120000),
      report: z.object({ type: z.literal('junit'), path: z.string().min(1) }).optional(),
    }),
  )
  .min(1);
export const reviewerBindingSchema = z.object({
  runtime: z.enum(['codex', 'claude', 'demo']),
  model: z.string().optional(),
  toolProfile: z.string().optional(),
});
export const roleBindingSchema = reviewerBindingSchema.extend({
  writePaths: z.array(relativePath).min(1).optional(),
  reviewer: reviewerBindingSchema.optional(),
  /** Как роль называется в панели: «Мобильный разработчик», а не `mobile`. */
  title: z.string().trim().min(2).max(40).optional(),
  /**
   * Роль реализует общую поверхность, поэтому её задача без утверждённого
   * контракта не принимается. По умолчанию это backend и frontend — те, кто
   * держал общий API до того, как роли стали объявляемыми.
   */
  requiresContract: z.boolean().optional(),
});
export const repositorySchema = z.object({
  configFile: relativePath.optional(),
  roles: z.record(roleId, roleBindingSchema).optional(),
  reviewer: reviewerBindingSchema.optional(),
  id,
  dependsOn: z.array(id).optional(),
  generatedPaths: z.array(relativePath).optional(),
  environment: environmentSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
  prepare: z.array(stepSchema).optional(),
  dependencyBuild: z.array(stepSchema).optional(),
  dependencyArtifacts: z.array(relativePath).optional(),
  preflight: z.array(stepSchema).optional(),
  forge: forgeSchema.optional(),
  name: z.string().min(1),
  kind: z.enum(['product', 'library']).default('product'),
  path: z.string().min(1),
  targetBranch: z
    .string()
    .regex(/^devcontour\/[a-zA-Z0-9/_-]+$/)
    .default('devcontour/accepted'),
  gates: gateList,
  protectedPaths: z
    .array(z.string().min(1))
    .default(['.github/', '.githooks/', 'package.json', 'package-lock.json']),
});
export type Repository = z.infer<typeof repositorySchema>;
export const workspaceGateSchema = gateList.element.extend({
  repositoryId: id,
  artifacts: z.array(z.string().min(1)).default([]),
});
export interface WorkspaceEvidence {
  gate: string;
  passed: boolean;
  command: string[];
  exitCode: number;
  log: string;
  digest: string;
  summary: string;
  artifacts: { path: string; digest: string }[];
}
export interface ComponentImpact {
  changed: string[];
  affected: string[];
  gateIds: string[];
  mode: 'all' | 'affected';
  reason: string;
  baseline?: string;
}
export interface Verification {
  productRelease?: import('./product-map.ts').ProductReleaseProof;
  id: string;
  token: string;
  leaseUntil: number;
  startedAt: string;
  finishedAt?: string;
  status: 'active' | 'passed' | 'failed';
  policyDigest: string;
  specDigest: string;
  tasks: Task[];
  boards: { id: string; title: string; revision: number }[];
  manifest?: Record<string, { sha: string; tree: string }>;
  manifestDigest?: string;
  impact?: ComponentImpact;
  evidence: WorkspaceEvidence[];
  error?: string;
}
export interface ChangeSet {
  releaseId?: string;
  id: string;
  title: string;
  description: string;
  boardIds: string[];
  createdAt: string;
  supersedes?: string;
  verifications: Verification[];
  deliveries?: Delivery[];
  acceptance?: {
    at: string;
    verificationId: string;
    digest: string;
    approval: Approval;
    deliveryId?: string;
  };
}

export const configSchema = z.object({
  prices: z
    .array(priceSchema)
    .max(100)
    .refine(
      (prices) =>
        new Set(prices.map((p) => JSON.stringify([p.runtime, p.model, Date.parse(p.effectiveAt)])))
          .size === prices.length,
      'Duplicate tariff effectiveAt',
    )
    .default([]),
  memoryPolicy: z
    .object({ maxBytes: z.number().int().min(0).max(24000).default(8000) })
    .default({ maxBytes: 8000 }),
  signalPolicy: z
    .object({ maxActionsPerHour: z.number().int().min(1).max(100).default(10) })
    .default({ maxActionsPerHour: 10 }),
  version: z.literal(1),
  name: z.string().min(1),
  environment: environmentSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
  prepare: z.array(stepSchema).optional(),
  workspaceLifecycle: lifecycleSchema.optional(),
  toolProfiles: z.record(z.string(), toolProfileSchema).default({}),
  completionMode: z.enum(['local', 'remote']).default('local'),
  forgeConnections: z.record(z.string(), forgeConnectionSchema).default({}),
  storage: z.enum(['central', 'component']).default('central'),
  workspaceRoot: z.string().optional(),
  workspaceMode: z.enum(['embedded', 'separate']).optional(),
  contextPacks: z.array(contextPackSchema).default([]),
  resources: z.array(resourceSchema).default([]),
  resourceDatabase: z.string().optional(),
  verificationMode: z.enum(['all', 'affected']).default('all'),
  generatedPaths: z.array(relativePath).default([]),
  repositories: z.array(repositorySchema).default([]),
  workspaceGates: z.array(workspaceGateSchema).default([]),
  preview: previewSchema.optional(),
  repository: z.string().min(1),
  targetBranch: z
    .string()
    .regex(/^devcontour\/[a-zA-Z0-9/_-]+$/)
    .default('devcontour/accepted'),
  mode: z.enum(['local', 'demo']).default('local'),
  approvalMode: z.enum(['agent', 'operator']).default('agent'),
  concurrency: z.number().int().min(1).max(4).default(2),
  leaseMs: z.number().int().min(5000).default(30000),
  runTimeoutMs: z.number().int().min(1000).default(900000),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  // Сколько раз ведущий цикл вправе сам починить упавшую задачу доски,
  // прежде чем позвать человека. Предел общий на доску, а не на задачу:
  // локально допустимые повторы складываются, и без общего потолка доска
  // из пятнадцати задач может занять пятнадцать бюджетов подряд.
  repairBudget: z.number().int().min(0).max(50).default(6),
  // Изоляция исполнителя, ревьюера и проверок. `os` — песочница ОС: запись
  // только в свой worktree, база контура и учётные данные закрыты, внешняя
  // сеть — только перечисленные домены. `none` снимает изоляцию проверок и
  // должен быть выбран явно: молчаливого отката без песочницы нет.
  isolation: z
    .object({
      mode: z.enum(['os', 'none']).default('os'),
      domains: z.array(z.string().min(1).max(253)).max(100).default([]),
    })
    .default({ mode: 'os', domains: [] }),
  // Одна форма привязки роли на весь конфиг: два описания одного и того же
  // расходятся, и роль, объявленная компонентом, начинает уметь не то, что
  // роль, объявленная workspace.
  roles: z.record(roleId, roleBindingSchema),
  reviewer: z.object({
    toolProfile: z.string().optional(),
    runtime: z.enum(['codex', 'claude', 'demo']),
    model: z.string().optional(),
  }),
  gates: gateList,
  protectedPaths: z
    .array(z.string().min(1))
    .default(['.github/', '.githooks/', 'devcontour.config.json']),
  packs: z
    .array(
      z.object({
        id,
        version: z.string(),
        capabilities: z.array(z.string()),
        source: z.strictObject({ repositoryId: id, path: relativePath }).optional(),
      }),
    )
    .default([]),
});
export type Config = z.infer<typeof configSchema>;
export const emptyState = (): DevContourState => ({
  version: 1,
  boards: [],
  tasks: [],
  contracts: [],
  runs: [],
  changeSets: [],
  paused: true,
  sequence: 0,
});
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
/**
 * Отказ окружения, а не задачи: исполнителю не дали работать. Незалогиненный
 * runtime, незакреплённый пакет контекста, недоступный ресурс — задача при этом
 * ни разу не была попробована, и попытка ей не засчитывается. Иначе бюджет
 * попыток сгорает на неполадках контура, и задача блокируется, ни разу не
 * дойдя до исполнителя.
 */
export class BlockedError extends Error {}

export function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new DomainError(message, 404);
  return value;
}
