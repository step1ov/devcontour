// Конфигурация DevContour в форме политики исполнения harness.
//
// Политика — нейтральное описание того, кто пишет и проверяет, какими gates и
// в какой изоляции. Её строит хост из своей конфигурации: поля продукта
// (context packs, память, forge, предпросмотр, Delivery) в неё не входят и
// остаются у DevContour. Значение, которое договор harness не принимает,
// — явный отказ с указанием поля, а не молчаливая подмена.
import {
  HarnessError,
  digestOf,
  executionPolicySchema,
  policyIssues,
  selectReviewer,
  type ExecutionPolicy,
} from 'devcontour-harness';
import type { Config, Repository } from '../core/model.ts';
import { repositories } from '../core/repositories.ts';

type Binding = {
  runtime: 'codex' | 'claude' | 'demo';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  toolProfile?: string;
};
type Gate = Repository['gates'][number];

/** Runtime DevContour `demo` — управляемый runtime `fixture` harness. */
export const harnessRuntime = (runtime: string) => (runtime === 'demo' ? 'fixture' : runtime);

/**
 * Назначение runtime. Профиль инструментов без явного имени — прежнее правило
 * DevContour: профиль `<runtime>` исполнителя и `<runtime>-review` ревьюера,
 * если он объявлен.
 */
function binding(config: Config, b: Binding, review: boolean) {
  const fallback = `${b.runtime}${review ? '-review' : ''}`;
  const toolProfile = b.toolProfile ?? (config.toolProfiles[fallback] ? fallback : undefined);
  return {
    runtime: harnessRuntime(b.runtime) as 'codex' | 'claude' | 'fixture',
    ...(b.model ? { model: b.model } : {}),
    ...(b.effort ? { effort: b.effort } : {}),
    ...(toolProfile ? { toolProfile } : {}),
  };
}

function gate(g: Gate) {
  return {
    id: g.id,
    kind: g.kind,
    command: g.command,
    timeoutMs: g.timeoutMs,
    ...(g.report ? { report: g.report } : {}),
    ...(g.property ? { property: g.property } : {}),
    ...(g.dependsOn ? { dependsOn: g.dependsOn } : {}),
    ...(g.cwd ? { cwd: g.cwd } : {}),
    ...(g.resources ? { resources: g.resources } : {}),
  };
}

/**
 * Режим управляемых runtime. Конфигурацию с demo вне demo mode отклоняет
 * проверка DevContour при загрузке; политика следует назначениям, которые
 * действительно используются: управляемый runtime никогда не идёт под
 * режимом live, и результат не выдаётся за проверку живой модели.
 */
function fixtureMode(config: Config) {
  if (config.mode === 'demo') return true;
  const bindings: { runtime: string; reviewer?: { runtime: string } }[] = [
    config.reviewer,
    ...Object.values(config.roles),
    ...repositories(config).flatMap((r) => [
      ...(r.reviewer ? [r.reviewer] : []),
      ...Object.values(r.roles ?? {}),
    ]),
    ...(['code', 'plan', 'contract'] as const).flatMap((k) =>
      config.review?.[k]?.reviewer ? [config.review[k].reviewer] : [],
    ),
  ];
  return bindings.some((b) => b.runtime === 'demo' || b.reviewer?.runtime === 'demo');
}

/**
 * Правило вендора ревью: явное из конфигурации, иначе прежнее поведение —
 * другой вендор. В demo mode исполнитель и ревьюер `demo` (оба — управляемый
 * runtime) допускались и раньше: правило сохраняет это явно.
 */
function ruleVendor(
  config: Config,
  explicit: 'different-vendor' | 'same-vendor-allowed' | undefined,
  reviewer: Binding,
) {
  return (
    explicit ??
    (fixtureMode(config) && reviewer.runtime === 'demo'
      ? 'same-vendor-allowed'
      : 'different-vendor')
  );
}

type RoleConfig = Config['roles'][string];
/**
 * Роль. Ревью кода роли — её ревьюер; правило вендора роли без своего
 * ревьюера относится к ревьюеру, который она получила бы (`fallback`).
 */
