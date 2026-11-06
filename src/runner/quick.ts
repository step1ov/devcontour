import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { inspectProject, type ProjectFacts } from 'devcontour-harness';
import type { DevContourState } from '../core/model.ts';
import type { ProductChange } from '../core/preparation-model.ts';
import { usageTotals, type UsageRecord } from '../core/usage.ts';
import { profile, profilePin } from './packs.ts';
import { planSetup } from './setup.ts';
import type { WorkspaceMode } from './workspace-mode.ts';

// Быстрый маршрут: одно существующее npm/pnpm-репозиторий, короткое поручение
// и наблюдаемый результат. Здесь только чтение: факты репозитория (harness
// inspectProject плюс правила размещения DevContour), план setup по
// предложению ведущего агента и проекция шагов «Подключение → Решения →
// Подготовка → Выполнение → Результат» из уже существующих записей.

/** Профили DevContour для существующего репозитория по менеджеру пакетов. */
export const quickProfiles = { npm: 'npm-project', pnpm: 'pnpm-project' } as const;

/** Файлы, которые пишет сам start в embedded workspace: не чужая работа. */
const startOwned = new Set(['.gitignore', 'devcontour.workspace.json']);

export type QuickDiagnostic = ProjectFacts['diagnostics'][number] | PlacementDiagnostic;
interface PlacementDiagnostic {
  code: 'placement-embedded' | 'placement-separate';
  severity: 'blocker';
  message: string;
  action: string;
  path?: string;
}

export interface QuickFacts {
  facts: ProjectFacts;
  diagnostics: QuickDiagnostic[];
  profiles: { id: string; version: string; digest: string }[];
  ready: boolean;
}

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Факты репозитория для быстрого маршрута. Ничего не пишет: harness
 * `inspectProject` + режим размещения, выбранный пользователем. Файлы, которые
 * start уже записал в embedded checkout, не считаются чужими изменениями, а
 * собственный каталог данных workspace — не вторым controller.
 */
export async function quickFacts(input: {
  workspace: string;
  mode: WorkspaceMode | undefined;
  repository: string;
  env?: NodeJS.ProcessEnv;
}): Promise<QuickFacts> {
  const facts = await inspectProject({
    repository: input.repository,
    ...(input.env ? { env: input.env } : {}),
  });
  const workspace = real(input.workspace);
  const root = facts.git.root;
  const embedded = input.mode === 'embedded';
  const own = embedded && root === workspace;
  // В embedded start пишет .gitignore и маркер режима, а подготовка —
  // проекцию изменений в docs/changes: это записи самого DevContour.
  const foreign = own
    ? facts.git.changes.filter((p) => !startOwned.has(p) && !p.startsWith('docs/changes/'))
    : facts.git.changes;
  // Профили DevContour версию менеджера не закрепляют: требование из
  // встроенного профиля harness здесь не действует, а packageManager проекта — да.
  const pinnedByHarness = new Set(
    facts.tools.filter((t) => t.required?.source.startsWith('profile ')).map((t) => t.name),
  );
  const diagnostics: QuickDiagnostic[] = facts.diagnostics.filter(
    (d) =>
      !(
        d.code === 'tool-version-mismatch' &&
        [...pinnedByHarness].some((name) => d.message.startsWith(name + ' '))
      ) &&
      !(d.code === 'dirty-checkout' && own && foreign.length === 0) &&
      !(
        d.code === 'devcontour-owned' &&
        own &&
        facts.markers.devcontour.every((m) => m === '.devcontour-local')
      ),
  );
  if (root && embedded && root !== workspace)
    diagnostics.push({
      code: 'placement-embedded',
      severity: 'blocker',
      message: `Embedded workspace ${workspace} не совпадает с корнем репозитория ${root}`,
      action: 'Укажите репозиторий, корень которого и есть workspace, или выберите separate',
      path: root,
    });
  if (
    root &&
    input.mode === 'separate' &&
    (workspace === root || workspace.startsWith(root + sep) || root.startsWith(workspace + sep))
  )
    diagnostics.push({
      code: 'placement-separate',
      severity: 'blocker',
      message: `Separate workspace ${workspace} и репозиторий ${root} вложены друг в друга`,
      action: 'Выберите репозиторий вне workspace',
      path: root,
    });
  const manager = facts.packageManager.name;
  const profiles = manager && root ? [profilePin(await profile(quickProfiles[manager], root))] : [];
  return {
    facts,
    diagnostics,
    profiles: profiles.map((p) => ({ id: p.id, version: p.version, digest: p.digest })),
    ready: !diagnostics.some((d) => d.severity === 'blocker'),
  };
}

