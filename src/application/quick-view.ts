import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DevContourState } from '../core/model.ts';
import type { ProductChange } from '../core/preparation-model.ts';
import { Preparation } from '../core/preparation.ts';
import type { DevContour } from '../core/service.ts';
import type { Store } from '../core/store.ts';
import {
  LEAD_QUIET_MS,
  leadActivityAt,
  quickFacts,
  quickSetupPlan,
  quickSteps,
  type QuickFacts,
} from '../runner/quick.ts';
import { selectedWorkspaceMode } from '../runner/workspace-mode.ts';
import { baseWaitOf } from './queue-stop.ts';
import { InputService, inputHolds } from './input.ts';

// Проекция шагов быстрого маршрута для панели и центра внимания: одни и те же
// факты, одно правило. Только чтение: факты репозитория — процессы Git без
// записи, план setup — без записи, остальное — записи состояния.

export type CachedFacts = (
  workspace: string,
  repository: string,
  changeKeys: string[],
) => Promise<QuickFacts>;

/**
 * Факты репозитория — процессы Git и пробы версий: панель опрашивает часто,
 * а репозиторий меняется редко. Кэш короткий и только в памяти.
 */
export function quickFactsCache(ttlMs = 10_000): CachedFacts {
  const factsCache = new Map<string, { at: number; value: Promise<QuickFacts> }>();
  return (workspace, repository, changeKeys) => {
    const key = JSON.stringify([workspace, repository, changeKeys]);
    const hit = factsCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = quickFacts({
      workspace,
      mode: selectedWorkspaceMode(workspace),
      repository,
      changeKeys,
    });
    factsCache.set(key, { at: Date.now(), value });
    value.catch(() => factsCache.delete(key));
    return value;
  };
}

export interface QuickPrerequisites {
  facts?: QuickFacts;
  /** Инспекция репозитория не удалась: причина вместо ожидания. */
  factsError?: string;
  plan?: Awaited<ReturnType<typeof quickSetupPlan>>;
}

/** Асинхронные факты быстрого изменения: репозиторий и план setup до подключения движка. */
export async function quickPrerequisites(input: {
  h: DevContour | undefined;
  root: string;
  state: Readonly<DevContourState>;
  change: ProductChange;
  cachedFacts: CachedFacts;
}): Promise<QuickPrerequisites> {
  const { change } = input;
  if (!change.intake) return {};
  // Сбой инспекции — причина на экране, а не вечное «Проверяем».
  let factsError: string | undefined;
  const facts = await input
    .cachedFacts(
      input.root,
      change.intake.repository,
      (input.state.preparation?.changes ?? []).map((c) => c.key),
    )
    .catch((error: unknown) => {
      factsError = error instanceof Error ? error.message : String(error);
      return undefined;
    });
  const plan = input.h ? undefined : await quickSetupPlan({ workspace: input.root, change });
  return {
    ...(facts ? { facts } : {}),
    ...(factsError ? { factsError } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * Шаги быстрого изменения и присутствие ведущего по уже полученным фактам.
 * Синхронно: читается внутри одного снимка хранилища.
 */
export function quickView(input: {
  store: Store;
  h: DevContour | undefined;
  root: string;
  state: Readonly<DevContourState>;
  change: ProductChange;
  prerequisites: QuickPrerequisites;
  now: number;
}) {
  const { change, state, root, h } = input;
  const { facts, factsError, plan } = input.prerequisites;
  const view = new Preparation(input.store).status(change.id, { content: false });
  const { tasks, findings } = changeTasks(state, change);
  const steps = quickSteps({
    change,
    developmentReady: Boolean(view.enabled && view.developmentReady),
    blocker: view.enabled ? view.blocker : '',
    ...(facts ? { facts } : {}),
    ...(factsError ? { factsError } : {}),
    ...(plan ? { plan } : {}),
    configured: existsSync(join(root, '.devcontour-local', 'config.json')),
    engineConnected: Boolean(h),
    tasks,
    ...(() => {
      const questions = questionActors(h, tasks);
      return questions ? { questions } : {};
    })(),
    activeRuns: state.runs.filter(
      (r) => r.status === 'active' && tasks.some((t) => t.id === r.taskId),
    ).length,
    paused: state.paused,
    ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
    ...(() => {
      const baseWait = baseWaitOf(h, state);
      return baseWait ? { baseWait } : {};
    })(),
  });
  return {
    tasks,
    findings,
    steps,
    lead: leadPresence(change, tasks, input.now),
  };
}

/** Кто действует по вопросу исполнителя, держащему остановленную задачу изменения. */
function questionActors(
  h: DevContour | undefined,
  tasks: readonly { id: string; status: string }[],
) {
  const failed = tasks.filter((t) => t.status === 'failed');
  if (!h || !failed.length) return undefined;
  const holds = inputHolds(h);
  const service = new InputService(h);
  const out: Record<string, 'operator' | 'lead'> = {};
  for (const t of failed) {
    const requestId = holds.get(t.id);
    const request =
      requestId && service.list({ taskId: t.id }).requests.find((r) => r.requestId === requestId);
    if (request) out[t.id] = request.actor;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Задачи изменения и находки исполнителя, привязанные к нему отдельно. */
function changeTasks(state: Readonly<DevContourState>, change: ProductChange) {
  // Находки исполнителя наследуют привязку к изменению, но это не
  // работа маршрута: они показаны отдельно и не держат шаги.
  const bound = state.tasks.filter((t) => t.preparation?.changeId === change.id);
  return {
    tasks: bound.filter((t) => !t.finding),
    findings: bound
      .filter((t) => t.finding)
      .map((t) => ({ taskId: t.id, title: t.title, status: t.status })),
  };
}

/**
 * Присутствие ведущего агента известно только по его журналу: без свежей
 * записи панель не изображает идущую работу. `tasks` — задачи изменения
 * (по умолчанию — из состояния).
 */
export function leadPresence(
  change: ProductChange,
  tasks: { createdAt?: string; approvedAt?: string }[] | Readonly<DevContourState>,
  now: number,
) {
  const own = Array.isArray(tasks) ? tasks : changeTasks(tasks, change).tasks;
  const leadAt = leadActivityAt(change, own);
  return {
    lastActivityAt: leadAt,
    present: Boolean(leadAt && now - Date.parse(leadAt) < LEAD_QUIET_MS),
  };
}
