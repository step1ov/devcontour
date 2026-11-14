import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { demoPool, testDemo } from './demo-pool.ts';
import { config as testConfig, removeTestCheckoutRoot, testCheckoutRoot } from './helpers.ts';
import { repositorySchema, type Config } from '../src/core/model.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { git } from '../src/runner/process.ts';
import { BASE_CHECK, checkBase, type BaseCheck } from '../src/runner/base-check.ts';

const demos = demoPool(testDemo);
after(() => demos.close());

/** Test gate: passes while every named file holds `ok`; junit at `.reports/<id>.xml`. */
const gate = (id: string, files: string[], when?: string[]) => ({
  id,
  kind: 'test' as const,
  timeoutMs: 10000,
  command: [
    process.execPath,
    '-e',
    `const fs=require('fs');const ok=${JSON.stringify(files)}.every((f)=>fs.readFileSync(f,'utf8').trim()==='ok');fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="${id}">'+(ok?'':'<failure message="broken"/>')+'</testcase></testsuite>');process.exit(ok?0:1)`,
    // A file named in argv is an implicit input of the gate (harness rule).
    'fixtures/data.txt',
  ],
  report: { type: 'junit' as const, path: `.reports/${id}.xml` },
  ...(when ? { when: { paths: when } } : {}),
});

/** Base-check harness over one or more repositories: commit, move the run base, check. */
function bench(h: DevContour, store: Store, roots: { data: string; state: string }) {
  const events = (type: string, repositoryId?: string) =>
    store
      .allEvents()
      .filter((e) => e.type === type)
      .map((e) => e.data as Record<string, unknown>)
      .filter((d) => !repositoryId || d.repositoryId === repositoryId);
  const last = (type: string, repositoryId?: string) => events(type, repositoryId).at(-1)!;
  const repoOf = (id: string) =>
    id === 'main' && !h.config.repositories.length
      ? { path: h.config.repository, targetBranch: h.config.targetBranch }
      : h.config.repositories.find((r) => r.id === id)!;
  /**
   * Commit on the repository's checked-out branch and move its run base onto
   * it (base-update in agent mode). `files` are written, `mv` renamed and
   * `rm` deleted with git.
   */
  const commit = async (
    repositoryId: string,
    change: { files?: Record<string, string>; mv?: [string, string][]; rm?: string[] },
  ) => {
    const { path } = repoOf(repositoryId);
    for (const [file, content] of Object.entries(change.files ?? {})) {
      await mkdir(dirname(join(path, file)), { recursive: true });
      await writeFile(join(path, file), content);
      await git(path, 'add', '--', file);
    }
    for (const [from, to] of change.mv ?? []) {
      await mkdir(dirname(join(path, to)), { recursive: true });
      await git(path, 'mv', from, to);
    }
    for (const file of change.rm ?? []) await git(path, 'rm', '-q', file);
    await git(path, 'commit', '-qm', 'Change');
    return git(path, 'rev-parse', 'HEAD');
  };
  const moveTo = async (repositoryId: string, sha: string) => {
    const { path, targetBranch } = repoOf(repositoryId);
    const target = 'refs/heads/' + targetBranch;
    const from = await git(path, 'rev-parse', target);
    await git(path, 'update-ref', target, sha);
    return { repositoryId, from, to: sha };
  };
  const move = async (
    repositoryId: string,
    change: Parameters<typeof commit>[1],
    alsoMove: { repositoryId: string; from: string; to: string }[] = [],
  ) => {
    h.holdForBaseUpdate();
    const sha = await commit(repositoryId, change);
    h.baseUpdated([...alsoMove, await moveTo(repositoryId, sha)]);
    return sha;
  };
  const check = async (repositoryId = 'main') => {
    const passed = await checkBase(h, roots, () => {});
    return { passed, started: last('base.check.started', repositoryId) };
  };
  /** Rewrite every base-check record of a repository (simulates other versions or ages). */
  const tamperAll = (repositoryId: string, change: (r: BaseCheck) => BaseCheck) =>
    store.atomic(() => {
      for (const [sha, rec] of Object.entries(
        store.localRecords<BaseCheck>(BASE_CHECK, repositoryId),
      ))
        store.saveLocal(BASE_CHECK, repositoryId, sha, change(rec));
    });
  return { events, last, commit, moveTo, move, check, tamperAll, repoOf };
}

