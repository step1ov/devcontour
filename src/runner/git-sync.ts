import { memoryDirectory } from '../core/placement.ts';
import { selectedWorkspaceMode } from './workspace-mode.ts';
import { validatePreparation } from '../core/preparation.ts';
import type { Store } from '../core/store.ts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { z } from 'zod';
import type { DevContour } from '../core/service.ts';
import type { DevContourState } from '../core/model.ts';
import { taskInput } from '../core/model.ts';
import { repository, repositories } from '../core/repositories.ts';
import {
  canonical,
  identitySchema,
  mergeValue,
  recordKey,
  recordSchema,
  type Records,
  type SyncIdentity,
} from '../core/sync-model.ts';
import { completion, recordsFromState, stateFromRecords, taskOwner } from '../core/sync-state.ts';

const directory = '.devcontour';
const categories = ['tasks', 'boards', 'contracts', 'receipts', 'changesets', 'preparations'];
const baselineSchema = z.object({
  version: z.literal(1),
  identity: identitySchema,
  branch: z.string(),
  records: z.record(z.string(), recordSchema),
});
type Baseline = z.infer<typeof baselineSchema>;
type Scope = {
  owner?: string;
  path: string;
  directory: string;
  branch: string;
  commit: string;
  identity: SyncIdentity;
  remote: Records;
  baseline?: Baseline;
};
export interface SyncOptions {
  member?: string;
  dryRun?: boolean;
  allowBranchChange?: boolean;
  resolutions?: Record<string, 'local' | 'git'>;
}
function git(path: string, ...args: string[]) {
  return execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}
