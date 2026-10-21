import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/core/store.ts';
import { DevContour, digest } from '../src/core/service.ts';
import { repositories } from '../src/core/repositories.ts';
import {
  policyIdentity,
  policyRoots,
  policyVariants,
  portablePolicy,
  rootSpellings,
} from '../src/core/sync-state.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { loadConfig } from '../src/runner/config.ts';
import { configuredSpellings } from '../src/core/check-store.ts';
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
  function peer(
    name: string,
    source?: { workspace: string; repo: string },
    adjust?: (c: DevContour['config']) => void,
  ) {
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
    adjust?.(cfg);
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

/** Отправитель завершает задачу управляемыми evidence и публикует её штатным sync. */
function finishFixture(
  a: { h: DevContour; repo: string; workspace: string },
  beforeExport?: () => void,
) {
  a.h.approve(a.h.store.read().boards[0].id);
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
  beforeExport?.();
  syncGit(a.h, { member: 'sender' });
  for (const path of [a.repo, a.workspace]) {
    git(path, 'add', '.devcontour');
    git(path, 'commit', '-q', '-m', 'share completed task');
  }
}

test('T23/S3-R1-01: receipt подтверждает приёмку доски только теми же проверками — другая команда того же gate до или после импорта даёт отказ без snapshot', () => {
  const p = peers();
  try {
    const a = p.peer('sender');
    const board = a.h.createBoard('Received board', '', 'main');
    const task = a.h.addTask(board.id, input());
    finishFixture(a);
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
        policyIdentity(a.h.taskPolicyInput(imported), policyRoots(a.h)),
        'receipt несёт тождество договора отправителя',
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

// Входы проверки, кроме команды gate, которые меняют смысл проверки, и их
// смена у получателя до или после импорта. Каждый — отказ без snapshot.
type Cfg = DevContour['config'];
const inputs: [string, (c: Cfg, root: string) => void][] = [
  ['environment value', (c) => (c.environment!.values.ROUTE = '/v2')],
  [
    'data file under the repository',
    (c) => (c.environment!.values.DATA_FILE = join(c.repository, 'full.json')),
  ],
  ['secret source', (c) => (c.environment!.secrets.CHECK_ENDPOINT = 'ENDPOINT_B')],
  ['prepare step', (c) => (c.prepare![0].command = ['node', 'seed-full.mjs'])],
  ['lifecycle step', (c) => (c.lifecycle!.setup[0].command = ['node', 'other-server.mjs'])],
  ['resource value', (c) => ((c.resources[0] as { value: string }).value = 'full-database')],
];
function richConfig(c: Cfg) {
  c.environment = {
    inherit: [],
    values: { ROUTE: '/v1', DATA_FILE: join(c.repository, 'smoke.json') },
    secrets: { CHECK_ENDPOINT: 'ENDPOINT_A' },
  };
  c.prepare = [{ id: 'seed', command: ['node', 'seed-smoke.mjs'], timeoutMs: 1000 }];
  c.lifecycle = {
    setup: [{ id: 'start', command: ['node', 'mock-server.mjs'], timeoutMs: 1000 }],
    ready: [],
    teardown: [{ id: 'stop', command: ['node', 'stop.mjs'], timeoutMs: 1000 }],
  };
  c.resources = [
    { id: 'db', kind: 'service', value: 'smoke-database' },
  ] as unknown as Cfg['resources'];
  c.gates[0].resources = ['db'];
}

test('S3-R3-01: receipt не подтверждает приёмку, если у получателя изменён любой вход проверки — значение или файл окружения, источник секрета, подготовка, lifecycle, ресурс; перенос корней clone — подтверждает', () => {
  const p = peers();
  try {
    const a = p.peer('sender', undefined, richConfig);
    const board = a.h.createBoard('Received board', '', 'main');
    const task = a.h.addTask(board.id, input());
    finishFixture(a);
    for (const [name, change] of [['unchanged', () => {}] as const, ...inputs])
      for (const when of name === 'unchanged' ? ['none'] : ['before', 'after']) {
        const b = p.peer(`${name.replace(/\W+/g, '-')}-${when}`, a, richConfig);
        if (when === 'before') change(b.h.config, b.repo);
        syncGit(b.h, { member: 'receiver' });
        if (when === 'after') change(b.h.config, b.repo);
        const imported = b.store.read().tasks.find((t) => t.id === task.id)!;
        assert.equal(imported.status, 'done', name);
        assert.ok(imported.sharedCompletion, name);
        const head = git(b.repo, 'rev-parse', 'HEAD');
        if (name === 'unchanged') {
          assert.doesNotThrow(() => b.h.accept(board.id, head));
          assert.ok(b.store.read().boards[0].revisions[0].snapshot);
          continue;
        }
        assert.throws(() => b.h.accept(board.id, head), /нужна перепроверка/, `${name} ${when}`);
        assert.equal(b.store.read().boards[0].revisions[0].snapshot, undefined, `${name} ${when}`);
      }
  } finally {
    p.cleanup();
  }
});

test('Тождество договора receipt полно по построению: любое изменение записи договора меняет его, перенос корней clone — нет', () => {
  const h = new DevContour(
    new Store(':memory:'),
    config({ repository: '/one/ws/app', workspaceRoot: '/one/ws' }),
  );
  richConfig(h.config);
  const roots = policyRoots(h);
  const policy = h.policyInput('main');
  // Договор задачи и digest — из одной записи: тождество не может отстать от
  // того, что считается policyDigest.
  assert.equal(h.policyDigest('main'), digest(policy));
  const id = policyIdentity(policy, roots);
  assert.match(id, /^[a-f0-9]{64}$/);
  // Генератор вариантов: каждый лист и каждый ключ записи договора.
  let leaves = 0;
  type Node = Record<string, unknown> & unknown[];
  const at = (root: unknown, keys: (string | number)[]) =>
    keys.reduce<unknown>((o, key) => (o as Record<string | number, unknown>)[key], root) as Node;
  const walk = (value: unknown, path: (string | number)[]) => {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        // Ключ без значения не записывается ни в digest, ни в тождество.
        if (v === undefined) continue;
        const without = structuredClone(policy);
        const parent = at(without, path);
        if (Array.isArray(parent)) parent.splice(Number(k), 1);
        else delete parent[k];
        assert.notEqual(policyIdentity(without, roots), id, `без ${[...path, k].join('.')}`);
        walk(v, [...path, Array.isArray(value) ? Number(k) : k]);
      }
      return;
    }
    leaves++;
    const changed = structuredClone(policy);
    const parent = at(changed, path.slice(0, -1));
    const key = path.at(-1)!;
    parent[key] =
      typeof value === 'string'
        ? value + 'x'
        : typeof value === 'number'
          ? value + 1
          : typeof value === 'boolean'
            ? !value
            : 'changed';
    assert.notEqual(digest(changed), digest(policy), path.join('.'));
    assert.notEqual(policyIdentity(changed, roots), id, path.join('.'));
  };
  walk(policy, []);
  assert.ok(leaves > 20, `перебрано листьев: ${leaves}`);
  // Перенос корней: тот же договор в другом каталоге — то же тождество.
  const moved = new DevContour(
    new Store(':memory:'),
    config({ repository: '/two/elsewhere/app', workspaceRoot: '/two/elsewhere' }),
  );
  richConfig(moved.config);
  assert.equal(policyIdentity(moved.policyInput('main'), policyRoots(moved)), id);
  // Путь внутри корня сохраняет относительную часть; путь вне корней — как есть.
  assert.deepEqual(portablePolicy('/one/ws/app/smoke.json', roots), {
    $root: 'repository',
    path: 'smoke.json',
  });
  assert.notDeepEqual(
    portablePolicy('/one/ws/app/smoke.json', roots),
    portablePolicy('/one/ws/app/full.json', roots),
  );
  assert.equal(portablePolicy('/srv/data/smoke.json', roots), '/srv/data/smoke.json');
  // Варианты договора задачи: договор задачи, политика компонента, прежняя форма.
  const named = new DevContour(
    new Store(':memory:'),
    config({ repository: '/one/ws/app', workspaceRoot: '/one/ws' }),
  );
  const variants = policyVariants(named, { repositoryId: 'main' });
  assert.equal(variants.length, 3);
  assert.equal(policyVariants(named, { repositoryId: 'absent-component' }).length, 0);
});

// S3-R3-02: опубликованный receipt неизменяем, и повторный sync выпускает его
// байт в байт — после смены политики и после обновления с версии, чей
// receipt не нёс тождества. Обе топологии хранения.
const receiptFiles = (paths: string[]) =>
  Object.fromEntries(
    paths.flatMap((path) =>
      git(path, 'ls-files', '.devcontour')
        .split('\n')
        .filter((f) => f.includes('/receipts/'))
        .map((f) => [join(path, f), readFileSync(join(path, f), 'utf8')]),
    ),
  );
for (const storage of ['component', 'central'] as const)
  for (const transition of ['policy change', 'upgrade from a receipt without identity'] as const)
    test(`S3-R3-02 (${storage}, ${transition}): повторный sync не меняет выпущенный receipt и не блокируется`, () => {
      const p = peers();
      try {
        const a = p.peer('sender', undefined, (c) => (c.storage = storage));
        const board = a.h.createBoard('Accepted board', '', 'main');
        a.h.addTask(board.id, input());
        finishFixture(a);
        const owner = 'main';
        if (transition === 'upgrade from a receipt without identity') {
          // Receipt прежней версии: та же запись без поля gateIdentity — в Git
          // и в baseline синхронизации этого clone.
          for (const [file, text] of Object.entries(receiptFiles([a.repo, a.workspace]))) {
            const record = JSON.parse(text) as { data: Record<string, unknown> };
            assert.ok(record.data.gateIdentity, 'новая версия выпустила тождество');
            delete record.data.gateIdentity;
            writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
          }
          for (const path of [a.repo, a.workspace]) {
            git(path, 'add', '.devcontour');
            git(path, 'commit', '-q', '--allow-empty', '-m', 'receipt of the previous version');
          }
          const saved = a.store.syncBaseline(owner) as {
            records: Record<string, { kind: string; data: Record<string, unknown> }>;
          };
          for (const r of Object.values(saved.records))
            if (r.kind === 'receipt') delete r.data.gateIdentity;
          a.store.change('fixture.previous-receipt', () => a.store.saveSyncBaseline(owner, saved));
        } else a.h.config.gates[0].command = ['node', 'different-check.mjs'];
        const files = receiptFiles([a.repo, a.workspace]);
        assert.ok(Object.keys(files).length, 'receipt выпущен');
        const before = a.store.read();
        const result = syncGit(a.h, { member: 'sender' });
        assert.deepEqual(result.conflicts, []);
        assert.deepEqual(
          result.changes.filter((c) => c.key.startsWith('receipts/')),
          [],
          'receipt не переписан',
        );
        assert.deepEqual(receiptFiles([a.repo, a.workspace]), files, 'байты receipt прежние');
        const after = a.store.read();
        assert.deepEqual(after.runs, before.runs, 'evidence и попытки прежние');
        assert.deepEqual(after.boards, before.boards, 'ревизии и snapshot прежние');
        // Повтор идемпотентен.
        assert.deepEqual(syncGit(a.h, { member: 'sender' }).conflicts, []);
        assert.deepEqual(receiptFiles([a.repo, a.workspace]), files);
        // Получатель receipt без тождества импортирует его, но новую приёмку
        // по нему не подтверждает.
        if (transition === 'upgrade from a receipt without identity') {
          const b = p.peer('receiver', a, (c) => (c.storage = storage));
          syncGit(b.h, { member: 'receiver' });
          const imported = b.store.read().tasks[0];
          assert.equal(imported.status, 'done');
          assert.equal(imported.sharedCompletion!.receipt.gateIdentity, undefined);
          assert.throws(
            () => b.h.accept(board.id, git(b.repo, 'rev-parse', 'HEAD')),
            /нужна перепроверка/,
          );
          assert.equal(b.store.read().boards[0].revisions[0].snapshot, undefined);
        }
      } finally {
        p.cleanup();
      }
    });

// S3-R4-01: «внутри корня» — по физическому адресу. Путь, который через `..`
// или символическую ссылку выходит за корень, у другого clone может значить
// другой файл: он остаётся исходной строкой, и receipt требует перепроверки.
test('S3-R4-01: путь, выходящий за корень через `..` или ссылку, не переносится — receipt с ним требует перепроверки до и после импорта; путь внутри корня переносится', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-escaped-root-')));
  try {
    const repo = join(root, 'ws', 'app');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    symlinkSync(root, join(repo, 'outside'));
    const h = new DevContour(
      new Store(':memory:'),
      config({ repository: repo, workspaceRoot: join(root, 'ws') }),
    );
    const roots = policyRoots(h);
    // Путь с `..` или ссылкой не переносится, даже если физически он внутри
    // корня (S3-R5-01): у другого clone та же запись может значить другой файл.
    for (const raw of [
      // Строки собраны без join: join сам разобрал бы `..`.
      `${repo}/../../cases.json`,
      `${repo}/outside/cases.json`,
      `${repo}/outside/ws/../cases.json`,
      `${repo}/sub/../smoke.json`,
      `${repo}/../shared.json`,
    ])
      assert.equal(portablePolicy(raw, roots), raw, raw);
    assert.deepEqual(portablePolicy(`${repo}/sub/smoke.json`, roots), {
      $root: 'repository',
      path: 'sub/smoke.json',
    });
    assert.deepEqual(portablePolicy(`${root}/ws/shared.json`, roots), {
      $root: 'workspace',
      path: 'shared.json',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const p = peers();
  try {
    const external = (c: Cfg) => {
      c.environment = {
        inherit: [],
        values: { DATA_FILE: `${c.repository}/../cases.json` },
        secrets: {},
      };
    };
    const a = p.peer('sender', undefined, external);
    const board = a.h.createBoard('Received board', '', 'main');
    const task = a.h.addTask(board.id, input());
    finishFixture(a);
    assert.equal(
      typeof portablePolicy(a.h.config.environment!.values.DATA_FILE, policyRoots(a.h)),
      'string',
      'внешний путь отправителя не стал путём от корня',
    );
    const cases: [string, 'before' | 'after', (c: Cfg) => void][] = [
      ['same spelling', 'before', external],
      ['same spelling', 'after', external],
      [
        'absolute outside',
        'before',
        (c) => (c.environment!.values.DATA_FILE = resolve(c.repository, '..', 'cases.json')),
      ],
    ];
    for (const [name, when, change] of cases) {
      const b = p.peer(`${name.replace(/\W+/g, '-')}-${when}`, a, external);
      if (when === 'before') change(b.h.config);
      syncGit(b.h, { member: 'receiver' });
      if (when === 'after') change(b.h.config);
      const imported = b.store.read().tasks.find((t) => t.id === task.id)!;
      assert.equal(imported.status, 'done', name);
      assert.equal(b.store.read().runs.length, 0, name);
      const head = git(b.repo, 'rev-parse', 'HEAD');
      assert.throws(() => b.h.accept(board.id, head), /нужна перепроверка/, `${name} ${when}`);
      assert.equal(b.store.read().boards[0].revisions[0].snapshot, undefined, `${name} ${when}`);
    }
  } finally {
    p.cleanup();
  }
});

// S3-R5: переносится только буквальная запись `<корень>/<имя>/…`, без `.`,
// `..`, `//`, завершающего `/` и без символических ссылок среди существующих
// сегментов. Ошибиться правило может только в сторону перепроверки: ни одна
// пара физически разных входов не получает одну запись.
test('S3-R5: переносимость пути — только буквальная запись внутри корня; `..`, ссылки, `.`, `//` и `/` после файла остаются строкой, физически разные входы не совпадают', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-path-rule-')));
  try {
    const ws = join(root, 'ws');
    const repo = join(ws, 'app');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'cases.json'), '[]');
    writeFileSync(join(root, 'cases.json'), '[1]');
    symlinkSync(root, join(repo, 'link-out'));
    symlinkSync(join(repo, 'sub'), join(repo, 'link-in'));
    const h = new DevContour(
      new Store(':memory:'),
      config({ repository: repo, workspaceRoot: ws }),
    );
    const roots = policyRoots(h);
    const portable: [string, string, string][] = [
      [`${repo}/cases.json`, 'repository', 'cases.json'],
      [`${repo}/sub/missing/tail.json`, 'repository', 'sub/missing/tail.json'],
      [`${repo}`, 'repository', ''],
      [`${ws}/shared.json`, 'workspace', 'shared.json'],
      // Регистр не разбирается: другое написание — другая запись.
      [`${repo}/Cases.json`, 'repository', 'Cases.json'],
    ];
    // `/tmp` ↔ `/private/tmp`: оба написания корня дают одну запись.
    const alias = repo.startsWith('/private/') ? repo.slice('/private'.length) : undefined;
    if (alias) portable.push([`${alias}/cases.json`, 'repository', 'cases.json']);
    const raw = [
      `${repo}/../cases.json`,
      `${repo}/link-out/../cases.json`,
      `${repo}/link-in/../cases.json`,
      `${repo}/link-out/cases.json`,
      `${repo}/link-in/x.json`,
      `${repo}/./cases.json`,
      `${repo}//cases.json`,
      `${repo}/cases.json/`,
      `${repo}/sub/`,
      `${repo}/`,
      `${root}/cases.json`,
    ];
    for (const [value, name, path] of portable)
      assert.deepEqual(portablePolicy(value, roots), { $root: name, path }, value);
    for (const value of raw) assert.equal(portablePolicy(value, roots), value, value);
    // Совпадают только написания одного и того же входа.
    const out = [...portable.map(([v]) => v), ...raw].map((v) =>
      JSON.stringify(portablePolicy(v, roots)),
    );
    const same = alias ? [[0, portable.length - 1]] : [];
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        assert.equal(
          out[i] === out[j],
          same.some(([a, b]) => a === i && b === j),
          `${i}:${out[i]} / ${j}:${out[j]}`,
        );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // Независимые clone: ссылка перед `..` (S3-R5-01) и `/` после файла
  // (S3-R5-03) у отправителя — receipt не подтверждает приёмку ни до, ни после
  // импорта; обычный внутренний путь — подтверждает.
  const p = peers();
  try {
    const local = (c: Cfg) => join(c.repository, '.devcontour-local');
    const variants: [string, (c: Cfg) => string][] = [
      [
        'link before dotdot',
        (c) => {
          mkdirSync(local(c), { recursive: true });
          symlinkSync(resolve(c.repository, '..', '..'), join(local(c), 'link'));
          return `${local(c)}/link/../cases.json`;
        },
      ],
      ['trailing separator', (c) => `${c.repository}/cases.json/`],
    ];
    for (const [name, value] of variants) {
      const env = (c: Cfg) => {
        c.environment = { inherit: [], values: { DATA_FILE: value(c) }, secrets: {} };
      };
      const slug = name.replace(/\W+/g, '-');
      const a = p.peer(`${slug}-sender`, undefined, env);
      assert.equal(
        typeof portablePolicy(a.h.config.environment!.values.DATA_FILE, policyRoots(a.h)),
        'string',
        name,
      );
      const board = a.h.createBoard('Received board', '', 'main');
      const task = a.h.addTask(board.id, input());
      finishFixture(a);
      for (const when of ['before', 'after'] as const) {
        const b = p.peer(`${slug}-${when}`, a, when === 'before' ? env : undefined);
        syncGit(b.h, { member: 'receiver' });
        if (when === 'after') env(b.h.config);
        assert.equal(b.store.read().tasks.find((t) => t.id === task.id)!.status, 'done', name);
        assert.equal(b.store.read().runs.length, 0, name);
        const head = git(b.repo, 'rev-parse', 'HEAD');
        assert.throws(() => b.h.accept(board.id, head), /нужна перепроверка/, `${name} ${when}`);
        assert.equal(b.store.read().boards[0].revisions[0].snapshot, undefined, `${name} ${when}`);
      }
    }
    const plain = (c: Cfg) => {
      c.environment = {
        inherit: [],
        values: { DATA_FILE: `${c.repository}/cases.json` },
        secrets: {},
      };
    };
    const a = p.peer('plain-sender', undefined, plain);
    const board = a.h.createBoard('Received board', '', 'main');
    a.h.addTask(board.id, input());
    finishFixture(a);
    const b = p.peer('plain-receiver', a, plain);
    syncGit(b.h, { member: 'receiver' });
    b.h.accept(board.id, git(b.repo, 'rev-parse', 'HEAD'));
    assert.ok(
      b.store.read().boards[0].revisions[0].snapshot,
      'обычный внутренний путь переносится',
    );
  } finally {
    p.cleanup();
  }
});

// S3-R6: написание корня — только подтверждённое ФС. Догадка о написании
// (`/private/x` ↔ `/x`) и исходные написания конфигурации принимаются, лишь
// если ведут в тот же каталог; иначе путь под ними остаётся строкой.
test('S3-R6: корень-алиас переносит путь, только если ФС подтверждает, что это тот же каталог; исходное написание из config.json после loadConfig — тоже', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-root-alias-')));
  try {
    const repo = join(root, 'Product');
    const other = join(root, 'Other');
    for (const d of [repo, other]) {
      mkdirSync(d);
      writeFileSync(join(d, 'cases.json'), d === repo ? '[1]' : '[1,2]');
    }
    symlinkSync(repo, join(root, 'repo-alias'));
    const alias = join(root, 'repo-alias');
    // Догадка указывает на другой существующий каталог, на отсутствующий и на
    // настоящий алиас: принимается только последний.
    const guessed = (to: string) => () => to;
    for (const [to, accepted] of [
      [other, false],
      [join(root, 'missing'), false],
      [alias, true],
    ] as const)
      assert.equal(rootSpellings(repo, [], guessed(to)).includes(to), accepted, to);
    // Исходные написания конфигурации — те же правила.
    const spelled = rootSpellings(repo, [other, alias, join(root, 'missing')]);
    assert.ok(spelled.includes(alias));
    assert.ok(!spelled.includes(other));
    assert.ok(!spelled.includes(join(root, 'missing')));
    // Штатная догадка `/private`: каждое принятое написание — тот же каталог.
    const tmpRoot = mkdtempSync('/tmp/devcontour-private-alias-');
    try {
      for (const s of rootSpellings(tmpRoot))
        assert.equal(realpathSync(s), realpathSync(tmpRoot), s);
      if (!rootSpellings(tmpRoot).some((s) => s.startsWith('/private/')))
        assert.notEqual(
          (() => {
            try {
              return realpathSync('/private' + tmpRoot);
            } catch {
              return undefined;
            }
          })(),
          realpathSync(tmpRoot),
        );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }

    // loadConfig заменяет корень на физический; исходное написание из
    // config.json остаётся написанием корня (S3-R6-02).
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify(config({ repository: alias })));
    const loaded = loadConfig(file);
    assert.equal(loaded.repository, repo);
    const h = new DevContour(new Store(':memory:'), loaded);
    const roots = policyRoots(h);
    const expected = { $root: 'repository', path: 'cases.json' };
    assert.deepEqual(portablePolicy(`${alias}/cases.json`, roots), expected);
    assert.deepEqual(portablePolicy(`${repo}/cases.json`, roots), expected);
    assert.equal(portablePolicy(`${other}/cases.json`, roots), `${other}/cases.json`);
    // Неподтверждённое написание в config.json: корень перенаправлен — исходное
    // написание ведёт в другой каталог и корнем больше не считается.
    unlinkSync(alias);
    symlinkSync(other, alias);
    assert.equal(portablePolicy(`${alias}/cases.json`, policyRoots(h)), `${alias}/cases.json`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// S3-R6-01 на независимых clone: у обеих сторон есть неподтверждённое
// написание корня (другой каталог вне clone с разным содержимым). Путь под
// ним не переносится — receipt требует перепроверки до и после импорта в
// обеих топологиях; без такого написания обычный путь переносится.
test('S3-R6-01: неподтверждённое написание корня не делает переносимым внешний вход — отказ без snapshot до и после импорта, component и central', () => {
  for (const storage of ['component', 'central'] as const) {
    const p = peers();
    try {
      const outside = (c: Cfg) => resolve(c.repository, '..', 'outside');
      const env = (c: Cfg) => {
        c.storage = storage;
        mkdirSync(outside(c), { recursive: true });
        writeFileSync(
          join(outside(c), 'cases.json'),
          c.repository.includes('sender') ? '[1]' : '[1,2]',
        );
        configuredSpellings.set(c, [outside(c)]);
        c.environment = {
          inherit: [],
          values: { DATA_FILE: `${outside(c)}/cases.json` },
          secrets: {},
        };
      };
      const a = p.peer('sender', undefined, env);
      assert.equal(
        typeof portablePolicy(a.h.config.environment!.values.DATA_FILE, policyRoots(a.h)),
        'string',
        storage,
      );
      const board = a.h.createBoard('Received board', '', 'main');
      const task = a.h.addTask(board.id, input());
      finishFixture(a);
      for (const when of ['before', 'after'] as const) {
        const b = p.peer(
          `receiver-${when}`,
          a,
          when === 'before' ? env : (c) => (c.storage = storage),
        );
        syncGit(b.h, { member: 'receiver' });
        if (when === 'after') env(b.h.config);
        assert.equal(b.store.read().tasks.find((t) => t.id === task.id)!.status, 'done');
        assert.equal(b.store.read().runs.length, 0);
        const head = git(b.repo, 'rev-parse', 'HEAD');
        assert.throws(() => b.h.accept(board.id, head), /нужна перепроверка/, `${storage} ${when}`);
        assert.equal(
          b.store.read().boards[0].revisions[0].snapshot,
          undefined,
          `${storage} ${when}`,
        );
      }
    } finally {
      p.cleanup();
    }
  }
});

// Экспорт после смены политики: попытка проверена прежним договором, а он
// уже не восстанавливается из текущей конфигурации — receipt выпускается без
// тождества (а не с тождеством текущего договора), и новая приёмка у
// получателя требует перепроверки.
test('Receipt, впервые выпущенный после смены политики, не берёт тождество текущего договора: получатель требует перепроверки', () => {
  const p = peers();
  try {
    const a = p.peer('sender');
    const board = a.h.createBoard('Received board', '', 'main');
    const task = a.h.addTask(board.id, input());
    finishFixture(a, () => (a.h.config.gates[0].command = ['node', 'new-check-never-run.mjs']));
    const b = p.peer(
      'receiver',
      a,
      (c) => (c.gates[0].command = ['node', 'new-check-never-run.mjs']),
    );
    syncGit(b.h, { member: 'receiver' });
    const imported = b.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(imported.status, 'done');
    assert.equal(imported.sharedCompletion!.receipt.gateIdentity, undefined);
    const head = git(b.repo, 'rev-parse', 'HEAD');
    assert.throws(() => b.h.accept(board.id, head), /нужна перепроверка/);
    assert.equal(b.store.read().boards[0].revisions[0].snapshot, undefined);
  } finally {
    p.cleanup();
  }
});
