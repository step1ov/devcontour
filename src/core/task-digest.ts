// Digest постановки задачи — листовой модуль без зависимостей от службы:
// его читают и ядро, и порты harness (`input-host`), не образуя цикла
// импорта с `core/service.ts`, который реэкспортирует эти функции.
import { createHash } from 'node:crypto';
import type { Task } from './model.ts';

export const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
/** Область проверок задачи: её gates и потребители, как они записаны в постановке. */
export const scopeDigest = (t: Pick<Task, 'gates' | 'consumers'>) =>
  digest({ gates: t.gates ?? [], consumers: t.consumers ?? [] });
export const specDigest = (t: Task) =>
  digest({
    ...(t.preparation ? { preparation: t.preparation } : {}),
    ...(t.repositoryId && t.repositoryId !== 'main' ? { repositoryId: t.repositoryId } : {}),
    ...(t.requirements?.length ? { requirements: t.requirements } : {}),
    title: t.title,
    description: t.description,
    role: t.role,
    dependsOn: t.dependsOn,
    acceptance: t.acceptance,
    ...(t.scope === 'workspace'
      ? { scope: t.scope, relatedRepositories: t.relatedRepositories }
      : {}),
    contracts: t.contracts,
    contractDigests: t.contractDigests,
    ...(t.contextPacks?.length ? { contextPacks: t.contextPacks } : {}),
    ...(t.writePaths?.length ? { writePaths: t.writePaths } : {}),
    ...(t.resources?.length ? { resources: t.resources } : {}),
    ...(t.finding ? { finding: t.finding } : {}),
    // Область задачи в договоре проверки — часть утверждаемого: включение
    // механизма для задачи проходит обычное ревью плана.
    ...(t.properties?.length ? { properties: t.properties } : {}),
  });
