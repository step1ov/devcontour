import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDemo } from './demo-pool.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

test('worktree-cleanup: дерево закончившейся попытки убирается; ветка остаётся, правки — патчем', async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'devcontour-worktrees-')), 'data');
  await testDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const scheduler = new Scheduler(new DevContour(store, config), root);
  const run = store.read().runs.find((r) => r.status !== 'active' && r.worktree)!;
  assert.ok(run, 'в demo есть закончившаяся попытка');
  const branch = `devcontour/run-${run.id}`;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: config.repository, encoding: 'utf8' }).trim();
  git('worktree', 'add', '-q', run.worktree!, branch);
  writeFileSync(join(run.worktree!, 'edited.txt'), 'draft\n');
  const head = git('rev-parse', branch);

  const plan = await scheduler.cleanupWorktrees({ dryRun: true });
  const planned = plan.worktrees.find((w) => w.action === 'remove')!;
  assert.equal(planned.uncommitted, 1);
  assert.ok(existsSync(run.worktree!), 'dry run ничего не убирает');

  const done = await scheduler.cleanupWorktrees();
  assert.equal(done.removed, plan.removable);
  assert.equal(existsSync(run.worktree!), false);
  assert.equal(git('rev-parse', branch), head, 'ветка осталась');
  assert.ok(existsSync(done.worktrees.find((w) => w.patch)!.patch!), 'патч в артефактах');
  store.close();
});