function safePath(root: string, relative: string) {
  let path = root;
  for (const segment of relative.split('/')) {
    path = join(path, segment);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error('Git sync не использует symlink: ' + path);
  }
  return path;
}
function readRecords(root: string, directory = '.devcontour'): Records {
  const records: Records = {};
  safePath(root, directory);
  for (const category of categories) {
    const dir = safePath(root, `${directory}/${category}`);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!/^[A-Za-z0-9_-]{1,80}\.json$/.test(file))
        throw new Error('Неизвестный файл состояния: ' + join(dir, file));
      const path = safePath(root, `${directory}/${category}/${file}`);
      if (!lstatSync(path).isFile() || lstatSync(path).size > 2 * 1024 * 1024)
        throw new Error('Недопустимый файл состояния: ' + path);
      const value = recordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      const key = category + '/' + file.slice(0, -5);
      if (recordKey(value) !== key) throw new Error('Имя файла не соответствует записи: ' + path);
      records[key] = value;
    }
  }
  return records;
}
function scopes(h: DevContour): Scope[] {
  if (!h.config.workspaceRoot) throw new Error('Git sync требует явно выбранный workspaceRoot');
  const selected = selectedWorkspaceMode(h.config.workspaceRoot);
  if (selected && selected !== (h.config.workspaceMode ?? 'separate'))
    throw new Error('Режим конфигурации не соответствует выбранному workspace');
  const locations = [
    { owner: undefined as string | undefined, path: h.config.workspaceRoot },
    ...repositories(h.config).map((r) => ({
      owner: r.id,
      path: r.path,
      directory: memoryDirectory(h.config, r.id),
    })),
  ];
  return readScopes(h.store, locations, h.config.workspaceMode === 'embedded');
}
function readScopes(
  store: Store,
  locations: { owner: string | undefined; path: string; directory?: string }[],
  embedded = false,
): Scope[] {
  const roots = locations.map((l) => realpathSync(l.path));
  if (embedded && (roots.length !== 2 || roots[0] !== roots[1]))
    throw new Error('Embedded sync требует workspace и единственный репозиторий в одном корне');
  if (
    !embedded &&
    roots.some((p, i) => roots.some((q, j) => i !== j && (p === q || p.startsWith(q + sep))))
  )
    throw new Error(
      'Git sync требует отдельные, невложенные Git-репозитории workspace и компонентов',
    );
  return locations.map((location) => {
    const directory = location.directory ?? '.devcontour';
    const path = realpathSync(location.path);
    if (git(path, 'rev-parse', '--show-toplevel') !== path)
      throw new Error('Нужен отдельный Git repository: ' + path);
    try {
      git(path, 'check-ignore', '--no-index', '.devcontour-local/state.sqlite');
    } catch {
      throw new Error('Добавьте .devcontour-local/ в .gitignore перед sync: ' + path);
    }
    let ignored = false;
    try {
      git(path, 'check-ignore', '--no-index', directory + '/identity.json');
      ignored = true;
    } catch {
      /* Expected: portable state must be tracked. */
    }
    if (ignored) throw new Error('.devcontour/ не должна быть в .gitignore: ' + path);
    if (git(path, 'diff', '--name-only', '--diff-filter=U'))
      throw new Error('Сначала разрешите Git merge conflicts: ' + path);
    let branch: string;
    try {
      branch = git(path, 'symbolic-ref', '--short', 'HEAD');
    } catch {
      throw new Error('Git sync требует именованную ветку: ' + path);
    }
    const commit = git(path, 'rev-parse', '--verify', 'HEAD');
    const raw = store.syncBaseline(location.owner);
    const baseline = raw ? baselineSchema.parse(raw) : undefined;
    const file = safePath(path, directory + '/identity.json');
    const identity = existsSync(file)
      ? identitySchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      : (baseline?.identity ?? {
          version: 1 as const,
          id: randomUUID(),
          repositoryId: location.owner,
        });
    if (identity.repositoryId !== location.owner)
      throw new Error('repositoryId не соответствует Git identity: ' + path);
    if (baseline && identity.id !== baseline.identity.id)
      throw new Error('Это другой проект/clone identity: ' + path);
    if (baseline && !existsSync(file))
      throw new Error('Git identity удалена; проверьте ветку: ' + path);
    const remote = readRecords(path, directory);
    if (!existsSync(file) && Object.keys(remote).length)
      throw new Error('Нет identity у существующих Git-записей: ' + path);
    return { ...location, path, directory, branch, commit, identity, remote, baseline };
  });
}
function assertIdle(s: DevContourState) {
  if (
    !s.paused ||
    s.runs.some((r) => r.status === 'active') ||
    s.changeSets.some(
      (c) =>
        c.verifications.some((v) => v.status === 'active') ||
        c.deliveries?.some((d) => d.status === 'active'),
    )
  )
    throw new Error('Git sync: приостановите очередь и завершите активные попытки/проверки');
}
function assertCommitContains(path: string, sha: string, targetBranch: string) {
  git(path, 'cat-file', '-e', `${sha}^{commit}`);
  let target = 'HEAD';
  try {
    target = git(path, 'rev-parse', '--verify', `refs/heads/${targetBranch}`);
  } catch {
    /* New clone: scheduler will branch from HEAD. */
  }
  try {
    git(path, 'merge-base', '--is-ancestor', sha, target);
  } catch {
    throw new Error(
      `Результат ${sha} отсутствует в принятой ветке ${path}; сначала получите и интегрируйте код`,
    );
  }
}
function validateGitResults(
  h: DevContour,
  old: DevContourState,
  next: DevContourState,
  scopeList: Scope[],
  records: Map<string | undefined, Records>,
) {
  for (const t of next.tasks) {
    if (t.status !== 'done') continue;
    const repo = repository(h.config, t.repositoryId);
    const receipt = completion(h, next, t);
    assertCommitContains(repo.path, t.resultSha!, repo.targetBranch);
    git(repo.path, 'cat-file', '-e', `${receipt.candidateSha}^{commit}`);
    git(repo.path, 'merge-base', '--is-ancestor', receipt.candidateSha, receipt.resultSha);
    if (old.tasks.some((p) => p.id === t.id && p.status === 'done')) continue;
    const scope = scopeList.find((s) => s.owner === taskOwner(t))!;
    for (const key of [`tasks/${t.id}`, `receipts/${t.sharedCompletion!.receipt.id}`]) {
      let committed: unknown;
      try {
        committed = JSON.parse(git(scope.path, 'show', `HEAD:${scope.directory}/${key}.json`));
      } catch {
        throw new Error('Приёмка из Git требует committed task + receipt: ' + key);
      }
      if (canonical(committed) !== canonical(records.get(scope.owner)![key]))
        throw new Error('Незакоммиченная правка результата не является приёмкой: ' + key);
    }
  }
  for (const b of next.boards)
    for (const r of b.revisions) {
      if (!r.snapshot) continue;
      const owners = [
        ...new Set(r.taskIds.map((id) => next.tasks.find((t) => t.id === id)!.repositoryId)),
      ];
      for (const id of owners) {
        const repo = repository(h.config, id);
        const sha =
          r.snapshot.repositories?.[id] ?? (owners.length === 1 ? r.snapshot.sha : undefined);
        if (!sha) throw new Error('Принятая общая доска требует SHA каждого компонента');
        assertCommitContains(repo.path, sha, repo.targetBranch);
      }
    }
}
function atomicWrite(root: string, relative: string, value: unknown) {
  const path = safePath(root, relative),
    content = canonical(value);
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  mkdirSync(dirname(path), { recursive: true });
  safePath(root, relative);
  // Temp files are outside the tracked state directory and on the same filesystem.
  const local = safePath(root, '.devcontour-local');
  mkdirSync(local, { recursive: true });
  const temp = join(local, `git-sync-${randomUUID()}.tmp`);
  writeFileSync(temp, content, { flag: 'wx' });
  renameSync(temp, path);
}
export function syncGit(h: DevContour, options: SyncOptions = {}) {
  if (options.resolutions)
    z.record(z.string(), z.enum(['local', 'git'])).parse(options.resolutions);
  let output: {
    status: string;
    member?: string;
    changes: { scope: string; key: string; direction: string }[];
    conflicts: { key: string; reason: string }[];
    scopes: { repositoryId?: string; path: string; branch: string }[];
  };
  const action = (state: DevContourState) => {
    if (!options.dryRun) assertIdle(state);
    const member = options.member ?? state.team?.member;
    if (!options.dryRun && !member)
      throw new Error('При первом sync укажите --member <устойчивый-id-разработчика>');
    if (member) taskInput.shape.assignee.unwrap().parse(member);
    const locations = scopes(h),
      local = recordsFromState(h, state),
      merged = new Map<string | undefined, Records>();
    const conflicts: { key: string; reason: string }[] = [],
      changes: { scope: string; key: string; direction: string }[] = [];
    for (const scope of locations) {
      const label = scope.owner ?? '@workspace',
        current = local.get(scope.owner) ?? {},
        base = scope.baseline?.records ?? {},
        next: Records = {};
      if (scope.baseline && scope.branch !== scope.baseline.branch && !options.allowBranchChange)
        conflicts.push({
          key: label,
          reason: `Ветка изменилась: ${scope.baseline.branch} → ${scope.branch}; проверьте состояние и используйте --allow-branch-change`,
        });
      for (const key of [
        ...new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(scope.remote)]),
      ].sort()) {
        const fullKey = label + '/' + key;
        try {
          let value;
          try {
            value = mergeValue(base[key], current[key], scope.remote[key]);
          } catch (e) {
            const selected = options.resolutions?.[fullKey];
            if (!selected) throw e;
            value = selected === 'local' ? current[key] : scope.remote[key];
          }
          if (!value)
            throw new Error(
              'Удаление истории запрещено: используйте cancel/корректировку; для другой ветки — отдельную копию workspace',
            );
          next[key] = recordSchema.parse(value);
          if (canonical(next[key]) !== canonical(current[key]))
            changes.push({ scope: label, key, direction: 'git-to-local' });
          if (canonical(next[key]) !== canonical(scope.remote[key]))
            changes.push({ scope: label, key, direction: 'local-to-git' });
          if (base[key]?.kind === 'receipt' && canonical(base[key]) !== canonical(next[key]))
            throw new Error('Receipt неизменяем');
        } catch (e) {
          conflicts.push({ key: fullKey, reason: String(e) });
        }
      }
      merged.set(scope.owner, next);
    }
    output = {
      status: conflicts.length ? 'conflict' : 'ready',
      member,
      changes,
      conflicts,
      scopes: locations.map(({ owner, path, branch }) => ({ repositoryId: owner, path, branch })),
    };
    if (conflicts.length) {
      if (options.dryRun) return output;
      throw new Error('Git sync conflicts:\n' + JSON.stringify(conflicts, null, 2));
    }
    const next = stateFromRecords(
      h,
      state,
      merged,
      new Map(locations.map((l) => [l.owner, l.commit])),
    );
    validateGitResults(h, state, next, locations, merged);
    if (options.dryRun) return output;
    // Recheck the tree before any write. On a filesystem failure DB rollback leaves
    // the old baseline; rerunning the same three-way merge repairs partial output.
    for (const scope of locations)
      if (
        git(scope.path, 'symbolic-ref', '--short', 'HEAD') !== scope.branch ||
        canonical(readRecords(scope.path, scope.directory)) !== canonical(scope.remote)
      )
        throw new Error('Git tree изменилось во время sync; повторите команду');
    for (const scope of locations) {
      atomicWrite(scope.path, scope.directory + '/identity.json', scope.identity);
      for (const [key, record] of Object.entries(merged.get(scope.owner)!))
        atomicWrite(scope.path, `${scope.directory}/${key}.json`, record);
      h.store.saveSyncBaseline(scope.owner, {
        version: 1,
        identity: scope.identity,
        branch: scope.branch,
        records: merged.get(scope.owner)!,
      });
    }
    Object.assign(state, next, { paused: true, leader: undefined, team: { member } });
    output.status = 'synchronized';
    return output;
  };
  if (options.dryRun)
    h.store.project(
      (s) => {
        action(s);
      },
      // Сверка пишет baseline даже вхолостую, поэтому здесь лок записи нужен.
      { write: true },
    );
  else h.store.change('git.synchronized', action);
  return output!;
}

