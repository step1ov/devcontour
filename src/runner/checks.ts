import {
  CorpusStore,
  caseHooks,
  runSpike as harnessRunSpike,
  spikeOf,
  spikesOf as harnessSpikesOf,
  submitCase as confirmCase,
  writeSelfCheck as harnessWriteSelfCheck,
  type ConfirmContext,
  type GatePolicy,
} from 'devcontour-harness';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import { CheckCorpus, localRoots } from '../core/check-store.ts';
import { taskContracts } from '../core/checks.ts';
import { executionOf, toDomain } from '../harness/execution.ts';
import { checkoutRoots, workspaceCheckout, workspaceCheckoutRoot } from './checkout-root.ts';

/**
 * Ограниченный эксперимент выполнимости (spike) — эксперимент harness:
 * команда на закреплённом SHA в отдельном worktree под изоляцией gates, с
 * пределом времени, маскированием и пределами вывода. Здесь только
 * продуктовые входы (wrapper без правил): каталог контура, пути компонентов
 * и граница, закрытая проверке.
 */
// Вход инструмента агента — прежняя форма DevContour (вопрос обрезается, а не
// отклоняется за пробелы); проверенный вход передаётся эксперименту harness.
export const spikeInput = z.strictObject({
  repositoryId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
  /** Commit эталона или прототипа; по умолчанию — HEAD компонента. */
  sha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  command: z.array(z.string().min(1)).min(1).max(50),
  sizes: z.array(z.number().int().min(0).max(1_000_000_000)).min(1).max(20),
  seed: z.number().int().min(0).max(4294967295).default(1),
  /** Предел на один размер. */
  timeoutMs: z.number().int().min(100).max(600000),
  /** Что исследуется: набор входов и вопрос эксперимента. */
  question: z.string().trim().min(10).max(2000),
});
export type { Spike } from 'devcontour-harness';

export function spikesOf(h: DevContour, repositoryId: string) {
  return executionOf(h).engine.read((view) => harnessSpikesOf(view, repositoryId));
}
export function spikeRecord(h: DevContour, repositoryId: string, id: string) {
  return executionOf(h).engine.read((view) => spikeOf(view, repositoryId, id));
}

/**
 * Каталоги, закрытые проверке: база контура и исходные checkout компонентов.
 * Корень рабочих деревьев workspace вне дерева передаётся в `checkouts`:
 * чужие попытки под ним закрыты, своё дерево проверки открыто.
 */
export function controllerBoundary(h: DevContour, root: string) {
  const repos = repositories(h.config);
  return {
    hidden: [...new Set([root, ...repos.map((r) => r.path)])],
    readable: repos.map((r) => join(r.path, '.git')),
    checkouts: checkoutRoots(h),
  };
}

/**
 * Каталог дерева эксперимента или подтверждения случая под корнем workspace;
 * без корня вне дерева — прежнее место в каталоге состояния (harness).
 */
function checkoutOf(h: DevContour) {
  return workspaceCheckoutRoot(h).root
    ? {
        checkout: (repositoryId: string, kind: string, id: string) =>
          workspaceCheckout(h, '', repositoryId, kind, id),
      }
    : {};
}

export async function runSpike(h: DevContour, root: string, raw: unknown) {
  const { engine } = executionOf(h);
  try {
    return await harnessRunSpike(
      {
        engine,
        policy: engine.policy,
        stateDir: root,
        repoPath: (repo) => repository(h.config, repo.id).path,
        boundary: () => controllerBoundary(h, root),
        ...checkoutOf(h),
      },
      spikeInput.parse(raw),
    );
  } catch (error) {
    throw toDomain(error);
  }
}

/**
 * Быстрый маршрут: подтверждённый пример становится обязательным случаем.
 *
 * Пример ревьюера или ведущего — гипотеза. Контур сам запускает закреплённый
 * эталон на этом входе (режим одного случая того же checker, что исполняет
 * гейт), повторяет проверку реализации на исходном дефектном SHA и требует
 * воспроизводимого расхождения. Ответ эталона, а не слова ревьюера, становится
 * ожиданием. Команда из воспроизведения (`reproduction.command`) не
 * исполняется никогда; данные входа не интерпретируются как shell.
 *
 * Маршрут добавляет данные под тем же checker/oracle, той же областью и
 * правилами ответа. Удаление случая, замена ожидания, допуск, покрытие, новый
 * checker или команда идут обычным изменением договора проверки.
 */