function role(config: Config, id: string, r: RoleConfig, fallback: Binding) {
  const reviewer = r.reviewer ?? (r.reviewVendor ? fallback : undefined);
  return {
    writer: binding(config, r, false),
    ...(r.writePaths ? { writePaths: r.writePaths } : {}),
    ...(reviewer
      ? {
          review: {
            reviewer: binding(config, reviewer, true),
            vendor: ruleVendor(config, r.reviewVendor ?? config.review?.code?.vendor, reviewer),
          },
        }
      : {}),
    requiresContract: r.requiresContract ?? ['backend', 'frontend'].includes(id),
  };
}

/**
 * Политика исполнения из конфигурации DevContour. Роли, переопределённые
 * компонентом, становятся ролями репозитория; ревьюер компонента — его ревью
 * кода по умолчанию. Ревью плана и контракта — `review.plan/contract`
 * конфигурации, без них — общий ревьюер.
 */
/**
 * Gate-заглушка политики технического ревью. Ревью плана и контракта не
 * исполняет gates репозиториев, а договор политики требует хотя бы один test
 * gate с JUnit:
 * workspace без test gate (как и прежде) остаётся пригодным для ревью.
 * Заглушка никогда не запускается и в исполнение задач не попадает.
 */
const reviewOnlyGate = {
  id: 'technical-review-only',
  kind: 'test' as const,
  command: ['true'],
  timeoutMs: 1000,
  report: { type: 'junit' as const, path: '.technical-review-only.xml' },
};

