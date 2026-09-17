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