export const fastPathChanges = [
  'add',
  'remove',
  'replace-expected',
  'tolerance',
  'coverage',
  'checker',
  'command',
] as const;
export const caseInput = z.strictObject({
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  property: z.string().min(1).max(200),
  /** Точный вход как JSON-текст. */
  input: z
    .string()
    .min(1)
    .max(64 * 1024),
  /** Утверждение источника; эталон его проверяет, но не наследует. */
  expected: z
    .string()
    .max(64 * 1024)
    .nullable()
    .optional(),
  actual: z
    .string()
    .max(64 * 1024)
    .nullable()
    .optional(),
  reproductionId: z.string().max(80).optional(),
  /** Дефектный SHA; по умолчанию — кандидат последней неуспешной попытки задачи. */
  sourceSha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  sourceRunId: z.string().max(80).optional(),
  /** Какие незавершённые задачи принимают новую версию; по умолчанию — эта. */
  adopt: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/))
    .max(30)
    .optional(),
  /** Ключ идемпотентности: повтор с тем же ключом возвращает прежний исход. */
  key: z.string().regex(/^[A-Za-z0-9_.:-]{8,120}$/),
  change: z.enum(fastPathChanges).default('add'),
  origin: z.enum(['review', 'lead', 'agent', 'operator']).default('agent'),
  runtime: z.string().max(40).optional(),
});
export type CaseRequest = z.input<typeof caseInput>;

/**
 * Точка после записи версии и до принятия: тест моделирует в ней сбой. Она
 * общая с подтверждением пакета harness — одна подмена обрывает любой путь.
 */
export { caseHooks };

export async function submitCase(h: DevContour, root: string, raw: unknown) {
  const input = caseInput.parse(raw);
  if (input.change !== 'add')
    throw new DomainError(
      `Быстрый маршрут только добавляет подтверждённые случаи. Изменение «${input.change}» — обычное изменение договора проверки (contract-change с независимым ревью); если меняется продуктовый смысл, нужно утверждение пользователем. Принятые версии корпуса не переписываются.`,
      409,
    );
  const task = h.store.read().tasks.find((t) => t.id === input.taskId);
  if (!task) throw new DomainError('Задача не найдена', 404);
  const { engine } = executionOf(h);
  // Подтверждение — правило harness: закреплённый эталон на дефектном SHA,
  // запись решения и версии под владением, принятие версии задачами. Здесь
  // только продуктовые входы: задача, корни очистки диагностики, каталоги
  // компонентов и граница, закрытая проверке.
  const ctx: ConfirmContext = {
    corpus: new CorpusStore(
      engine,
      localRoots(h, [root, repository(h.config, task.repositoryId).path]),
    ),
    policy: engine.policy,
    stateDir: root,
    repoPath: (repo) => repository(h.config, repo.id).path,
    boundary: () => controllerBoundary(h, root),
    ...checkoutOf(h),
  };
  const { taskId, ...rest } = input;
  try {
    return await confirmCase(ctx, { ...rest, workId: taskId });
  } catch (error) {
    throw toDomain(error);
  }
}

/**
 * Самопроверка исполнителя — план harness: тот же закреплённый checker,
 * полный корпус закреплённой версии, seed и селектор свойств задачи.
 * Диагностика рабочего кода; evidence контура на commit SHA не заменяет.
 */
export async function writeSelfCheck(
  h: DevContour,
  task: import('../core/model.ts').Task,
  dir: string,
  seed: number,
  binding?: { suite: string; number: number; digest: string },
) {
  const s = h.store.read();
  const repo = repository(h.config, task.repositoryId);
  const corpus = binding ? new CheckCorpus(h).snapshot(binding) : undefined;
  return harnessWriteSelfCheck({
    order: { id: task.id, ...(task.properties ? { properties: task.properties } : {}) },
    contracts: taskContracts(task, s.contracts),
    // Self-check читает у gate только id, property, command и cwd — в
    // конфигурации DevContour те же поля.
    gates: repo.gates as unknown as GatePolicy[],
    dir,
    seed,
    ...(corpus ? { corpus: { content: corpus.content, cases: corpus.cases.length } } : {}),
  });
}