export function policyFromConfig(
  config: Config,
  options: { purpose?: 'execution' | 'review' } = {},
): ExecutionPolicy {
  const forReview = options.purpose === 'review';
  const reviewRule = (kind: 'code' | 'plan' | 'contract', reviewer?: Binding) => {
    const vendor = config.review?.[kind]?.vendor;
    // Ревью плана и контракта без своего ревьюера — прежнее правило DevContour:
    // живой runtime другого вендора, чем автор (модель общего ревьюера — если
    // это он). Выражено явным упорядоченным списком [codex, claude], а не
    // неявным «противоположным runtime»: при авторе claude берётся codex,
    // при авторе codex — claude.
    if (kind !== 'code' && !reviewer && !config.review?.[kind]?.reviewer) {
      const live = (runtime: 'codex' | 'claude') =>
        binding(config, config.reviewer.runtime === runtime ? config.reviewer : { runtime }, true);
      return {
        reviewer: live('codex'),
        alternates: [live('claude')],
        vendor: vendor ?? 'different-vendor',
      };
    }
    const selected = reviewer ?? config.review?.[kind]?.reviewer ?? config.reviewer;
    return {
      reviewer: binding(config, selected, true),
      vendor: ruleVendor(config, vendor, selected),
    };
  };
  const raw = {
    policyVersion: 1,
    mode: fixtureMode(config) ? 'fixture' : 'live',
    repositories: repositories(config).map((r) => ({
      id: r.id,
      path: r.path,
      kind: r.kind,
      targetRef: 'refs/heads/' + r.targetBranch,
      dependsOn: r.dependsOn ?? [],
      gates: forReview ? [reviewOnlyGate] : r.gates.map(gate),
      ...(r.gateGroups && !forReview ? { gateGroups: r.gateGroups } : {}),
      protectedPaths: r.protectedPaths,
      generatedPaths: r.generatedPaths ?? [],
      ...(r.environment ? { environment: r.environment } : {}),
      ...(r.lifecycle ? { lifecycle: r.lifecycle } : {}),
      prepare: r.prepare ?? [],
      dependencyBuild: r.dependencyBuild ?? [],
      dependencyArtifacts: r.dependencyArtifacts ?? [],
      preflight: r.preflight ?? [],
      ...(r.roles
        ? {
            roles: Object.fromEntries(
              Object.entries(r.roles).map(([id, b]) => [
                id,
                role(config, id, b, r.reviewer ?? config.reviewer),
              ]),
            ),
          }
        : {}),
      ...(r.reviewer ? { review: reviewRule('code', r.reviewer) } : {}),
    })),
    roles: Object.fromEntries(
      Object.entries(config.roles).map(([id, b]) => [id, role(config, id, b, config.reviewer)]),
    ),
    review: {
      code: reviewRule('code'),
      plan: reviewRule('plan'),
      contract: reviewRule('contract'),
    },
    workspaceGates: (forReview ? [] : config.workspaceGates).map((g) => ({
      ...gate(g),
      repositoryId: g.repositoryId,
      artifacts: g.artifacts,
    })),
    ...(config.workspaceLifecycle ? { workspaceLifecycle: config.workspaceLifecycle } : {}),
    verificationMode: config.verificationMode,
    approvalMode: config.approvalMode,
    isolation: config.isolation,
    toolProfiles: config.toolProfiles,
    ...(config.environment ? { environment: config.environment } : {}),
    ...(config.lifecycle ? { lifecycle: config.lifecycle } : {}),
    resources: config.resources,
    concurrency: config.concurrency,
    leaseMs: config.leaseMs,
    runTimeoutMs: config.runTimeoutMs,
    reviewProbes: config.reviewProbes,
    maxAttempts: config.maxAttempts,
    repairBudget: config.repairBudget,
    reuseImplementation: config.reuseImplementation,
    ...(config.budgets
      ? {
          budgets: {
            ...(config.budgets.task ? { work: config.budgets.task } : {}),
            ...(config.budgets.board ? { group: config.budgets.board } : {}),
            ...(config.budgets.workspace ? { total: config.budgets.workspace } : {}),
            onUnknown: config.budgets.onUnknown,
          },
        }
      : {}),
    prices: config.prices,
  };
  const parsed = executionPolicySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HarnessError(
      'INVALID_INPUT',
      `Конфигурация DevContour не выражается политикой harness: ${first?.path.join('.') || '—'} — ${first?.message ?? ''}`,
    );
  }
  const issues = policyIssues(parsed.data);
  if (issues.length)
    throw new HarnessError(
      'INVALID_INPUT',
      `Конфигурация DevContour не выражается политикой harness: ${issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  return parsed.data;
}

/**
 * Кто проведёт ревью плана или контракта автора по текущей конфигурации — по
 * тому же правилу harness, по которому движок выбирает reviewer (`demo` —
 * своим именем). Без допущения «противоположного runtime»: ревьюер может быть
 * назван явно или быть того же вендора, если это разрешено. Отказ правила —
 * `undefined`: показывать нечего, вызов откажет до модели.
 */
export function technicalReviewer(
  config: Config,
  kind: 'plan' | 'contract',
  author: 'codex' | 'claude',
): { runtime: string; sameVendor: boolean } | undefined {
  try {
    const choice = selectReviewer(policyFromConfig(config, { purpose: 'review' }), kind, {
      runtime: author,
    });
    return choice.ok
      ? {
          runtime: choice.reviewer.runtime === 'fixture' ? 'demo' : choice.reviewer.runtime,
          sameVendor: choice.sameVendor,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Часть политики исполнения, которую утверждает ревью плана (D42): что и
 * как исполняется и проверяется — gates, роли с областями записи, ревьюеры и
 * правила вендора, защищённые и генерируемые пути, окружение, изоляция,
 * инструменты. Эксплуатационные пределы (параллельность, сроки, попытки,
 * бюджеты, цены, ресурсы хоста, режим согласования, повторное использование
 * кандидата) план не меняют, и их правка повторного утверждения не требует.
 */
const operational = new Set([
  'concurrency',
  'leaseMs',
  'runTimeoutMs',
  'reviewProbes',
  'maxAttempts',
  'repairBudget',
  'budgets',
  'prices',
  'resources',
  'approvalMode',
  'reuseImplementation',
]);
export function approvalPolicyDigest(config: Config) {
  const approved = Object.fromEntries(
    Object.entries(policyFromConfig(config)).filter(([key]) => !operational.has(key)),
  );
  return digestOf({ approvalPolicy: 1, ...approved });
}