/** План setup по последнему предложению ведущего агента — без записи. */
export async function quickSetupPlan(input: { workspace: string; change: ProductChange }) {
  const proposal = input.change.setup?.at(-1);
  if (!input.change.intake || !proposal) return undefined;
  try {
    return {
      proposal: proposal.digest,
      ...(await planSetup({
        repository: input.change.intake.repository,
        profile: proposal.profile,
        workspace: input.workspace,
        quick: true,
        ...(proposal.gates ? { gates: proposal.gates } : {}),
      })),
    };
  } catch (error) {
    return { proposal: proposal.digest, refusal: (error as Error).message, files: [] };
  }
}

type StepState = 'done' | 'current' | 'waiting' | 'blocked';
export interface QuickStep {
  id: 'connection' | 'decisions' | 'preparation' | 'execution' | 'result';
  title: string;
  state: StepState;
  /** Кто действует на текущем шаге. */
  actor?: 'operator' | 'lead';
  detail: string;
}

const stageTitles = {
  product: 'продуктовую часть',
  architecture: 'архитектуру и стек',
  references: 'референсы или неприменимость дизайна',
  concept: 'концепт',
  design: 'дизайн',
} as const;

/** Ведущий агент считается присутствующим, если писал журнал недавно. */
export const LEAD_QUIET_MS = 15 * 60_000;

/**
 * Шаги быстрого маршрута — проекция существующих фактов: поручения,
 * согласований, предложения setup, конфигурации и задач изменения. Своих
 * статусов маршрут не хранит.
 */
