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
          ...(config.gateGroups ? { gateGroups: config.gateGroups } : {}),
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

/**
 * Раскрыть область задачи в явный список gates компонента: идентификаторы
 * gates и ссылки на группы (`@имя`), рекурсивно, без циклов, в порядке первого
 * появления. Член, которого нет в профиле, и неизвестная группа — отказ.
 * Без области — весь профиль, как прежде.
 */
export function expandGates(repo: Repository, refs?: string[]): string[] {
  if (!refs?.length) return repo.gates.map((g) => g.id);
  const out: string[] = [];
  const visit = (ref: string, path: string[]) => {
    if (ref.startsWith('@')) {
      const name = ref.slice(1);
      if (path.includes(name))
        throw new DomainError(`Цикл в группах gates: ${[...path, name].join(' → ')}`);
      const members = repo.gateGroups?.[name];
      if (!members) throw new DomainError(`Неизвестная группа gates компонента ${repo.id}: ${name}`);
      for (const member of members) visit(member, [...path, name]);
      return;
    }
    if (!repo.gates.some((g) => g.id === ref))
      throw new DomainError('Проверка вне профиля компонента: ' + ref);
    if (!out.includes(ref)) out.push(ref);
  };
  for (const ref of refs) visit(ref, []);
  return out;
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
export function declaredRoles(config: Config, repositoryId?: string): string[] {
  // Компонент по умолчанию — первый настроенный, а не обязательно «main»:
  // в workspace из product и library вызов без repositoryId иначе падал бы на
  // несуществующем репозитории, хотя раньше эти пути работали.
  const owner = repositoryId ?? repositories(config)[0].id;
  return [
    ...new Set([
      ...Object.keys(config.roles),
      ...Object.keys(repository(config, owner).roles ?? {}),
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
  // Роль может быть не объявлена — конфигурация вправе не содержать ни одной
  // встроенной. Тогда ревьюер берётся общий, а не роняет вызов на undefined.
  return (
    roleBinding(config, role, repositoryId)?.reviewer ??
    repository(config, repositoryId).reviewer ??
    config.reviewer
  );
}
