import { ProjectMemory } from '../src/application/memory.ts';
import { AgentContext } from '../src/application/context.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseWorkspaceMode, selectedWorkspaceMode } from '../src/runner/workspace-mode.ts';
import { startWorkspace, preparationStore } from '../src/runner/start.ts';
import { Preparation } from '../src/core/preparation.ts';
import { approvePreparation } from './preparation-fixture.ts';
import { setupProject } from '../src/runner/setup.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { syncGit, syncPreparation, assertTeamCheckout } from '../src/runner/git-sync.ts';
import { config, input } from './helpers.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { IntentService } from '../src/runner/intent.ts';
import { requirementSnapshot } from '../src/runner/requirements.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { Workspace } from '../src/core/workspace.ts';
import { WorkspaceRunner } from '../src/runner/workspace.ts';
import { attachJournal } from '../src/runner/journal.ts';

const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Layout Test',
      GIT_AUTHOR_EMAIL: 'layout@example.test',
      GIT_COMMITTER_NAME: 'Layout Test',
      GIT_COMMITTER_EMAIL: 'layout@example.test',
    },
  }).trim();
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-layout-')));
function init(root: string) {
  mkdirSync(join(root, 'docs'), { recursive: true });
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.devcontour-local/\n.reports/\n');
  writeFileSync(
    join(root, 'docs/spec.md'),
    '## REQ-block: Block participant\nA blocked participant cannot post messages.\n',
  );
  commit(root);
}
function commit(root: string) {
  git(root, 'add', '.');
  git(root, 'commit', '--allow-empty', '-m', 'Fixture snapshot');
}
function peer(root: string) {
  const store = new Store(join(root, '.devcontour-local/state.sqlite'));
  const c = config({
    repository: root,
    workspaceRoot: root,
    workspaceMode: 'embedded',
    storage: 'central',
  });
  return { store, h: new DevContour(store, c), c };
}