export function quickSteps(input: {
  change: ProductChange;
  developmentReady: boolean;
  blocker: string;
  facts?: QuickFacts;
  plan?: Awaited<ReturnType<typeof quickSetupPlan>>;
  configured: boolean;
  engineConnected: boolean;
  tasks: { status: string }[];
  /** Активные попытки задач изменения. */
  activeRuns: number;
  /** Выдача задач на паузе. */
  paused: boolean;
}): QuickStep[] {
  const { change } = input;
  const steps: QuickStep[] = [];
  const connected = Boolean(change.intake && input.facts?.ready);
  steps.push({
    id: 'connection',
    title: 'Подключение',
    state: connected ? 'done' : input.facts ? 'blocked' : 'current',
    actor: 'operator',
    detail: connected
      ? `Репозиторий ${input.facts!.facts.git.root} на ${input.facts!.facts.git.baseSha?.slice(0, 12)}`
      : input.facts
        ? input.facts.diagnostics
            .filter((d) => d.severity === 'blocker')
            .map((d) => `${d.message}. ${d.action}`)
            .join(' ')
        : 'Проверяем репозиторий',
  });
  const stages = ['product', 'architecture', 'references', 'concept', 'design'] as const;
  const review = stages.find((s) => change[s]?.at(-1)?.status === 'in-review');
  steps.push({
    id: 'decisions',
    title: 'Решения',
    state: input.developmentReady ? 'done' : connected ? 'current' : 'waiting',
    ...(input.developmentReady
      ? {}
      : { actor: review ? ('operator' as const) : ('lead' as const) }),
    detail: input.developmentReady
      ? 'Продукт, архитектура и применимость дизайна утверждены'
      : review
        ? `Утвердите ${stageTitles[review]} в панели`
        : input.blocker,
  });
  const live = input.tasks.filter((t) => t.status !== 'cancelled');
  const prepared = input.configured && input.engineConnected && live.length > 0;
  const plan = input.plan;
  const conflicts = plan?.files.filter((f) => f.action === 'conflict') ?? [];
  steps.push({
    id: 'preparation',
    title: 'Подготовка',
    state: prepared
      ? 'done'
      : !input.developmentReady
        ? 'waiting'
        : plan?.refusal || conflicts.length
          ? 'blocked'
          : 'current',
    ...(prepared ? {} : { actor: 'lead' as const }),
    detail: prepared
      ? 'Setup применён, задача поставлена'
      : !plan
        ? 'Ведущий агент предлагает профиль и проверки проекта'
        : plan.refusal
          ? plan.refusal
          : conflicts.length
            ? `Конфликты файлов: ${conflicts.map((f) => f.path).join(', ')}`
            : input.configured
              ? 'Ведущий агент закрепляет контекст и ставит задачу'
              : 'Ведущий агент применяет setup по показанному плану',
  });
  const done = live.length > 0 && live.every((t) => t.status === 'done');
  const failed = live.some((t) => t.status === 'failed');
  const working =
    input.activeRuns > 0 ||
    live.some((t) => ['running', 'verifying', 'reviewing', 'integrating'].includes(t.status));
  const drafts = live.length > 0 && live.every((t) => t.status === 'draft' || t.status === 'done');
  // Индикатор работы — только по фактам: идущая попытка или задача в работе.
  // Черновик и пауза — дело ведущего агента, а не «исполнитель работает».
  const execution: Pick<QuickStep, 'state' | 'actor' | 'detail'> = done
    ? { state: 'done', detail: 'Задача принята по проверкам и ревью' }
    : !prepared
      ? { state: 'waiting', detail: 'Ждёт подготовки' }
      : failed
        ? {
            state: 'blocked',
            actor: 'lead',
            detail: 'Попытка не прошла; ведущий агент разбирает причину',
          }
        : working
          ? { state: 'current', detail: 'Исполнитель работает; проверки и ревью идут штатно' }
          : drafts
            ? {
                state: 'current',
                actor: 'lead',
                detail: 'Задача в черновике: ведущий агент проводит review плана и запускает её',
              }
            : input.paused
              ? {
                  state: 'current',
                  actor: 'lead',
                  detail: 'Очередь на паузе: ведущий агент запускает выполнение',
                }
              : { state: 'current', detail: 'Задача в очереди, исполнитель ещё не взял её' };
  steps.push({ id: 'execution', title: 'Выполнение', ...execution });
  steps.push({
    id: 'result',
    title: 'Результат',
    state: done ? 'current' : 'waiting',
    ...(done ? { actor: 'operator' as const } : {}),
    detail: done
      ? 'Проверьте изменение; принятие задачи — не публикация и не готовность всего продукта'
      : 'Появится после принятия задачи',
  });
  // Изменение ушло полным маршрутом: шаги быстрого не продолжаются.
  if (change.expanded)
    for (const step of steps)
      if (step.state !== 'done') {
        step.state = 'waiting';
        delete step.actor;
        step.detail = 'Изменение продолжается полным маршрутом: ' + change.expanded.reason;
      }
  return steps;
}

/**
 * Результат задач изменения: SHA двух фаз, проверки и ревью из evidence
 * последней попытки, расход с долей неизвестного. Только чтение состояния.
 */
export function quickResult(state: DevContourState, changeId: string, usage: UsageRecord[]) {
  const tasks = state.tasks.filter((t) => t.preparation?.changeId === changeId);
  return tasks.map((task) => {
    const runs = state.runs.filter((r) => r.taskId === task.id);
    const run = runs.at(-1);
    const evidence = run?.evidence ?? [];
    const phase = (name: 'candidate' | 'integration') =>
      evidence
        .filter((e) => e.phase === name)
        .map((e) => ({
          gate: e.gate,
          kind: e.kind,
          passed: e.passed,
          sha: e.sha,
          summary: e.summary.slice(0, 300),
        }));
    const ids = new Set(runs.map((r) => r.id));
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      boardId:
        state.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(task.id)))?.id ?? null,
      resultSha: task.resultSha ?? null,
      attempts: runs.length,
      run: run
        ? {
            id: run.id,
            status: run.status,
            baseSha: run.baseSha ?? null,
            candidateSha: run.candidateSha ?? null,
            integrationSha: run.integrationSha ?? null,
            candidate: phase('candidate'),
            integration: phase('integration'),
          }
        : null,
      usage: usageTotals(usage.filter((u) => u.runId && ids.has(u.runId))),
    };
  });
}
