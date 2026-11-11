import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { DevContour, digest, specDigest } from '../src/core/service.ts';
import { canonical } from '../src/core/sync-model.ts';
import { repositories } from '../src/core/repositories.ts';
import { config } from './helpers.ts';

export const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Sync Test',
      GIT_AUTHOR_EMAIL: 'sync@example.test',
      GIT_COMMITTER_NAME: 'Sync Test',
      GIT_COMMITTER_EMAIL: 'sync@example.test',
    },
  }).trim();
export interface Peer {
  repo: string;
  workspace: string;
  store: Store;
  h: DevContour;
  commit(): void;
  pull(): void;
}
export function peer(root: string, name: string, source?: Peer): Peer {
  const base = join(root, name),
    workspace = join(base, 'workspace'),
    repo = join(base, 'product');
  mkdirSync(base);
  for (const [path, from] of [
    [workspace, source?.workspace],
    [repo, source?.repo],
  ]) {
    if (from) git(base, 'clone', '--no-local', from, path!);
    else {
      mkdirSync(path!);
      git(path!, 'init', '-b', 'main');
      writeFileSync(join(path!, '.gitignore'), '.devcontour-local/\n');
      writeFileSync(join(path!, 'README.md'), 'A test repository.\n');
      git(path!, 'add', '.');
      git(path!, 'commit', '-m', 'baseline');
    }
    git(path!, 'config', 'user.name', 'Sync Test');
    git(path!, 'config', 'user.email', 'sync@example.test');
  }
  const c = config({ repository: repo, workspaceRoot: workspace, storage: 'component' });
  const store = new Store(join(workspace, '.devcontour-local/state.sqlite'), repositories(c));
  const h = new DevContour(store, c);
  return {
    repo,
    workspace,
    store,
    h,
    commit() {
      for (const path of [repo, workspace]) {
        git(path, 'add', '.devcontour');
        if (git(path, 'diff', '--cached', '--name-only'))
          git(path, 'commit', '-m', 'Sync development state');
      }
    },
    pull() {
      for (const path of [repo, workspace]) git(path, 'pull', '--ff-only');
    },
  };
}
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-sync-'));
  const peers: ReturnType<typeof peer>[] = [];
  return {
    root,
    create(name: string, source?: ReturnType<typeof peer>) {
      const p = peer(root, name, source);
      peers.push(p);
      return p;
    },
    cleanup() {
      for (const p of peers) p.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function edit(p: ReturnType<typeof peer>, id: string, changes: object) {
  const t = p.store.read().tasks.find((t) => t.id === id)!;
  p.h.editTask(id, { ...t, ...changes }, specDigest(t));
}
export function rewrite(path: string, change: (value: any) => void) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, canonical(value));
}
export function complete(p: ReturnType<typeof peer>, id: string) {
  p.h.approve(p.store.read().boards[0].id);
  p.h.pause(false);
  const r = p.h.claim('worker')!;
  assert.equal(r.taskId, id);
  const sha = git(p.repo, 'rev-parse', 'HEAD');
  p.h.phase(r.id, r.token, 'integrating', { candidateSha: sha, integrationSha: sha });
  for (const phase of ['candidate', 'integration'] as const)
    for (const kind of ['test', 'review'] as const)
      p.h.evidence(r.id, r.token, {
        kind,
        phase,
        sha,
        gate: kind === 'test' ? 'test' : 'independent-review',
        passed: true,
        exitCode: 0,
        command: ['fixture'],
        log: '/private/local/log',
        digest: digest('verified fixture'),
        summary: 'fixture',
      });
  p.h.finish(r.id, r.token, sha);
  p.h.pause(true);
  return r;
}