export function assertTeamCheckout(h: DevContour) {
  if (!h.store.read().team) return;
  for (const scope of scopes(h)) {
    if (
      !scope.baseline ||
      scope.baseline.branch !== scope.branch ||
      canonical(scope.baseline.records) !== canonical(scope.remote)
    )
      throw new Error(
        'Git context изменился. Приостановите очередь и выполните sync перед запуском задач',
      );
  }
}

// Product preparation can be shared before there are repositories or execution gates.
export function syncPreparation(store: Store, workspace: string, member: string) {
  taskInput.shape.assignee.unwrap().parse(member);
  return store.change('preparation.synchronized', (state) => {
    assertIdle(state);
    const scope = readScopes(store, [{ owner: undefined, path: workspace }])[0];
    if (
      Object.values(scope.remote).some((r) => r.kind !== 'preparation') ||
      Object.values(scope.baseline?.records ?? {}).some((r) => r.kind !== 'preparation')
    )
      throw new Error(
        'Здесь уже есть техническая память; восстановите конфигурацию и используйте полный sync',
      );
    if (scope.baseline && scope.branch !== scope.baseline.branch)
      throw new Error('Для другой ветки подготовки используйте отдельный workspace');
    const key = 'preparations/workspace-preparation';
    const base = scope.baseline?.records[key];
    const current =
      state.preparation && (state.preparation.changes.length || base || !scope.remote[key])
        ? { version: 1, kind: 'preparation', data: state.preparation }
        : undefined;
    const record = recordSchema.parse(mergeValue(base, current, scope.remote[key]));
    if (record.kind !== 'preparation') throw new Error('Нет продуктового процесса для sync');
    const next = { ...state, preparation: record.data };
    validatePreparation(next, state);
    if (
      canonical(readRecords(scope.path, scope.directory)) !== canonical(scope.remote) ||
      git(scope.path, 'symbolic-ref', '--short', 'HEAD') !== scope.branch
    )
      throw new Error('Git tree изменилось во время sync');
    atomicWrite(scope.path, scope.directory + '/identity.json', scope.identity);
    atomicWrite(scope.path, scope.directory + '/' + key + '.json', record);
    store.saveSyncBaseline(undefined, {
      version: 1,
      identity: scope.identity,
      branch: scope.branch,
      records: { [key]: record },
    });
    state.preparation = record.data;
    return { status: 'synchronized', changes: record.data.changes.length, member };
  });
}
