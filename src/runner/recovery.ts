import {
  analyzeRecovery as analyze,
  applyCases as harnessApplyCases,
  recoveryResultSchema,
  type PropertyRecovery,
  type Runner,
} from 'devcontour-harness';
import { DomainError, type Task } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { repository, reviewerBinding } from '../core/repositories.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import { runtimeAdapters } from '../harness/adapters.ts';
import { executionOf, toDomain } from '../harness/execution.ts';
import { toolProfileFor } from './tools.ts';
import { submitCase } from './checks.ts';

/**
 * Разбор ведущего по повторяющемуся свойству — разбор harness.
 *
 * Ответ — структурированное предложение с причиной и evidence, а не
 * произвольная программа или правка базы. Контур проверяет допустимость и
 * исполняет только разрешённое (правила harness). Здесь только продуктовое
 * назначение вызова: модель и профиль инструментов ведущего из конфигурации
 * DevContour и каталог контура, закрытый вызову.
 */
export const recoveryResult = recoveryResultSchema;
type RecoveryDecision = NonNullable<PropertyRecovery['decision']>;

/** Назначение вызова ведущего: профиль ревьюера роли для runtime автора и модель ревьюера. */
export function leadBinding(h: DevContour, task: Task, author: 'codex' | 'claude') {
  // Профиль проверяется прежним правилом: неизвестный или чужого runtime — отказ.
  const profile = toolProfileFor(h.config, author, task.role, true, task.repositoryId);
  const selected = reviewerBinding(h.config, task.role, task.repositoryId);
  const toolProfile =
    selected?.runtime === author && selected.toolProfile
      ? selected.toolProfile
      : profile
        ? `${author}-review`
        : undefined;
  const model = h.config.reviewer.runtime === author ? h.config.reviewer.model : undefined;
  return { ...(model ? { model } : {}), ...(toolProfile ? { toolProfile } : {}) };
}

export async function analyzeRecovery(
  h: DevContour,
  root: string,
  task: Task,
  author: 'codex' | 'claude',
  signal: AbortSignal,
  runtimes: Record<'codex' | 'claude', AgentAdapter> = adapters,
): Promise<RecoveryDecision> {
  const { engine } = executionOf(h);
  const repo = repository(h.config, task.repositoryId);
  const work = engine.read((v) => v.work(task.id));
  if (!work?.recovery) throw new DomainError('У задачи нет эпизода разбора', 409);
  try {
    return await analyze(
      {
        engine,
        policy: engine.policy,
        adapters: runtimeAdapters(h, engine.policy, runtimes),
        stateDir: root,
        cwd: repo.path,
        binding: leadBinding(h, task, author),
        boundary: { hidden: [root], readable: [repo.path] },
      },
      work,
      author,
      signal,
    );
  } catch (error) {
    throw toDomain(error);
  }
}

/**
 * Исполнить разрешённое добавление случаев — правило harness: каждый случай
 * подтверждается эталоном на дефектном SHA, ключи выводятся из эпизода, и
 * повтор после сбоя не создаёт второго подтверждения. Здесь только
 * подтверждение с продуктовыми входами (`submitCase`, wrapper без правил).
 */
export async function applyCases(h: DevContour, root: string, task: Task) {
  const work = executionOf(h).engine.read((v) => v.work(task.id));
  if (!work?.recovery) throw new DomainError('У задачи нет эпизода разбора', 409);
  // harness берёт у runner только подтверждение случая.
  const confirm = {
    submitCase: ({ workId, ...rest }: { workId: string }) =>
      submitCase(h, root, { ...rest, taskId: workId }),
  } as unknown as Runner;
  try {
    return await harnessApplyCases(confirm, work);
  } catch (error) {
    throw toDomain(error);
  }
}
