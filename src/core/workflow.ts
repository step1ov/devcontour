import {
  DomainError,
  type Config,
  type Gate,
  type TaskInput,
  type DevContourState,
  type Verification,
  type ComponentImpact,
} from './model.ts';
import { createHash } from 'node:crypto';
import {
  repositories,
  repository,
  roleBinding,
  reviewerBinding,
  declaredRoles,
} from './repositories.ts';

export function orderedGates<T extends Gate>(gates: T[]): T[] {
  const byId = new Map(gates.map((g) => [g.id, g]));
  if (byId.size !== gates.length) throw new DomainError('Gate ids должны быть уникальны');
  const active = new Set<string>(),
    seen = new Set<string>(),
    ordered: T[] = [];
  const visit = (id: string) => {
    if (active.has(id)) throw new DomainError('Цикл зависимостей gates: ' + id);
    if (seen.has(id)) return;
    const gate = byId.get(id);
    if (!gate) throw new DomainError('Неизвестная зависимость gate: ' + id);
    active.add(id);
    for (const parent of gate.dependsOn ?? []) visit(parent);
    active.delete(id);
    seen.add(id);
    ordered.push(gate);
  };
  for (const gate of gates) visit(gate.id);
  return ordered;
}

export function validateWorkflow(config: Config) {
  const repos = repositories(config);
  if (
    config.workspaceMode === 'embedded' &&
    (!config.workspaceRoot ||
      repos.length !== 1 ||
      repos[0].path !== config.workspaceRoot ||
      config.repository !== config.workspaceRoot ||
      config.storage !== 'central')
  )
    throw new DomainError(
      'Embedded workspace: один репозиторий в корне workspace и одна central SQLite',
    );
  const bindings = [
    ...repos.flatMap((r) => [
      ...Object.values(r.roles ?? {})
        .filter(Boolean)
        .flatMap((role) => [role, ...(role?.reviewer ? [role.reviewer] : [])]),
      ...(r.reviewer ? [r.reviewer] : []),
    ]),
    ...Object.values(config.roles),
    config.reviewer,
    ...Object.values(config.roles).flatMap((r) => (r.reviewer ? [r.reviewer] : [])),
  ];
  for (const binding of bindings) {
    if (!binding.toolProfile) continue;
    const profile = config.toolProfiles[binding.toolProfile];
    if (!profile || profile.runtime !== binding.runtime)
      throw new DomainError('Неизвестный или несовместимый toolProfile: ' + binding.toolProfile);
  }
  if (config.completionMode === 'remote') {
    if (repos.some((r) => !r.forge || !config.forgeConnections[r.forge.connection]))
      throw new DomainError(
        'Для remote completion задайте forge и connection у каждого компонента',
      );
  }
  for (const repo of repos) {
    if (config.mode !== 'demo')
      for (const role of declaredRoles(config, repo.id)) {
        const writer = roleBinding(config, role, repo.id),
          reviewer = reviewerBinding(config, role, repo.id);
        if (writer.runtime === 'demo' || reviewer.runtime === 'demo')
          throw new DomainError('Demo adapter разрешён только в demo mode');
        if (writer.runtime === reviewer.runtime)
          throw new DomainError('Для каждого исполнителя выберите другой runtime ревьюера');
      }
    for (const steps of [
      repo.prepare,
      repo.dependencyBuild,
      repo.preflight,
      repo.lifecycle?.setup,
      repo.lifecycle?.ready,
      repo.lifecycle?.teardown,
    ])
      if (steps && new Set(steps.map((s) => s.id)).size !== steps.length)
        throw new DomainError('Step ids должны быть уникальны');
  }
  const seen = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new DomainError('Цикл зависимостей компонентов: ' + id);
    if (seen.has(id)) return;
    const repo = repository(config, id);
    active.add(id);
    for (const dep of repo.dependsOn ?? []) visit(dep);
    active.delete(id);
    seen.add(id);
  };
  repos.forEach((r) => visit(r.id));
  if (new Set(config.contextPacks.map((p) => p.id)).size !== config.contextPacks.length)
    throw new DomainError('Context pack ids должны быть уникальны');
  for (const p of config.contextPacks) {
    repository(config, p.repositoryId);
    if (new Set(p.files).size !== p.files.length)
      throw new DomainError('Повтор файлов context pack');
    if (Boolean(p.revision) !== Boolean(p.digest))
      throw new DomainError('Закрепите revision и digest вместе');
  }
  if (new Set(config.resources.map((r) => r.id)).size !== config.resources.length)
    throw new DomainError('Resource ids должны быть уникальны');
  for (const r of config.resources)
    if (
      r.kind === 'port' &&
      (!/^\d+$/.test(r.value) || Number(r.value) < 1024 || Number(r.value) > 65535)
    )
      throw new DomainError('Ресурс port должен содержать порт 1024–65535');
  for (const gates of [...repos.map((r) => r.gates), config.workspaceGates]) {
    orderedGates(gates);
    if (gates.some((g) => g.id === 'requirement-source'))
      throw new DomainError('requirement-source — зарезервированный gate');
    for (const gate of gates) validateResources(config, gate.resources ?? []);
  }
}
export function validateResources(config: Config, ids: string[]) {
  for (const id of ids)
    if (!config.resources.some((r) => r.id === id))
      throw new DomainError('Неизвестный ресурс: ' + id);
}
export function validateTaskContext(config: Config, task: TaskInput) {
  validateResources(config, task.resources ?? []);
  // Роль объявляет workspace, и задача может ссылаться только на объявленную:
  // у неизвестной роли нет ни области записи, ни runtime, ни ревьюера, и
  // исполнителя для неё просто не существует.
  if (!declaredRoles(config, task.repositoryId).includes(task.role))
    throw new DomainError(
      `Роль ${task.role} не объявлена; доступны: ${declaredRoles(config, task.repositoryId).join(', ')}`,
    );
  const keys = new Set<string>();
  for (const link of task.requirements ?? []) {
    const key = `${link.source}#${link.id}`;
    if (keys.has(key)) throw new DomainError('Повтор требования: ' + key);
    keys.add(key);
    if (createHash('sha256').update(link.text).digest('hex') !== link.digest)
      throw new DomainError('Текст требования не соответствует digest');
    if (
      !repository(config, task.repositoryId).gates.some(
        (g) => g.id === link.gate && g.kind === 'test',
      )
    )
      throw new DomainError('Требование должно ссылаться на test gate: ' + link.gate);
  }
  // Область записи — пересечение роли и задачи. Когда они не пересекаются,
  // исполнитель не вправе изменить ни одного файла: прогон отработает, потратит
  // попытку и упрётся в «изменены файлы вне области задачи/роли» — а причина в
  // постановке, и видна она была ещё до выдачи.
  const roleScope = roleBinding(config, task.role, task.repositoryId)?.writePaths;
  if (task.writePaths?.length && roleScope?.length) {
    const reachable = task.writePaths.filter(
      (path) => withinPaths(path, roleScope) || roleScope.some((p) => withinPaths(p, [path])),
    );
    if (!reachable.length)
      throw new DomainError(
        `Область записи задачи (${task.writePaths.join(', ')}) не пересекается с областью роли ` +
          `${task.role} (${roleScope.join(', ')}): исполнитель не сможет изменить ни одного файла`,
      );
  }
  if (task.gates) {
    const own = repository(config, task.repositoryId).gates;
    for (const id of task.gates)
      if (!own.some((g) => g.id === id))
        throw new DomainError('Проверка вне профиля компонента: ' + id);
    // Проверками без теста задача доказать себя не может: typecheck и lint
    // проходят и на нереализованном коде.
    if (!task.gates.some((id) => own.some((g) => g.id === id && g.kind === 'test')))
      throw new DomainError('Область доказательства задачи должна включать test gate');
    for (const link of task.requirements ?? [])
      if (!task.gates.includes(link.gate))
        throw new DomainError('Требование ссылается на проверку вне области задачи: ' + link.gate);
  }
  if (task.scope === 'workspace' && new Set(task.relatedRepositories ?? []).size < 2)
    throw new DomainError('Общая задача должна затрагивать минимум два компонента');
  for (const id of task.relatedRepositories ?? []) repository(config, id);
  for (const id of task.contextPacks ?? [])
    if (!config.contextPacks.some((p) => p.id === id))
      throw new DomainError('Неизвестный context pack: ' + id);
}
export const withinPaths = (path: string, prefixes: string[]) =>
  prefixes.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'),
  );

