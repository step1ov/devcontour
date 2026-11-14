import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { demoPool, testDemo } from './demo-pool.ts';
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
  const roots = { data: root, state: root };
  const target = 'refs/heads/' + config.targetBranch;
  const events = (type: string) =>
    store
      .allEvents()
      .filter((e) => e.type === type)
      .map((e) => e.data as Record<string, unknown>);
  const last = (type: string) => events(type).at(-1)!;
  /** Commit on the work branch and move the run base onto it (base-update in agent mode). */
  const move = async (files: Record<string, string>) => {
    h.holdForBaseUpdate();
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(config.repository, path)), { recursive: true });
      await writeFile(join(config.repository, path), content);
    }
    await git(config.repository, 'add', '--', ...Object.keys(files));
    await git(config.repository, 'commit', '-qm', 'Change ' + Object.keys(files).join(' '));
    const sha = await git(config.repository, 'rev-parse', 'HEAD');
    const from = await git(config.repository, 'rev-parse', target);
    await git(config.repository, 'update-ref', target, sha);
    h.baseUpdated([{ repositoryId: 'main', from, to: sha }]);
    return sha;
  };
  const check = async () => {
    const passed = await checkBase(h, roots, () => {});
    return { passed, started: last('base.check.started') };
  };
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
    // Fixed base: the failed check is no anchor; the last passed ancestor's diff
    // touches src/, so the gate runs.
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

    // Other provider bases (a dependency component moved) carry nothing.
    const tamper = async (change: (r: BaseCheck) => BaseCheck) => {
      const head = await git(config.repository, 'rev-parse', target);
      store.atomic(() =>
        store.saveLocal(
          BASE_CHECK,
          'main',
          head,
          change(store.localRecord<BaseCheck>(BASE_CHECK, 'main', head)!),
        ),
      );
    };
    await tamper((rec) => ({ ...rec, providers: { provider: 'f'.repeat(40) } }));
    await move({ 'HISTORY.md': 'x\n' });
    r = await check();
    assert.deepEqual(r.started.gates, ['plain', 'slow'], 'moved provider carries nothing');

    // Another gate basis (e.g. another harness version) under the same contract
    // carries nothing for that gate.
    const head = await git(config.repository, 'rev-parse', target);
    store.atomic(() => {
      const old = store.localRecord<BaseCheck>(BASE_CHECK, 'main', head)!;
      store.saveLocal(BASE_CHECK, 'main', head, {
        ...old,
        basis: { ...old.basis, slow: 'another-basis' },
      });
    });
    await move({ 'CHANGES.md': 'x\n' });
    r = await check();
    assert.deepEqual(r.started.gates, ['plain', 'slow'], 'another basis carries nothing');

    // A changed contract (gate definition) carries nothing: the profile runs again.
    config.gates = [
      gate('plain', ['base.txt']),
      { ...gate('slow', ['src/value.txt', 'fixtures/data.txt'], ['src/**']), timeoutMs: 20000 },
    ];
    await move({ 'docs/guide.md': 'guide\n' });
    r = await check();
    assert.equal(r.passed, true);
    assert.deepEqual(r.started.gates, ['plain', 'slow']);
    assert.equal(r.started.carried, undefined);
  } finally {
    store.close();
    seed.release();
  }
});
