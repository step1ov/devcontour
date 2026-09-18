import { DomainError, type Task, type DevContourState } from './model.ts';
export function assertDag(tasks: Pick<Task, 'id' | 'dependsOn'>[]) {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id))
      throw new DomainError(`Цикл зависимостей: ${[...visiting, id].join(' → ')}`);
    if (done.has(id)) return;
    const task = map.get(id);
    if (!task) throw new DomainError(`Зависимость ${id} не существует`, 400);
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    done.add(id);
  }
  tasks.forEach((t) => visit(t.id));
}
export function descendants(tasks: Task[], roots: string[]): string[] {
  const seen = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks)
      if (!seen.has(t.id) && t.dependsOn.some((d) => seen.has(d))) {
        seen.add(t.id);
        changed = true;
      }
  }
  return [...seen];
}
export function blockers(task: Task, state: DevContourState): string[] {
  return task.dependsOn.filter((id) => state.tasks.find((t) => t.id === id)?.status !== 'done');
}
export function readyTasks(state: DevContourState) {
  const visible = new Set(
    state.boards.flatMap((b) =>
      b.revisions.filter((r) => r.status === 'active').flatMap((r) => r.taskIds),
    ),
  );
  return state.tasks.filter(
    (t) => visible.has(t.id) && t.status === 'ready' && blockers(t, state).length === 0,
  );
}
export function levels(tasks: Task[]): Map<string, number> {
  const ids = new Set(tasks.map((t) => t.id));
  const memo = new Map<string, number>();
  function level(t: Task): number {
    if (memo.has(t.id)) return memo.get(t.id)!;
    const value =
      Math.max(
        -1,
        ...t.dependsOn.filter((d) => ids.has(d)).map((d) => level(tasks.find((x) => x.id === d)!)),
      ) + 1;
    memo.set(t.id, value);
    return value;
  }
  tasks.forEach(level);
  return memo;
}

/** Resolve replacement chains without modifying historical edges or snapshots. */
export function latestTaskId(tasks: Task[], id: string): string {
  const replacements = new Map(tasks.filter((t) => t.supersedes).map((t) => [t.supersedes!, t.id]));
  const seen = new Set<string>();
  while (replacements.has(id)) {
    if (seen.has(id)) throw new DomainError('Цикл замен');
    seen.add(id);
    id = replacements.get(id)!;
  }
  return id;
}
export function impactGraph(tasks: Task[]): Task[] {
  const superseded = new Set(tasks.map((t) => t.supersedes).filter(Boolean));
  return tasks
    .filter((t) => !superseded.has(t.id))
    .map((t) => ({ ...t, dependsOn: t.dependsOn.map((id) => latestTaskId(tasks, id)) }));
}