// Compare complete repository SHAs: manifests, lockfiles and configuration changes are included.
export function componentImpact(
  config: Config,
  state: DevContourState,
  run: Verification,
): ComponentImpact {
  const repos = repositories(config),
    all = repos.map((r) => r.id);
  const gates = orderedGates(config.workspaceGates);
  const baseline = state.changeSets
    .filter((c) => c.acceptance)
    .sort((a, b) => b.acceptance!.at.localeCompare(a.acceptance!.at))
    .map((c) => c.verifications.find((v) => v.id === c.acceptance!.verificationId))
    .find((v) => v?.manifest && v.policyDigest === run.policyDigest);
  const changed = all.filter(
    (id) => !baseline?.manifest?.[id] || baseline.manifest[id].sha !== run.manifest?.[id]?.sha,
  );
  const full = (reason: string): ComponentImpact => ({
    changed,
    affected: all,
    gateIds: gates.map((g) => g.id),
    mode: 'all',
    reason,
    baseline: baseline?.id,
  });
  if (config.verificationMode !== 'affected') return full('Полная проверка по умолчанию');
  if (!baseline) return full('Нет принятой комбинации SHA с текущей политикой');
  if (repos.some((r) => r.dependsOn === undefined))
    return full('Граф компонентов описан не полностью');
  if (!changed.length) return full('SHA не изменились: повторная полная проверка');
  const affected = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const repo of repos)
      if (!affected.has(repo.id) && repo.dependsOn!.some((id) => affected.has(id))) {
        affected.add(repo.id);
        grew = true;
      }
  }
  const selected = new Set(gates.filter((g) => affected.has(g.repositoryId)).map((g) => g.id));
  const include = (id: string) => {
    selected.add(id);
    for (const dep of gates.find((g) => g.id === id)!.dependsOn ?? [])
      if (!selected.has(dep)) include(dep);
  };
  [...selected].forEach(include);
  if (!gates.some((g) => selected.has(g.id) && g.kind === 'test' && g.report))
    return full('Нет достаточных тестов для затронутой области');
  return {
    changed,
    affected: [...affected],
    gateIds: gates.filter((g) => selected.has(g.id)).map((g) => g.id),
    mode: 'affected',
    reason: 'Изменённые компоненты, транзитивные потребители и prerequisites проверок',
    baseline: baseline.id,
  };
}
