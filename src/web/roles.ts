// Роли объявляет workspace, а не инструмент: у продукта с мобильным
// приложением есть мобильная разработка, а тестировщик веба и тестировщик
// приложения — разные исполнители с разными прогонами. Панель поэтому не может
// держать закрытый список имён: она берёт объявленное имя, а для незнакомого
// идентификатора делает читаемое из него самого, вместо того чтобы показать
// пустоту.

export type RoleSource = {
  roles?: Record<string, { title?: string } | undefined>;
  repositories?: { roles?: Record<string, { title?: string } | undefined> }[];
};

const builtin: Record<string, string> = {
  architect: 'Архитектор',
  backend: 'Разработчик бэкенда',
  frontend: 'Разработчик интерфейса',
  mobile: 'Мобильный разработчик',
  qa: 'Тестировщик',
};

const humanize = (id: string) =>
  id
    .split('-')
    .filter(Boolean)
    .map((part, i) => (i ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');

/** Объявленные роли контура: workspace плюс то, что добавили компоненты. */
export function declaredRoles(source?: RoleSource): string[] {
  return [
    ...new Set([
      ...Object.keys(source?.roles ?? {}),
      ...(source?.repositories ?? []).flatMap((r) => Object.keys(r.roles ?? {})),
    ]),
  ];
}

/** Имя роли: объявленное, затем встроенное, затем читаемое из идентификатора. */
export function roleName(id: string, source?: RoleSource): string {
  const declared =
    source?.roles?.[id]?.title ??
    (source?.repositories ?? []).map((r) => r.roles?.[id]?.title).find(Boolean);
  return declared ?? builtin[id] ?? humanize(id);
}

// Конфигурация в панели одна, а имя роли нужно в десятке мест, включая те, где
// конфигурации под рукой нет. Источник ставится один раз при загрузке
// состояния; до этого имя всё равно читаемо — просто без объявленных заголовков.
let current: RoleSource | undefined;
export function setRoleSource(next?: RoleSource) {
  current = next;
}
export const roleLabel = (id: string) => roleName(id, current);
export const currentRoles = () => declaredRoles(current);
