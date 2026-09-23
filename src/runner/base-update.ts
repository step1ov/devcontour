import { join } from 'node:path';
import { git } from './process.ts';
import { repositories } from '../core/repositories.ts';
import type { Config } from '../core/model.ts';

// Прогон ответвляется от ветки интеграции, а контракты, схемы и каркас
// готовятся на рабочей ветке репозитория. Раньше эти линии ничто не сводило:
// ветка интеграции оставалась там, где её создали, и исполнитель получал дерево
// без работы, ради которой его запустили. Здесь перенос базы делается явно и
// целиком: очередь стоит, попыток нет, результат — один SHA на репозиторий.
export async function updateBase(config: Config, dataRoot: string) {
  const updated: {
    repositoryId: string;
    branch: string;
    from: string;
    to: string;
    commits: number;
    kind: 'fast-forward' | 'merge';
  }[] = [];
  for (const repo of repositories(config)) {
    const target = `refs/heads/${repo.targetBranch}`;
    const head = await git(repo.path, 'rev-parse', 'HEAD');
    const tip = await git(repo.path, 'rev-parse', target);
    if (head === tip) continue;
    const behind = Number(await git(repo.path, 'rev-list', '--count', `${target}..HEAD`));
    if (!behind) continue;
    const ahead = Number(await git(repo.path, 'rev-list', '--count', `HEAD..${target}`));
    if (!ahead) {
      // Цель — предок рабочей ветки: история не теряется и не переписывается.
      await git(repo.path, 'update-ref', target, head, tip);
      updated.push({
        repositoryId: repo.id,
        branch: repo.targetBranch,
        from: tip,
        to: head,
        commits: behind,
        kind: 'fast-forward',
      });
      continue;
    }
    // Обе линии несут работу: принятые прогоны в ветке интеграции и подготовка
    // в рабочей. Сводятся слиянием в отдельном worktree — ветка интеграции
    // checkout-веткой быть не может, и продвигается она только через ref.
    const cwd = join(dataRoot, 'worktrees', `base-${repo.id}-${Date.now()}`);
    await git(repo.path, 'worktree', 'add', '--detach', cwd, tip);
    try {
      await git(
        cwd,
        '-c',
        'core.hooksPath=/dev/null',
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-gpg-sign',
        head,
      );
      const merged = await git(cwd, 'rev-parse', 'HEAD');
      await git(repo.path, 'update-ref', target, merged, tip);
      updated.push({
        repositoryId: repo.id,
        branch: repo.targetBranch,
        from: tip,
        to: merged,
        commits: behind,
        kind: 'merge',
      });
    } finally {
      await git(repo.path, 'worktree', 'remove', '--force', cwd).catch(() => undefined);
    }
  }
  return {
    updated,
    next: updated.length
      ? 'База обновлена. Проверьте её гейтами и запустите очередь: queue --start.'
      : 'База уже содержит рабочую ветку; менять нечего.',
  };
}