test('Проверка базы переносит результат gate с when.paths, чьих путей и неявных входов diff от прошедшей проверки предка не задел (D51)', async () => {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  config.gates = [
    gate('plain', ['base.txt']),
    gate('slow', ['src/value.txt', 'fixtures/data.txt'], ['src/**']),
  ];
  const store = new Store(join(root, 'base-check-carry.sqlite'));
  const h = new DevContour(store, config);
  const b = bench(h, store, { data: root, state: root });
  const { last, check, tamperAll } = b;
  const move = (files: Record<string, string>) => b.move('main', { files });
  const target = 'refs/heads/' + config.targetBranch;
  const head = () => git(config.repository, 'rev-parse', target);
  try {
    h.pause(false);
    // First check: no passed ancestor, the whole profile runs.
    const first = await move({
      'base.txt': 'ok',
      'src/value.txt': 'ok',
      'fixtures/data.txt': 'ok',
    });
    let r = await check();
    assert.equal(r.passed, true);
    assert.deepEqual(r.started.gates, ['plain', 'slow']);
    assert.equal(r.started.carried, undefined);

    // A Markdown-only commit: the conditional gate is carried, the plain one runs.
    const docs = await move({ 'README.md': '# Notes\n' });
    r = await check();
    assert.equal(r.passed, true, 'carried gate and passed plain gate lift the wait');
    assert.deepEqual(r.started.gates, ['plain']);
    assert.deepEqual(r.started.carried, ['slow']);
    assert.equal(r.started.anchor, first);
    let passed = last('base.check.passed');
    assert.deepEqual(passed.gates, ['plain']);
    assert.deepEqual(passed.carried, [
      {
        gate: 'slow',
        from: first,
        count: 1,
        files: ['README.md'],
        pathsDigest: (passed.carried as { pathsDigest: string }[])[0].pathsDigest,
      },
    ]);
    // The lift names what it relied on.
    assert.deepEqual(last('base.checked').carried, [
      { repositoryId: 'main', sha: docs, gates: ['slow'] },
    ]);
    const record = store.localRecord<BaseCheck>(BASE_CHECK, 'main', docs)!;
    assert.equal(record.passed, true);
    assert.deepEqual(
      record.evidence.map((e) => [
        e.gate,
        e.sha === first ? 'first' : e.sha === docs ? 'docs' : '?',
      ]),
      [
        ['plain', 'docs'],
        ['slow', 'first'],
      ],
      'carried evidence keeps the SHA it ran on',
    );
    assert.equal(record.carried?.[0].anchor, first);

    // Chain: the diff is taken from the SHA the gate ran on, not from the last check.
    await move({ 'notes.md': 'more\n' });
    r = await check();
    assert.deepEqual(r.started.carried, ['slow']);
    passed = last('base.check.passed');
    assert.deepEqual((passed.carried as { from: string; files: string[] }[])[0], {
      ...(passed.carried as object[])[0],
      from: first,
      files: ['README.md', 'notes.md'],
    });

    // A change in the gate's paths runs it (and the broken base fails).
    await move({ 'src/value.txt': 'broken' });
    r = await check();
    assert.equal(r.passed, false);
    assert.deepEqual(r.started.gates, ['plain', 'slow']);
    assert.match(
      store.read().waits?.find((w) => w.kind === 'base-check')?.detail ?? '',
      /main\/slow/,
    );
    // Fixed base: the last passed ancestor's diff touches src/, so the gate runs.
    await move({ 'src/value.txt': 'ok\n' });
    r = await check();
    assert.equal(r.passed, true);
    assert.deepEqual(r.started.gates, ['plain', 'slow']);

    // An implicit input outside `when.paths` (a path named in the command) runs the gate.
    await move({ 'fixtures/data.txt': 'broken' });
    r = await check();
    assert.equal(r.passed, false, 'implicit input change is checked, not carried');
    assert.deepEqual(r.started.gates, ['plain', 'slow']);
    await move({ 'fixtures/data.txt': 'ok\n' });
    assert.equal((await check()).passed, true);

    // A failure observed after the source check is not covered by a carry: an
    // exact revert of the gate's paths (plus a docs change) still runs the gate.
    await move({ 'src/value.txt': 'broken' });
    assert.equal((await check()).passed, false);
    await move({ 'src/value.txt': 'ok\n', 'docs/revert.md': 'x\n' });
    r = await check();
    assert.equal(r.passed, true);
    assert.deepEqual(r.started.gates, ['plain', 'slow'], 'a newer failure blocks the carry');

    // Each anchor condition alone: rewrite every record, then a docs-only move.
    // A fresh check always runs everything here, so the next case starts clean.
    const cases: [string, (rec: BaseCheck) => BaseCheck][] = [
      ['moved provider', (rec) => ({ ...rec, providers: { provider: 'f'.repeat(40) } })],
      ['legacy record without basis', (rec) => ({ ...rec, basis: undefined })],
      ['another DevContour version', (rec) => ({ ...rec, devcontour: 'devcontour@0.0.0' })],
      // Same contract digest, other gate basis (toolchain, dependency store, harness).
      ['another gate basis', (rec) => ({ ...rec, basis: { ...rec.basis, slow: 'other' } })],
      [
        'evidence older than the carry limit',
        (rec) => ({
          ...rec,
          evidence: rec.evidence.map((e) => ({
            ...e,
            createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
          })),
        }),
      ],
    ];
    for (const [why, change] of cases) {
      tamperAll('main', change);
      await move({ [`docs/${why.replaceAll(' ', '-')}.md`]: 'x\n' });
      r = await check();
      assert.equal(r.passed, true, why);
      assert.deepEqual(r.started.gates, ['plain', 'slow'], why + ' carries nothing');
      assert.equal(r.started.anchor, undefined, why);
    }
    // Control: the same docs-only move without tampering carries.
    const control = await head();
    await move({ 'docs/control.md': 'x\n' });
    r = await check();
    assert.deepEqual(r.started.carried, ['slow'], 'control move carries');
    assert.equal(r.started.anchor, control);

    // Rename into and delete inside `when.paths` run the gate.
    await move({ 'docs/moved.md': 'x\n' });
    assert.deepEqual((await check()).started.carried, ['slow']);
    await b.move('main', { mv: [['docs/moved.md', 'src/moved.md']] });
    r = await check();
    assert.deepEqual(r.started.gates, ['plain', 'slow'], 'rename into src/ runs the gate');
    await b.move('main', { rm: ['src/moved.md'] });
    r = await check();
    assert.deepEqual(r.started.gates, ['plain', 'slow'], 'delete in src/ runs the gate');
    // Rename out of src/ touches the old path too.
    await move({ 'src/out.md': 'x\n' });
    await check();
    await b.move('main', { mv: [['src/out.md', 'docs/out.md']] });
    r = await check();
    assert.deepEqual(r.started.gates, ['plain', 'slow'], 'rename out of src/ runs the gate');

    // A sensitive path of the contour (a registered contract artifact) held the
    // move, and the operator lifted it without gates. The next docs-only move
    // carries nothing across that range: every conditional gate runs.
    store.change('fixture.contract', (s) => {
      s.contracts.push({
        id: 'C-orders',
        title: 'Orders',
        source: 'contracts/orders.md',
        repositoryId: 'main',
        artifacts: [{ repositoryId: 'main', path: 'spec/orders.txt', blob: '0'.repeat(40) }],
      } as never);
    });
    await move({ 'spec/orders.txt': 'weakened\n' });
    assert.equal(await checkBase(h, { data: root, state: root }, () => {}), false);
    assert.match(
      store.read().waits?.find((w) => w.kind === 'base-check')?.detail ?? '',
      /main:spec\/orders\.txt/,
    );
    h.pause(false); // the operator's «Подтвердить и запустить» / queue --start
    await move({ 'README.md': '# After the lift\n' });
    r = await check();
    assert.equal(r.passed, true);
    assert.deepEqual(r.started.gates, ['plain', 'slow'], 'nothing carried across the lift');
    assert.deepEqual(r.started.carryBlocked, ['spec/orders.txt']);
    // Once a check ran on top of the lift, carrying resumes.
    await move({ 'README.md': '# Later\n' });
    assert.deepEqual((await check()).started.carried, ['slow']);
    store.change('fixture.contract', (s) => {
      s.contracts = s.contracts.filter((c) => c.id !== 'C-orders');
    });

    // Prerequisites of a running gate run even when their own paths are untouched.
    config.gates = [
      {
        id: 'prep',
        kind: 'check',
        timeoutMs: 10000,
        command: [process.execPath, '-e', 'process.exit(0)'],
        when: { paths: ['src/**'] },
      },
      gate('plain', ['base.txt']),
      gate('slow', ['src/value.txt', 'fixtures/data.txt'], ['src/**']),
    ] as Config['gates'];
    await move({ 'docs/prep.md': 'x\n' });
    r = await check();
    assert.equal(r.started.carried, undefined, 'a changed contract runs the profile again');
    await move({ 'docs/prep-2.md': 'x\n' });
    r = await check();
    assert.equal(r.passed, true);
    assert.deepEqual(r.started.carried, ['slow']);
    assert.deepEqual(r.started.gates, ['prep', 'plain'], 'prep is a prerequisite of plain');

    // A newer passed check that is not an ancestor of the new base (the base
    // was moved sideways) is no anchor; the search falls back to an ancestor.
    const fork = await head();
    await git(config.repository, 'checkout', '-q', '--detach', fork);
    const side = await b.commit('main', { files: { 'docs/side.md': 'x\n' } });
    h.holdForBaseUpdate();
    h.baseUpdated([await b.moveTo('main', side)]);
    r = await check();
    assert.equal(r.started.anchor, fork);
    await git(config.repository, 'checkout', '-q', '--detach', fork);
    const other = await b.commit('main', { files: { 'docs/other.md': 'x\n' } });
    h.holdForBaseUpdate();
    h.baseUpdated([await b.moveTo('main', other)]);
    r = await check();
    assert.deepEqual(r.started.carried, ['slow']);
    assert.equal(r.started.anchor, fork, 'the newer sideways check is skipped');
  } finally {
    store.close();
    seed.release();
  }
});

