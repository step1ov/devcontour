import { createHash } from 'node:crypto';
import {
  checkDeclarationSchema,
  declarationProblems as harnessDeclarationProblems,
  obligationGates,
  orderPropertyProblems,
  type ContractDocument,
  type GatePolicy,
} from 'devcontour-harness';
import { DomainError, type Config, type Contract, type Task } from './model.ts';
import { repository } from './repositories.ts';

/**
 * Договор проверки — форма и правила harness: схема, структурные пропуски,
 * обязательства поручения и его свойства. Здесь только продуктовые входы
 * (wrapper без правил): gates компонента из конфигурации DevContour и
 * контракты задачи в форме harness.
 */
export {
  isReference,
  obligationGates,
  obligationSchema,
  promiseKinds,
  referenceNote,
  strongPromises,
  type CheckDeclaration,
  type Obligation,
} from 'devcontour-harness';
export const checkDeclaration = checkDeclarationSchema;

/**
 * Договоры проверки контрактов задачи в форме harness. Правила договора
 * читают у контракта только `id` и `checks`; полная проверка документа
 * (`contractDocumentOf`) здесь не нужна и не должна заслонять продуктовый
 * отказ (заменённая редакция, неутверждённый контракт), который идёт после.
 */
export const taskContracts = (task: Pick<Task, 'contracts'>, contracts: Contract[]) =>
  contracts
    .filter((c) => task.contracts.includes(c.id))
    .map((c) => ({ id: c.id, ...(c.checks ? { checks: c.checks } : {}) }) as ContractDocument);

/** Структурные пропуски договора проверки — до вызова модели (правило harness). */
export function declarationProblems(
  declaration: import('devcontour-harness').CheckDeclaration,
  context: {
    config: Config;
    repositoryId: string;
    artifacts: string[];
    spike?: (id: string) => { digest: string } | undefined;
  },
): string[] {
  const repo = repository(context.config, context.repositoryId);
  return harnessDeclarationProblems(declaration, {
    gates: gatePolicies(repo.gates),
    repositoryId: repo.id,
    artifacts: context.artifacts,
    ...(context.spike ? { spike: context.spike } : {}),
  });
}

/**
 * Обязательство по property ID среди договоров задачи (чтение для экранов и
 * receipt). `gates` — все gates обязательства (свои или gate договора),
 * `gate` — первый из них.
 */
export function obligationOf(task: Pick<Task, 'contracts'>, contracts: Contract[], id: string) {
  return contracts
    .filter((c) => task.contracts.includes(c.id) && c.checks)
    .flatMap((c) =>
      c.checks!.obligations.map((obligation) => {
        const gates = obligationGates(c.checks!, obligation);
        return { contract: c, gate: gates[0], gates, obligation };
      }),
    )
    .find((x) => x.obligation.property === id);
}

/**
 * Gates компонента в форме политики: правила договора проверки читают у gate
 * только `id` и `property`, которые в конфигурации DevContour те же.
 */
const gatePolicies = (gates: Config['repositories'][number]['gates']) =>
  gates as unknown as GatePolicy[];

/**
 * Свойства задачи существуют в её договорах и исполняются её gates —
 * генеративными или, у эталонного обязательства, gates эталонных наборов
 * (правило harness). Задача без `properties` — прежний уровень.
 */
export function assertTaskProperties(
  task: Pick<Task, 'id' | 'contracts' | 'properties' | 'gates' | 'requirements'>,
  contracts: Contract[],
  /** Настроенные gates компонента. */
  gates: Config['repositories'][number]['gates'],
) {
  const problems = orderPropertyProblems(
    {
      id: task.id,
      properties: task.properties,
      gates: task.gates,
      requirements: task.requirements ?? [],
    },
    taskContracts(task, contracts),
    { configured: gatePolicies(gates), ...(task.gates?.length ? { scope: task.gates } : {}) },
  );
  if (problems.length) throw new DomainError(problems.join('; '), 400);
}

/**
 * Действующая версия проверок задачи по формуле DevContour: неизменная
 * постановка, контракты, действующая политика и принятый snapshot корпуса.
 * Это формула хоста (BasisProvider.checksDigest и ReceiverContext): тот же
 * состав, что `effectiveChecks` harness, в прежней сериализации — версии,
 * закреплённые попытками и receipts прежних версий, остаются в силе.
 */
export function effectiveChecks(
  task: Pick<Task, 'approvedDigest' | 'contractDigests' | 'checkVersion'>,
  policyDigest: string,
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        spec: task.approvedDigest ?? null,
        contracts: task.contractDigests,
        policy: policyDigest,
        corpus: task.checkVersion?.digest ?? null,
      }),
    )
    .digest('hex');
}
