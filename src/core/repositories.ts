import { expandGateRefs } from 'devcontour-harness/contracts';
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
/**
 * Раскрытие групп gates — правило harness (`expandGateRefs`): одно на всех,
 * без копии. Отказ — ошибка прикладного слоя с тем же текстом.
 */
export function expandGates(repo: Repository, refs?: string[]): string[] {
  try {
    return expandGateRefs(
      { id: repo.id, gates: repo.gates as never, gateGroups: repo.gateGroups },
      refs,
    );
  } catch (error) {
    throw new DomainError(error instanceof Error ? error.message : String(error));
  }
}

/** Компонент `consumer` зависит от `provider` по `dependsOn`, прямо или транзитивно. */
export function dependsOnRepository(config: Config, consumer: string, provider: string) {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (repository(config, id).dependsOn ?? []).some((p) => p === provider || visit(p));
  };
  return visit(consumer);
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
/** Зависимости компонентов в топологическом порядке, транзитивно. */
export function dependencyOrder(config: Config, ids: string[]) {
  const ordered: string[] = [],
    active = new Set<string>();
  const visit = (id: string) => {
    if (ordered.includes(id)) return;
    if (active.has(id)) throw new Error('Цикл зависимостей компонентов');
    active.add(id);
    for (const parent of repository(config, id).dependsOn ?? []) visit(parent);
    active.delete(id);
    ordered.push(id);
  };
  ids.forEach(visit);
  return ordered;
}

/** Правило вендора ревью кода роли компонента: своё у роли, иначе конфигурации, иначе прежнее. */
export function codeReviewVendor(
  config: Config,
  role: import('./model.ts').Role,
  repositoryId = 'main',
) {
  return (
    roleBinding(config, role, repositoryId)?.reviewVendor ??
    config.review?.code?.vendor ??
    'different-vendor'
  );
}
