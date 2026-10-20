import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { DevContour, digest } from '../src/core/service.ts';
import { repositories } from '../src/core/repositories.ts';
import { gateIdentity } from '../src/core/sync-state.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { config, input } from './helpers.ts';

// Receipt называет проверки, которыми подтверждён результат (тождество gates
// без путей clone). Независимые clone одного workspace: отправитель завершает
// задачу, получатель импортирует её штатным sync и принимает доску по receipt.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();

function peers() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-receipt-identity-')));
  const open: Store[] = [];
  function peer(name: string, source?: { workspace: string; repo: string }) {
    const base = join(root, name);
    mkdirSync(base);
    const paths = { workspace: join(base, 'workspace'), repo: join(base, 'product') };
    for (const key of ['workspace', 'repo'] as const) {
      const path = paths[key];
      if (source) git(base, 'clone', '--no-local', '-q', source[key], path);
      else {
        mkdirSync(path);
        git(path, 'init', '-q', '-b', 'main');
        writeFileSync(join(path, '.gitignore'), '.devcontour-local/\n');
        writeFileSync(join(path, 'README.md'), 'Receipt identity fixture.\n');
        git(path, 'add', '.');
        git(path, 'commit', '-q', '-m', 'fixture');
      }
    }
    const cfg = config({
      repository: paths.repo,
      workspaceRoot: paths.workspace,
      storage: 'component',
    });
    const store = new Store(
      join(paths.workspace, '.devcontour-local/state.sqlite'),
      repositories(cfg),
    );
    open.push(store);
    return { ...paths, store, h: new DevContour(store, cfg) };
  }
  return {
    peer,
    cleanup() {
      for (const s of open) s.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('T23/S3-R1-01: receipt подтверждает приёмку доски только теми же проверками — другая команда того же gate до или после импорта даёт отказ без snapshot', () => {
  const p = peers();
  try {
    const a = p.peer('sender');
    const board = a.h.createBoard('Received board', '', 'main');
    const task = a.h.addTask(board.id, input());
    a.h.approve(board.id);
    a.h.pause(false);
    const run = a.h.claim('fixture')!;
    const sha = git(a.repo, 'rev-parse', 'HEAD');
    a.h.phase(run.id, run.token, 'integrating', { candidateSha: sha, integrationSha: sha });
    for (const phase of ['candidate', 'integration'] as const)
      for (const kind of ['test', 'review'] as const)
        a.h.evidence(run.id, run.token, {
          kind,
          phase,
          sha,
          gate: kind === 'test' ? 'test' : 'independent-review',
          passed: true,
          exitCode: 0,
          command: ['fixture'],
          log: 'fixture',
          digest: digest('fixture evidence'),
          summary: 'Controlled fixture, no model or gate invocation',
        });
    a.h.finish(run.id, run.token, sha);
    a.h.pause(true);
    syncGit(a.h, { member: 'sender' });
    for (const path of [a.repo, a.workspace]) {
      git(path, 'add', '.devcontour');
      git(path, 'commit', '-q', '-m', 'share completed task');
    }
    const changed = ['node', 'different-check-that-was-never-run.mjs'];
    for (const mode of ['unchanged', 'changed-before-import', 'changed-after-import'] as const) {
      const b = p.peer(mode, a);
      if (mode === 'changed-before-import') b.h.config.gates[0].command = changed;
      syncGit(b.h, { member: mode });
      if (mode === 'changed-after-import') b.h.config.gates[0].command = changed;
      const state = b.store.read();
      const imported = state.tasks.find((t) => t.id === task.id)!;
      // Импорт и история сохраняются в любом случае: задача done, receipt на месте.
      assert.equal(state.runs.length, 0);
      assert.equal(imported.status, 'done');
      const receipt = imported.sharedCompletion!.receipt;
      // Путь clone в тождество не входит: отправитель и получатель — разные каталоги.
      assert.notEqual(a.repo, b.repo);
      assert.equal(
        receipt.gateIdentity,
        gateIdentity(a.h.config, 'main', receipt.requiredGates),
        'receipt несёт тождество проверок отправителя',
      );
      const head = git(b.repo, 'rev-parse', 'HEAD');
      if (mode === 'unchanged') {
        assert.doesNotThrow(() => b.h.accept(board.id, head));
        assert.ok(b.store.read().boards[0].revisions[0].snapshot, mode);
      } else {
        assert.throws(
          () => b.h.accept(board.id, head),
          /Полный набор проверок не пройден: main: test.*нужна перепроверка/,
          mode,
        );
        const revision = b.store.read().boards[0].revisions[0];
        assert.equal(revision.status, 'active', mode);
        assert.equal(revision.snapshot, undefined, mode);
        assert.equal(b.store.read().tasks.find((t) => t.id === task.id)!.status, 'done');
      }
    }
  } finally {
    p.cleanup();
  }
});

test('Тождество gates receipt: команда, тип, отчёт, окружение и потребители входят; абсолютные пути clone — нет', () => {
  const base = config({ repository: '/one/app', workspaceRoot: '/one' });
  const other = config({ repository: '/two/elsewhere/app', workspaceRoot: '/two/elsewhere' });
  const id = gateIdentity(base, 'main', ['test'])!;
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(gateIdentity(other, 'main', ['test']), id, 'пути workspace и репозитория не входят');
  assert.equal(gateIdentity(base, 'main', ['test', 'test']), id, 'порядок и повтор ID не важны');
  const variants: [string, (c: typeof base) => void][] = [
    ['command', (c) => (c.gates[0].command = ['node', 'other.mjs'])],
    ['timeout', (c) => (c.gates[0].timeoutMs = 1)],
    ['kind', (c) => (c.gates[0].kind = c.gates[0].kind === 'test' ? 'check' : 'test')],
    ['cwd', (c) => (c.gates[0].cwd = 'sub')],
    ['report', (c) => (c.gates[0].report = { type: 'junit', path: '.reports/other.xml' })],
    [
      'environment value',
      (c) => (c.environment = { inherit: [], values: { MODE: 'x' }, secrets: {} }),
    ],
    [
      'environment secret',
      (c) => (c.environment = { inherit: [], values: {}, secrets: { TOKEN: 'T' } }),
    ],
  ];
  for (const [name, change] of variants) {
    const c = structuredClone(base);
    change(c);
    assert.notEqual(gateIdentity(c, 'main', ['test']), id, name);
  }
  // Абсолютный путь в значении окружения — путь clone, а не другая проверка.
  const p1 = structuredClone(base);
  p1.environment = { inherit: [], values: { CACHE: '/one/cache' }, secrets: {} };
  const p2 = structuredClone(base);
  p2.environment = { inherit: [], values: { CACHE: '/two/cache' }, secrets: {} };
  assert.equal(gateIdentity(p1, 'main', ['test']), gateIdentity(p2, 'main', ['test']));
  assert.notEqual(
    gateIdentity(base, 'main', ['test'], [{ repositoryId: 'main', gates: ['test'] }]),
    id,
    'проверки потребителей входят',
  );
  // Псевдо-gate без декларации — по ID: другой состав — другое тождество.
  const pseudo = gateIdentity(base, 'main', ['test', 'requirement-source']);
  assert.ok(pseudo && pseudo !== id);
  assert.equal(gateIdentity(base, 'absent-component', ['test']), undefined);
});