test('Проверка базы: сдвиг поставщика проверяет потребителя заново и не даёт переносить его результаты (D51)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-carry-providers-'));
  const checkouts = testCheckoutRoot();
  const repos = [];
  for (const id of ['lib', 'app']) {
    const path = join(root, id);
    await mkdir(path);
    await git(path, 'init', '-q', '-b', 'main');
    await writeFile(join(path, '.gitignore'), '.reports/\n.deps/\n');
    for (const f of ['base.txt', 'src/value.txt', 'fixtures/data.txt']) {
      await mkdir(dirname(join(path, f)), { recursive: true });
      await writeFile(join(path, f), 'ok');
    }
    await git(path, 'add', '.');
    await git(path, 'commit', '-qm', 'baseline');
    await git(path, 'branch', 'devcontour/accepted');
    repos.push(
      repositorySchema.parse({
        id,
        name: id,
        kind: id === 'app' ? 'product' : 'library',
        path,
        dependsOn: id === 'app' ? ['lib'] : [],
        protectedPaths: ['.gitignore'],
        gates:
          id === 'app'
            ? [
                gate('plain', ['base.txt']),
                gate('slow', ['src/value.txt', 'fixtures/data.txt'], ['src/**']),
              ]
            : [gate('libtest', ['base.txt'])],
      }),
    );
  }
  const data = join(root, 'data');
  await mkdir(data);
  const c = testConfig({
    repository: repos[1].path,
    repositories: repos,
    checkoutRoot: checkouts,
  });
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(store, c);
  const b = bench(h, store, { data, state: data });
  const appChecks = () => b.events('base.check.started', 'app').length;
  try {
    assert.equal(c.approvalMode, 'agent');
    h.pause(false);
    await b.move('app', { files: { 'docs/a.md': 'x\n' } });
    let r = await b.check('app');
    assert.equal(r.passed, true);
    assert.deepEqual(r.started.gates, ['plain', 'slow']);
    const lib1 = await git(repos[0].path, 'rev-parse', 'refs/heads/devcontour/accepted');
    assert.deepEqual(
      store.localRecord<BaseCheck>(
        BASE_CHECK,
        'app',
        await git(repos[1].path, 'rev-parse', 'refs/heads/devcontour/accepted'),
      )?.providers,
      { lib: lib1 },
    );

    // Only the provider moves: the consumer's same-SHA pass is not reused.
    const before = appChecks();
    await b.move('lib', { files: { 'base.txt': 'ok\n' } });
    r = await b.check('app');
    assert.equal(r.passed, true);
    assert.equal(appChecks(), before + 1, 'the consumer is checked again');
    assert.deepEqual(r.started.gates, ['plain', 'slow']);

    // Control: a consumer docs move with the provider still carries.
    await b.move('app', { files: { 'docs/b.md': 'x\n' } });
    r = await b.check('app');
    assert.deepEqual(r.started.carried, ['slow']);

    // Provider and consumer docs move together: nothing is carried.
    h.holdForBaseUpdate();
    const libMove = await b.moveTo('lib', await b.commit('lib', { files: { 'lib.md': 'x\n' } }));
    const appMove = await b.moveTo('app', await b.commit('app', { files: { 'docs/c.md': 'x\n' } }));
    h.baseUpdated([libMove, appMove]);
    r = await b.check('app');
    assert.equal(r.passed, true);
    assert.equal(r.started.carried, undefined, 'a moved provider carries nothing');
    assert.deepEqual(r.started.gates, ['plain', 'slow']);
  } finally {
    store.close();
    removeTestCheckoutRoot(checkouts);
    // Own mkdtemp directory under the system temporary root only.
    assert.ok(root.startsWith(join(tmpdir(), 'devcontour-carry-providers-')));
    await rm(root, { recursive: true, force: true });
  }
});
