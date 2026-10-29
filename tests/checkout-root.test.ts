import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { checkoutCacheBase } from 'devcontour-harness';
import { configSchema, type Config } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { adapters } from '../src/runner/adapters.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { checkBase } from '../src/runner/base-check.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { checkoutsCheck } from '../src/runner/doctor.ts';
import { workspaceCheckoutRoot } from '../src/runner/checkout-root.ts';
import { recoveryBoundary } from '../src/runner/recovery.ts';
import { git } from '../src/runner/process.ts';
import { loadConfig } from '../src/runner/config.ts';
import { testDemo } from './demo-pool.ts';
import { fixture, withTestHome } from './helpers.ts';

const within = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * Встроенное размещение: каталог данных контура — внутри репозитория
 * (`<W>/.devcontour-local`). Gate проверяет, что запущен под ожидаемым
 * корнем рабочих деревьев: тот же gate исполняют попытки планировщика и
 * проверка базы (`runGatesAt`), так что неверный корень любого из них —
 * провал gate.
 */
async function embedded(checkoutRoot?: string) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-checkouts-')));
  const repo = join(tmp, 'w');
  const data = join(repo, '.devcontour-local');
  await mkdir(data, { recursive: true });
  await writeFile(join(repo, '.gitignore'), '.reports/\n.devcontour-local/\n');
  await writeFile(join(repo, 'base.txt'), 'base\n');
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-gpg-sign', '-m', 'init');
  let expected = '';
  const gate = () => [
    process.execPath,
    '-e',
    `const fs=require('fs');const ok=process.cwd().startsWith(${JSON.stringify(expected + sep)});fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="root">'+(ok?'':'<failure message="'+process.cwd()+'"/>')+'</testcase></testsuite>');process.exit(ok?0:1)`,
  ];
  const make = (): Config =>
    configSchema.parse({
      version: 1,
      name: 'Embedded',
      repository: repo,
      mode: 'demo',
      concurrency: 1,
      roles: {
        architect: { runtime: 'demo' },
        backend: { runtime: 'demo' },
        frontend: { runtime: 'demo' },
        qa: { runtime: 'demo' },
      },
      reviewer: { runtime: 'demo' },
      gates: [
        {
          id: 'root-gate',
          kind: 'test',
          timeoutMs: 20000,
          command: gate(),
          report: { type: 'junit', path: '.reports/root.xml' },
        },
      ],
      ...(checkoutRoot ? { checkoutRoot } : {}),
    });
  const store = new Store(join(data, 'state.sqlite'));
  const config = make();
  const h = new DevContour(store, config);
  const choice = workspaceCheckoutRoot(h);
  assert.ok(choice.root, 'корень вне дерева выбран');
  expected = choice.root;
  // Gate закрепляет ожидаемый корень в своей команде.
  config.gates[0].command = gate();
  const worktrees = () =>
    execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));
  return {
    tmp,
    repo,
    data,
    store,
    h,
    config,
    choice,
    worktrees,
    cleanup: async () => {
      store.close();
      // Удаляется только свой временный каталог (кэш пользователя в тесте —
      // внутри него, см. withTestHome).
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

async function exercise(f: Awaited<ReturnType<typeof embedded>>) {
  const { h, repo, data, choice, worktrees } = f;
  const seen: { cwd: string; trees: string[] }[] = [];
  const scheduler = new Scheduler(h, data, {
    ...adapters,
    demo: {
      ...adapters.demo,
      execute: async (request) => {
        seen.push({ cwd: request.cwd, trees: worktrees() });
        return adapters.demo.execute(request);
      },
    },
  });
  await scheduler.init();
  const board = h.createBoard('Корень рабочих деревьев', '', 'main');
  h.addTask(board.id, {
    title: 'Проверить место checkout',
    description: 'Попытка и её gate идут под корнем рабочих деревьев workspace.',
    role: 'qa',
    acceptance: ['Gate запущен под корнем рабочих деревьев.'],
  });
  h.approve(board.id);
  h.pause(false);
  await scheduler.drain();
  await scheduler.stop();
  const run = h.store.read().runs.at(-1)!;
  assert.equal(run.status, 'succeeded', JSON.stringify(run.error ?? run));
  assert.ok(seen.length, 'исполнитель вызван');
  for (const s of seen) {
    assert.ok(within(s.cwd, choice.root!), `попытка под корнем: ${s.cwd}`);
    for (const tree of s.trees.filter((t) => t !== repo))
      assert.ok(!within(tree, repo), `рабочее дерево не внутри репозитория: ${tree}`);
  }

  // Перенос базы со слиянием: дерево слияния — под тем же корнем.
  await writeFile(join(repo, 'base.txt'), 'moved\n');
  await git(repo, 'add', 'base.txt');
  await git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-gpg-sign', '-m', 'move');
  h.holdForBaseUpdate();
  const merges: string[][] = [];
  const moved = await updateBase(f.config, data, undefined, async (path, ref, to, from) => {
    merges.push(worktrees().filter((t) => t !== repo));
    await git(path, 'update-ref', ref, to, from);
  });
  assert.equal(moved.updated[0]?.kind, 'merge', 'линии разошлись — перенос слиянием');
  assert.equal(merges.length, 1);
  assert.ok(merges[0].length, 'дерево слияния существовало во время сдвига');
  for (const tree of merges[0])
    assert.ok(within(tree, choice.root!), `дерево слияния под корнем: ${tree}`);
  h.baseUpdated(
    moved.updated.map((u) => ({ repositoryId: u.repositoryId, from: u.from, to: u.to })),
  );

  // Проверка базы (`runGatesAt`) — gate прошёл, значит, запущен под тем же корнем.
  assert.equal(await checkBase(h, { data, state: data }, () => {}), true);
  const passed = h.store.allEvents().filter((e) => e.type === 'base.check.passed');
  assert.equal(passed.length, 1, 'проверка базы прошла под корнем рабочих деревьев');

  // В дереве человека рабочих деревьев не осталось и не создавалось.
  assert.deepEqual(worktrees(), [repo]);
  for (const kind of ['worktrees', 'dependencies', 'review-checkouts', 'consumers'])
    assert.equal(existsSync(join(data, kind)), false, `${kind} не в каталоге данных`);
  // В каталоге состояния проверки на SHA — только её артефакты и логи.
  for (const id of readdirSync(join(data, 'gates-at')))
    assert.deepEqual(readdirSync(join(data, 'gates-at', id)), ['artifacts']);
  assert.ok(existsSync(join(choice.root!, 'main')), 'деревья создавались под корнем');
}

test('Embedded workspace: попытки, перенос и проверка базы — под одним корнем в кэше пользователя; doctor его называет', () =>
  withTestHome(async (home) => {
    const f = await embedded();
    try {
      assert.ok(within(checkoutCacheBase(), home), 'кэш пользователя — в подменённом HOME');
      assert.equal(f.choice.placement, 'cache');
      assert.ok(within(f.choice.root!, checkoutCacheBase()), f.choice.root);
      assert.ok(!within(f.choice.root!, f.repo));
      // Корень не зависит от каталога состояния вызова: каталог доски
      // компонента внутри репозитория даёт тот же корень.
      const doctor = checkoutsCheck(f.config, f.data);
      assert.equal(doctor.status, 'passed');
      assert.match(doctor.detail, /кэше пользователя/);
      assert.ok(doctor.detail.includes(f.choice.root!), doctor.detail);
      await exercise(f);
    } finally {
      await f.cleanup();
    }
  }));

test('Embedded workspace: заданный checkoutRoot получают планировщик, проверка базы и перенос базы', async () => {
  const configured = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-checkout-root-')));
  const f = await embedded(configured);
  try {
    assert.equal(f.choice.placement, 'configured');
    assert.equal(f.choice.root, configured);
    const doctor = checkoutsCheck(f.config, f.data);
    assert.equal(doctor.status, 'passed');
    assert.ok(doctor.detail.includes(configured), doctor.detail);
    await exercise(f);
  } finally {
    await f.cleanup();
    await rm(configured, { recursive: true, force: true });
  }
});

test('checkoutRoot внутри репозитория: doctor блокирует с причиной, загрузка конфигурации отказывает понятно', async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-checkout-doctor-')));
  try {
    const repo = join(tmp, 'w');
    await mkdir(repo, { recursive: true });
    const config = configSchema.parse({
      version: 1,
      name: 'Inside',
      repository: repo,
      mode: 'demo',
      roles: { qa: { runtime: 'demo' } },
      reviewer: { runtime: 'demo' },
      gates: [
        {
          id: 'test',
          kind: 'test',
          command: ['node', 'x'],
          report: { type: 'junit', path: '.reports/x.xml' },
        },
      ],
      checkoutRoot: join(repo, 'trees'),
    });
    const check = checkoutsCheck(config, join(repo, '.devcontour-local'));
    // harness отклоняет такой корень: doctor называет причину блокировкой,
    // загрузка конфигурации — понятной ошибкой, а не сбоем процесса.
    assert.equal(check.status, 'blocked');
    assert.match(check.detail, /Недопустимый checkoutRoot в config\.json: checkoutRoot .* внутри/);
    const data = join(repo, '.devcontour-local');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'config.json'), JSON.stringify(config));
    assert.throws(() => loadConfig(join(data, 'config.json')), /Недопустимый checkoutRoot/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Стандартные фикстуры тестов не пишут в настоящий кэш пользователя', async () => {
  // Настоящий кэш — до любой подмены HOME; каталог этой фикстуры в нём
  // назывался бы хэшем её каталога данных.
  const cache = checkoutCacheBase();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-fixture-cache-')));
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
  try {
    await testDemo(root);
    const config = loadConfig(join(root, 'config.json'));
    const store = new Store(join(root, 'state.sqlite'));
    try {
      const h = new DevContour(store, config);
      const choice = workspaceCheckoutRoot(h);
      assert.equal(choice.placement, 'configured');
      assert.ok(!within(choice.root!, cache), choice.root);
      assert.ok(!within(choice.root!, root), 'не внутри каталога данных');
      // Демо прогнало очередь: попытки были, а в кэше пользователя их нет.
      assert.ok(store.read().runs.some((r) => r.status === 'succeeded'));
      assert.equal(existsSync(join(cache, hash)), false, 'нет каталога фикстуры в кэше');
    } finally {
      store.close();
    }
    const f = fixture();
    try {
      const own = workspaceCheckoutRoot(f.h);
      assert.equal(own.placement, 'configured');
      assert.ok(!within(own.root!, cache), own.root);
    } finally {
      f.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Граница аналитика разбора закрывает корень рабочих деревьев', () => {
  const f = fixture();
  try {
    const trees = workspaceCheckoutRoot(f.h).root!;
    const boundary = recoveryBoundary(f.h, f.root, '/repo');
    assert.ok(boundary.hidden.includes(f.root));
    assert.ok(boundary.hidden.includes(trees), 'попытки и .joint закрыты');
    assert.deepEqual(boundary.readable, ['/repo']);
  } finally {
    f.cleanup();
  }
});