test('Workspace placement is explicit before first launch, persisted on restart and immutable in a running checkout', async () => {
  const root = temp(),
    repo = join(root, 'shop');
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli.ts'), 'start', '--workspace', repo, '--port', '0'],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /embedded.*separate/);
    assert.equal(existsSync(join(repo, '.devcontour-local/state.sqlite')), false);
    writeFileSync(join(repo, '.gitignore'), '# Existing project rules\nnode_modules/');
    const app = await startWorkspace(repo, { port: 0, workspaceMode: 'embedded' });
    try {
      const s = await (await fetch(app.url + '/api/preparation')).json();
      assert.equal(s.workspace.mode, 'embedded');
      assert.equal(s.workspace.path, repo);
      assert.equal(s.engineConnected, false);
    } finally {
      await app.close();
    }
    const ignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    assert.match(ignore, /^# Existing project rules\nnode_modules\/\n/);
    git(repo, 'init', '-b', 'main');
    assert.equal(
      git(repo, 'check-ignore', '--no-index', '.devcontour-local/state.sqlite'),
      '.devcontour-local/state.sqlite',
    );
    const again = await startWorkspace(repo, { port: 0 });
    await again.close();
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), ignore);
    await assert.rejects(
      startWorkspace(repo, { port: 0, workspaceMode: 'separate' }),
      /уже выбран/,
    );
    assert.equal(selectedWorkspaceMode(repo), 'embedded');
    const damaged = join(root, 'damaged');
    mkdirSync(damaged);
    writeFileSync(join(damaged, '.git'), 'gitdir: /nonexistent/devcontour-test-missing-git\n');
    await assert.rejects(
      startWorkspace(damaged, { port: 0, workspaceMode: 'embedded' }),
      /Не удалось проверить/,
    );
    assert.equal(existsSync(join(damaged, '.devcontour-local/state.sqlite')), false);
    writeFileSync(
      join(repo, 'devcontour.workspace.json'),
      JSON.stringify({ version: 1, mode: 'separate' }),
    );
    assert.throws(() => selectedWorkspaceMode(repo), /изменён/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Embedded startup attaches approved single-repository setup without a second database or server', async () => {
  const root = temp();
  init(root);
  const app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
  try {
    const early = preparationStore(join(root, '.devcontour-local'));
    try {
      approvePreparation(new Preparation(early));
    } finally {
      early.close();
    }
    await setupProject({ repository: root, workspace: root, profile: 'react-vite-admin' });
    const c = loadConfig(join(root, '.devcontour-local/config.json'));
    assert.equal(c.storage, 'central');
    assert.equal(c.workspaceMode, 'embedded');
    assert.equal(c.repositories.length, 1);
    assert.equal(c.repositories[0].path, root);
    assert.ok(existsSync(join(root, 'devcontour.component.json')));
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.devcontour-local/);
    let connected = false;
    for (let i = 0; i < 40; i++) {
      const s = await (await fetch(app.url + '/api/preparation')).json();
      if (s.engineConnected) {
        connected = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(connected, true);
    const s = await (await fetch(app.url + '/api/state')).json();
    assert.equal(s.config.workspaceMode, 'embedded');
    assert.equal(s.dataRoot, join(root, '.devcontour-local'));
    assert.equal(s.paused, true);
    const saved = readFileSync(join(root, '.devcontour-local/config.json'), 'utf8');
    await setupProject({ repository: root, workspace: root, profile: 'react-vite-admin' });
    assert.equal(readFileSync(join(root, '.devcontour-local/config.json'), 'utf8'), saved);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A worker worktree cannot launch another embedded controller, even before configuration exists', async () => {
  const root = temp(),
    repo = join(root, 'shop'),
    worker = join(root, 'worker');
  init(repo);
  chooseWorkspaceMode(repo, 'embedded');
  commit(repo);
  git(repo, 'worktree', 'add', '-b', 'worker', worker);
  try {
    await assert.rejects(startWorkspace(worker, { port: 0 }), /Worktree исполнителя/);
    assert.throws(
      () => preparationStore(join(worker, '.devcontour-local')),
      /Worktree исполнителя/,
    );
    assert.equal(existsSync(join(worker, '.devcontour-local/state.sqlite')), false);
    const wrong = config({
      repository: repo,
      workspaceRoot: repo,
      workspaceMode: 'embedded',
      storage: 'component',
    });
    const store = new Store(':memory:');
    try {
      assert.throws(() => new DevContour(store, wrong), /Embedded/);
    } finally {
      store.close();
    }
  } finally {
    git(repo, 'worktree', 'remove', '--force', worker);
    rmSync(root, { recursive: true, force: true });
  }
});

test('One-Git preparation and task memory survive independent clones; concurrent edits rollback both scopes', () => {
  const root = temp(),
    a = join(root, 'a'),
    b = join(root, 'b');
  init(a);
  chooseWorkspaceMode(a, 'embedded');
  const first = peer(a);
  let second: ReturnType<typeof peer> | undefined;
  try {
    approvePreparation(new Preparation(first.store));
    syncPreparation(first.store, a, 'alice');
    const board = first.h.createBoard('Local work', '', 'main');
    const task = first.h.addTask(board.id, input('Original requirement'));
    syncGit(first.h, { member: 'alice' });
    const memory = new ProjectMemory(first.h),
      context = new AgentContext(first.h);
    for (const repositoryId of [undefined, 'main']) {
      memory.retain({
        repositoryId,
        kind: 'fact',
        subject: 'moderation',
        text: 'Blocking is required for moderation.',
        sources: ['docs/spec.md'],
      });
      const overview = context.execute('project_overview', { repositoryId }) as {
        revision: string;
      };
      const checkpoint = context.execute('checkpoint_save', {
        repositoryId,
        expectedRevision: overview.revision,
        summary: 'Checked moderation scope',
        nextStep: 'Implement the approved requirement',
      }) as { checkpointId: string; path: string };
      assert.equal(
        (
          context.execute('checkpoint_changes', {
            repositoryId,
            checkpointId: checkpoint.checkpointId,
          }) as { total: number }
        ).total,
        0,
      );
      assert.ok(
        checkpoint.path.includes(
          repositoryId ? '.devcontour/components/main/checkpoints/' : '.devcontour/checkpoints/',
        ),
      );
    }
    commit(a);
    assert.ok(existsSync(join(a, '.devcontour/preparations/workspace-preparation.json')));
    assert.ok(existsSync(join(a, '.devcontour/components/main/tasks', task.id + '.json')));
    git(root, 'clone', '--no-local', a, b);
    chooseWorkspaceMode(b);
    second = peer(b);
    syncGit(second.h, { member: 'bob' });
    assert.equal(second.store.read().tasks[0].id, task.id);
    const recalled = new ProjectMemory(second.h);
    assert.equal(recalled.recall({}).recordCount, 1);
    assert.equal(recalled.recall({ repositoryId: 'main' }).recordCount, 1);
    assert.deepEqual(second.store.read().tasks[0].preparation, task.preparation);
    const remote = second.store.read().tasks[0];
    second.h.editTask(task.id, { ...remote, title: 'Local competing edit' }, specDigest(remote));
    first.h.editTask(task.id, { ...task, title: 'Peer competing edit' }, specDigest(task));
    syncGit(first.h);
    commit(a);
    git(b, 'pull', '--ff-only');
    const before = second.store.read();
    assert.throws(() => syncGit(second!.h), /conflict/);
    assert.deepEqual(second.store.read(), before);
    assert.throws(() => assertTeamCheckout(second!.h), /Git context/);
    syncGit(second.h, { resolutions: { ['main/tasks/' + task.id]: 'git' } });
    assert.equal(second.store.read().tasks[0].title, 'Peer competing edit');
    assertTeamCheckout(second.h);
  } finally {
    first.store.close();
    second?.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Embedded product map and local intent drive real worktrees, joint verification and immutable Git receipts', async () => {
  const root = temp();
  init(root);
  chooseWorkspaceMode(root, 'embedded');
  writeFileSync(join(root, 'policy.json'), '{"canPost":false}');
  writeFileSync(
    join(root, 'verify.mjs'),
    `import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';assert.equal(JSON.parse(readFileSync('policy.json')).canPost,false);writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="blocked participant"/></testsuite>');`,
  );
  commit(root);
  const f = peer(root);
  approvePreparation(new Preparation(f.store));
  f.c.protectedPaths.push(
    'verify.mjs',
    'devcontour.workspace.json',
    '.devcontour/',
    '.devcontour-local/',
  );
  f.c.workspaceGates = [{ ...f.c.gates[0], id: 'joint', repositoryId: 'main', artifacts: [] }];
  const intent = new IntentService(f.h),
    scheduler = new Scheduler(f.h, join(root, '.devcontour-local')),
    runner = new WorkspaceRunner(f.h, join(root, '.devcontour-local'));
  try {
    const local = intent.render({
      repositoryId: 'main',
      definition: {
        kind: 'component',
        title: 'Moderation stories',
        purpose: 'Prevent blocked participants from posting.',
        audience: ['Moderators'],
        sources: ['docs/spec.md'],
        releases: [{ id: 'mvp', title: 'First release' }],
        stories: [
          {
            id: 'block',
            title: 'Block participant',
            releaseId: 'mvp',
            criteria: [
              {
                id: 'blocked',
                text: 'A blocked participant cannot post.',
                requirements: [{ source: 'docs/spec.md', id: 'REQ-block' }],
              },
            ],
          },
        ],
      },
    });
    assert.equal(local.source, 'docs/implementation-intent.md');
    writeFileSync(join(root, local.source), local.markdown);
    commit(root);
    const product = intent.render({
      definition: {
        kind: 'workspace',
        title: 'Chat product',
        purpose: 'Moderators control access to chat.',
        product: {
          channels: [
            {
              id: 'admin',
              title: 'Admin',
              purpose: 'Manage participants',
              audience: ['Moderators'],
              componentIds: ['api'],
            },
          ],
          components: [
            {
              id: 'api',
              title: 'Chat API',
              kind: 'backend',
              repositoryId: 'main',
              path: '.',
              dependsOn: [],
            },
          ],
          features: [{ id: 'block', title: 'Block', outcome: 'Blocked users cannot post.' }],
        },
        releases: [
          {
            id: 'mvp',
            title: 'Moderation',
            components: [{ repositoryId: 'main', releaseId: 'mvp' }],
            features: [
              {
                featureId: 'block',
                channels: [
                  {
                    channelId: 'admin',
                    scope: 'included',
                    stories: [{ repositoryId: 'main', storyId: 'block' }],
                  },
                ],
                checks: [{ gate: 'joint', scenario: 'Blocked participant cannot post' }],
              },
            ],
          },
        ],
      },
    });
    assert.equal(product.source, 'INTENT.md');
    writeFileSync(join(root, product.source), product.markdown);
    commit(root);
    const snapshot = intent.snapshot({ repositoryId: 'main', storyId: 'block' });
    assert.ok(snapshot.stories);
    assert.equal(snapshot.stories[0].requirement.source, local.source);
    const board = f.h.createBoard('Implement moderation', '', 'main');
    const req = requirementSnapshot(root, 'docs/spec.md').requirements[0];
    f.h.addTask(board.id, {
      ...input(),
      requirements: [snapshot.stories[0].requirement, { ...req, source: 'docs/spec.md' }].map(
        (r) => ({ ...r, gate: 'test', scenario: 'Blocked participant cannot post' }),
      ),
    });
    f.h.approve(board.id);
    await scheduler.init();
    f.h.pause(false);
    await scheduler.drain();
    assert.equal(f.store.read().tasks[0].status, 'done', f.store.read().tasks[0].failure);
    await acceptBoard(f.h, board.id, 'codex');
    const workspace = new Workspace(f.h),
      change = workspace.create({
        title: 'Moderation release',
        description: 'Verified moderation for the first release.',
        boardIds: [board.id],
        releaseId: 'mvp',
      });
    const v = await runner.verify(change.id);
    assert.equal(
      f.store.read().changeSets[0].verifications.find((check) => check.id === v.verificationId)
        ?.status,
      'passed',
    );
    runner.workspace.accept(change.id);
    const view = intent.productView({ releaseId: 'mvp' });
    assert.ok(view.available);
    assert.equal(view.releaseAccepted, true);
    attachJournal(f.h);
    f.h.pause(true);
    assert.equal(existsSync(join(root, 'docs/journal')), false);
    assert.ok(existsSync(join(root, '.devcontour-local/journal')));
    git(root, 'merge', '--ff-only', 'devcontour/accepted');
    syncGit(f.h, { member: 'alice' });
    commit(root);
    const clone = join(root, '..', root.split('/').at(-1) + '-clone');
    try {
      git(root, 'clone', '--no-local', root, clone);
      chooseWorkspaceMode(clone);
      const other = peer(clone);
      try {
        syncGit(other.h, { member: 'bob' });
        assert.equal(other.store.read().tasks[0].status, 'done');
        assert.ok(other.store.read().tasks[0].sharedCompletion);
      } finally {
        other.store.close();
      }
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  } finally {
    await scheduler.stop();
    await runner.stop();
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Handoff files are served from docs only, with their own type, and never from outside it', async () => {
  const root = temp(),
    repo = join(root, 'gym');
  try {
    mkdirSync(join(repo, 'docs/design/sketches'), { recursive: true });
    writeFileSync(join(repo, 'docs/design/sketches/screen.html'), '<p>Экран</p>');
    writeFileSync(join(repo, 'docs/design/sketches/screen.css'), '.a{color:#fff}');
    writeFileSync(join(repo, 'docs/notes.env'), 'SECRET=1');
    writeFileSync(join(repo, 'secrets.json'), '{"token":"1"}');
    const app = await startWorkspace(repo, { port: 0, workspaceMode: 'embedded' });
    try {
      const get = (path: string) => fetch(app.url + '/api/design/file/' + path);
      const page = await get('docs/design/sketches/screen.html');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type')!, /^text\/html/);
      // A page keeps its own stylesheet; isolation is the sandboxed frame.
      assert.match(page.headers.get('content-security-policy')!, /style-src 'self'/);
      assert.equal(await page.text(), '<p>Экран</p>');
      const style = await get('docs/design/sketches/screen.css');
      assert.equal(style.status, 200);
      assert.match(style.headers.get('content-type')!, /^text\/css/);
      // Outside docs, above it, and an extension nobody hands off are all refused.
      assert.equal((await get('secrets.json')).status, 400);
      assert.equal((await get('docs/../secrets.json')).status, 400);
      assert.equal((await get('docs/notes.env')).status, 415);
      assert.equal((await get('docs/design/sketches/missing.html')).status, 404);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
