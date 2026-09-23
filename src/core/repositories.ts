import { type Config, type Repository, DomainError } from './model.ts';

export function repositories(config: Config): Repository[] {
  return config.repositories.length
    ? config.repositories
    : [
        {
          id: 'main',
          name: config.name,
          kind: 'product',
          path: config.repository,
          targetBranch: config.targetBranch,
          gates: config.gates,
          lifecycle: config.lifecycle,
          prepare: config.prepare,
          protectedPaths: config.protectedPaths,
          ...(config.generatedPaths.length ? { generatedPaths: config.generatedPaths } : {}),
        },
      ];
}
export function repository(config: Config, id = 'main'): Repository {
  const found = repositories(config).find((r) => r.id === id);
  if (!found) throw new DomainError(`Неизвестный репозиторий: ${id}`);
  return found;
}

export function roleBinding(
  config: Config,
  role: import('./model.ts').Role,
  repositoryId = 'main',
) {
  return repository(config, repositoryId).roles?.[role] ?? config.roles[role];
}
/**
 * Объявленные роли контура: workspace плюс то, что добавил компонент.
 * Инструмент не знает заранее, какие роли бывают у продукта.
 */
export function declaredRoles(config: Config, repositoryId = 'main'): string[] {
  return [
    ...new Set([
      ...Object.keys(config.roles),
      ...Object.keys(repository(config, repositoryId).roles ?? {}),
    ]),
  ];
}
/**
 * Роль реализует общую поверхность, и её задача без утверждённого контракта не
 * принимается. Раньше это был список из двух имён; теперь свойство роли —
 * иначе мобильная разработка, реализующая тот же API, проходила бы мимо.
 */
export function requiresContract(config: Config, role: string, repositoryId = 'main') {
  return (
    roleBinding(config, role, repositoryId)?.requiresContract ??
    ['backend', 'frontend'].includes(role)
  );
}
export function reviewerBinding(
  config: Config,
  role: import('./model.ts').Role,
  repositoryId = 'main',
) {
  return (
    roleBinding(config, role, repositoryId).reviewer ??
    repository(config, repositoryId).reviewer ??
    config.reviewer
  );
}
