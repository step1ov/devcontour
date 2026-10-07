import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DomainError,
  propertyIdSchema,
  relativePath,
  type Config,
  type Contract,
  type Task,
} from './model.ts';
import type { CheckManifest } from './property.ts';
import { repository } from './repositories.ts';

/**
 * Договор проверки: структурированное описание существенных обязательств.
 *
 * Обязательство связывает существующие REQ/критерии с property ID, областью
 * входов, правилами ответа, независимым способом проверки и покрытием.
 * Второго реестра требований здесь нет: `requirements` ссылается на уже
 * существующие REQ и критерии приёмки, а property ID — тот же, что testcase
 * в JUnit и testId в отчёте свойств.
 *
 * Схема отклоняет структурные пропуски до вызова модели. Достаточность
 * описания, независимость эталона и соответствие тексту договора оценивает
 * ревьюер: по словам «минимальный» или «быстрый» контур нужду в эталоне не
 * определяет — автор классифицирует обязательство, ревьюер проверяет
 * классификацию.
 */
const text = (max = 2000) => z.string().trim().min(3).max(max);
export const propertyId = propertyIdSchema;
const gateId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const promiseKinds = [
  'functional',
  'accuracy',
  'optimality',
  'completeness',
  'performance',
  'invariant',
  'other',
] as const;
/** Вычислительные обещания: без независимого способа проверки их не утверждают. */
export const strongPromises = new Set(['accuracy', 'optimality', 'completeness', 'performance']);
export const obligationSchema = z.strictObject({
  property: propertyId,
  /** Существующие REQ или критерии приёмки, которые обязательство уточняет. */
  requirements: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  promise: z.enum(promiseKinds),
  /** Для `other` — что за обещание и почему оно не укладывается в остальные. */
  explanation: text().optional(),
  domain: z.strictObject({
    inputs: text(),
    bounds: text(),
    units: text().optional(),
    invalid: text(),
  }),
  answer: z.strictObject({
    rules: text(),
    ties: text().optional(),
    rounding: text().optional(),
    tolerance: text().optional(),
    refusals: text().optional(),
  }),
  method: z.strictObject({
    kind: z.enum(['oracle', 'certificate', 'analytic', 'invariant', 'scenario', 'other']),
    description: text(),
    /** Где способ применим: размеры, классы входов. За пределами — не доказательство. */
    applicability: text(),
    /** Закреплённые checker/oracle/generator — среди артефактов договора. */
    artifacts: z.array(relativePath).max(10).default([]),
  }),
  coverage: z.strictObject({
    families: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
          kind: z.enum(['typical', 'boundary', 'adversarial']),
          description: text(500),
          minCases: z.number().int().min(1).max(1_000_000),
        }),
      )
      .min(1)
      .max(20),
    /** Сколько входов генератора обязательно на свойство в одном прогоне гейта. */
    minCases: z.number().int().min(1).max(1_000_000),
    /** Свойство пополняется подтверждёнными случаями корпуса. */
    corpus: z.boolean().default(false),
  }),
  resources: z.strictObject({
    subject: text(),
    oracle: text(),
    benchmark: z.strictObject({ method: text(), environment: text() }).optional(),
  }),
  /**
   * Тяжёлый точный алгоритм или жёсткое время: до реализации нужен
   * ограниченный эксперимент (spike). Ставит автор, проверяет ревьюер.
   */
  hard: z.boolean().default(false),
  feasibility: z
    .strictObject({
      spike: z.string().regex(/^SP-[A-Za-z0-9_-]{1,80}$/),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export type Obligation = z.infer<typeof obligationSchema>;
export const checkDeclaration = z.strictObject({
  version: z.literal(1),
  /** Гейт, который исполняет проверку (property gate с закреплённым checker). */
  gate: gateId,
  obligations: z.array(obligationSchema).min(1).max(30),
  /**
   * Политика расширения: разрешено ли добавлять подтверждённые случаи без
   * полного изменения договора — под тем же checker/oracle, той же областью
   * входов и теми же правилами ответа.
   */
  corpus: z
    .strictObject({
      format: text(),
      extensible: z.boolean(),
      /** Предел числа случаев на свойство: корпус — регрессия, не замена генератора. */
      maxCases: z.number().int().min(1).max(5000).default(500),
    })
    .optional(),
});
export type CheckDeclaration = z.infer<typeof checkDeclaration>;

/**
 * Структурные пропуски договора проверки — до вызова модели.
 *
 * `artifacts` — пути, объявленные артефактами договора: способ проверки
 * обязан ссылаться на закреплённые файлы, иначе происхождение эталона не
 * закреплено ничем. `spike` возвращает сохранённый эксперимент по id или
 * undefined.
 */
export function declarationProblems(
  declaration: CheckDeclaration,
  context: {
    config: Config;
    repositoryId: string;
    artifacts: string[];
    spike?: (id: string) => { digest: string } | undefined;
  },
): string[] {
  const problems: string[] = [];
  const repo = repository(context.config, context.repositoryId);
  const gate = repo.gates.find((g) => g.id === declaration.gate);
  if (!gate) problems.push(`гейт ${declaration.gate} не настроен в компоненте ${repo.id}`);
  const ids = declaration.obligations.map((o) => o.property);
  for (const id of new Set(ids))
    if (ids.filter((x) => x === id).length > 1) problems.push(`свойство ${id} объявлено дважды`);
  for (const o of declaration.obligations) {
    const at = `свойство ${o.property}`;
    if (o.promise === 'other' && !o.explanation)
      problems.push(`${at}: для типа other объясните, какое это обещание`);
    const families = o.coverage.families.map((f) => f.id);
    if (new Set(families).size !== families.length)
      problems.push(`${at}: id семейств входов повторяются`);
    const sum = o.coverage.families.reduce((n, f) => n + f.minCases, 0);
    if (sum > o.coverage.minCases)
      problems.push(
        `${at}: семейства требуют ${sum} входов, больше общего минимума ${o.coverage.minCases}`,
      );
    for (const path of o.method.artifacts)
      if (!context.artifacts.includes(path))
        problems.push(`${at}: ${path} не объявлен артефактом договора и не закреплён`);
    if (strongPromises.has(o.promise)) {
      if (!['oracle', 'certificate', 'analytic', 'invariant'].includes(o.method.kind))
        problems.push(
          `${at}: для обещания ${o.promise} нужен независимый способ проверки (эталон, сертификат, аналитическое основание или инвариант), а не ${o.method.kind}`,
        );
      if (!o.method.artifacts.length && o.method.kind !== 'analytic')
        problems.push(`${at}: способ проверки не ссылается на закреплённый checker или эталон`);
      if (gate && !gate.property)
        problems.push(`${at}: гейт ${gate.id} не генеративный (нет property)`);
    }
    if (o.promise === 'performance' && !o.resources.benchmark)
      problems.push(`${at}: для производительности укажите метод измерения и среду`);
    if (o.coverage.corpus && !declaration.corpus)
      problems.push(`${at}: корпус включён, но политика расширения корпуса не описана`);
    if (o.hard) {
      if (!o.feasibility)
        problems.push(
          `${at}: тяжёлое обязательство требует ограниченного эксперимента до реализации (spike)`,
        );
      else {
        const spike = context.spike?.(o.feasibility.spike);
        if (!spike) problems.push(`${at}: эксперимент ${o.feasibility.spike} не найден`);
        else if (spike.digest !== o.feasibility.digest)
          problems.push(`${at}: эксперимент ${o.feasibility.spike} изменился после ссылки на него`);
      }
    }
  }
  return problems;
}

export const declarationDigest = (d: CheckDeclaration) =>
  createHash('sha256').update(JSON.stringify(d)).digest('hex');

/** Обязательства договоров задачи, исполняемые данным гейтом. */
function declared(task: Pick<Task, 'contracts'>, contracts: Contract[], gate?: string) {
  return contracts
    .filter((c) => task.contracts.includes(c.id) && c.checks)
    .flatMap((c) =>
      c.checks!.gate === gate || gate === undefined
        ? c.checks!.obligations.map((o) => ({ contract: c, gate: c.checks!.gate, obligation: o }))
        : [],
    );
}

/**
 * Свойства, объявленные задачей, существуют в её договорах и исполняются её
 * гейтами. Задача без `properties` — прежний договор: механизм для неё не
 * включён, и она проверяется на прежнем уровне.
 */
export function taskPropertyProblems(
  task: Pick<Task, 'id' | 'contracts' | 'properties' | 'gates' | 'requirements'>,
  contracts: Contract[],
) {
  if (!task.properties?.length) return [];
  const problems: string[] = [];
  const all = declared(task, contracts);
  if (new Set(task.properties).size !== task.properties.length)
    problems.push(`${task.id}: свойства задачи повторяются`);
  for (const id of task.properties) {
    const found = all.filter((x) => x.obligation.property === id);
    if (!found.length) {
      problems.push(`${task.id}: свойство ${id} не объявлено в договорах задачи`);
      continue;
    }
    if (found.length > 1)
      problems.push(`${task.id}: свойство ${id} объявлено в нескольких договорах`);
    const gate = found[0].gate;
    if (task.gates?.length && !task.gates.includes(gate))
      problems.push(`${task.id}: свойство ${id} проверяет гейт ${gate}, которого нет в задаче`);
  }
  // Сценарий, названный тем же id, проверяет тот же гейт: иначе требование
  // ссылается на свойство, а подтверждается другой проверкой.
  for (const link of task.requirements ?? []) {
    if (!link.testId) continue;
    const found = all.find((x) => x.obligation.property === link.testId);
    if (found && found.gate !== link.gate)
      problems.push(
        `${task.id}: ${link.id} ссылается на свойство ${link.testId}, но через гейт ${link.gate}, а не ${found.gate}`,
      );
  }
  return problems;
}

/** Случаи корпуса, закреплённые за задачей, — их выдаёт хранилище проверок. */
export interface CorpusSnapshot {
  digest: string;
  cases: { id: string; property: string }[];
}

/**
 * Манифест ожидаемой проверки гейта для задачи или undefined — прежний
 * уровень доказательства (задача не включила механизм).
 */
export function taskCheckManifest(
  task: Pick<Task, 'contracts' | 'properties'>,
  contracts: Contract[],
  gate: string,
  corpus?: CorpusSnapshot,
): CheckManifest | undefined {
  if (!task.properties?.length) return undefined;
  const obligations = declared(task, contracts, gate).filter((x) =>
    task.properties!.includes(x.obligation.property),
  );
  if (!obligations.length) return undefined;
  const ids = new Set(obligations.map((x) => x.obligation.property));
  const cases = corpus?.cases.filter((c) => ids.has(c.property)) ?? [];
  return {
    properties: obligations.map(({ obligation: o }) => ({
      id: o.property,
      minCases: o.coverage.minCases,
      families: o.coverage.families.map((f) => ({ id: f.id, minCases: f.minCases })),
    })),
    ...(corpus && cases.length ? { corpus: { digest: corpus.digest, cases } } : {}),
  };
}

/** Обязательство по property ID среди договоров задачи. */
export function obligationOf(task: Pick<Task, 'contracts'>, contracts: Contract[], id: string) {
  return declared(task, contracts).find((x) => x.obligation.property === id);
}

export function assertTaskProperties(
  task: Pick<Task, 'id' | 'contracts' | 'properties' | 'gates' | 'requirements'>,
  contracts: Contract[],
) {
  const problems = taskPropertyProblems(task, contracts);
  if (problems.length) throw new DomainError(problems.join('; '), 400);
}
