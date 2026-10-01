import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Evidence } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { propertySeed, type PropertyReport } from '../src/core/property.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentAdapter } from '../src/runner/adapters.ts';
import { pinArtifacts } from '../src/runner/contract-artifacts.ts';
import { command, git } from '../src/runner/process.ts';
import { readPropertyReport } from '../src/runner/property.ts';
import { isolationSupport } from '../src/runner/isolation.ts';

// Проект-фикстура: рюкзак на малых входах. Эталон — полный перебор, он
// закреплён контрактом; генератор и уменьшение входа — в проекте.
const oracle = `export function best(items, cap) {
  let top = 0;
  for (let mask = 0; mask < 1 << items.length; mask++) {
    let w = 0, v = 0;
    items.forEach((it, i) => { if (mask & (1 << i)) { w += it.w; v += it.v; } });
    if (w <= cap && v > top) top = v;
  }
  return top;
}
`;
const check = `import { properties } from './harness.mjs';
import { best } from './oracle.mjs';
import { solve } from './src/knap.mjs';
const int = (rng, max) => Math.floor(rng() * (max + 1));
await properties([{
  testId: 'knapsack-optimal',
  cases: 400,
  generate: (rng) => ({
    items: Array.from({ length: int(rng, 6) }, () => ({ w: int(rng, 6), v: int(rng, 9) })),
    cap: int(rng, 10),
  }),
  oracle: ({ items, cap }) => best(items, cap),
  subject: ({ items, cap }) => solve(items, cap),
  shrink: ({ items, cap }) => [
    ...items.map((_, i) => ({ items: items.filter((__, j) => j !== i), cap })),
    ...(cap > 0 ? [{ items, cap: cap - 1 }] : []),
    ...items.flatMap((it, i) => [
      ...(it.w > 0 ? [{ items: items.map((x, j) => (j === i ? { ...x, w: x.w - 1 } : x)), cap }] : []),
      ...(it.v > 0 ? [{ items: items.map((x, j) => (j === i ? { ...x, v: x.v - 1 } : x)), cap }] : []),
    ]),
  ],
}]);
`;
// Точечная приёмка — то, что ловит «пример, а не обещание».
const points = `import assert from 'node:assert/strict';
import { solve } from './src/knap.mjs';
assert.equal(solve([], 10), 0);
assert.equal(solve([{ w: 2, v: 3 }, { w: 3, v: 4 }], 5), 7);
assert.equal(solve([{ w: 4, v: 1 }], 3), 0);
`;
const dp = (filter = 'items') => `export function solve(items, cap) {
  const t = new Array(cap + 1).fill(0);
  for (const it of ${filter}) for (let c = cap; c >= it.w; c--) t[c] = Math.max(t[c], t[c - it.w] + it.v);
  return t[cap];
}
`;
const variants = {
  correct: dp(),
  // Жадный выбор по удельной ценности: верен на точках, неверен в общем.
  greedy: `export function solve(items, cap) {
  let left = cap, total = 0;
  for (const it of [...items].sort((a, b) => b.v / (b.w || 0.5) - a.v / (a.w || 0.5)))
    if (it.w <= left) { left -= it.w; total += it.v; }
  return total;
}
`,
  // Учитывает только первые три предмета.
  firstThree: dp('items.slice(0, 3)'),
  // Пропускает предметы нулевого веса.
  zeroWeight: dp('items.filter((it) => it.w > 0)'),
  // Верна везде, но зависает на входе из четырёх предметов.
  hang: `export function solve(items, cap) {
  if (items.length === 4) for (;;) {}
  const t = new Array(cap + 1).fill(0);
  for (const it of items) for (let c = cap; c >= it.w; c--) t[c] = Math.max(t[c], t[c - it.w] + it.v);
  return t[cap];
}
`,
} as const;

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-property-'));
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await copyFile(
    new URL('../packs/property/harness.mjs', import.meta.url),
    join(repo, 'harness.mjs'),
  );
  await writeFile(join(repo, 'oracle.mjs'), oracle);
  await writeFile(join(repo, 'check.mjs'), check);
  await writeFile(join(repo, 'points.mjs'), points);
  await writeFile(
    join(repo, 'src/knap.mjs'),
    'export function solve() { throw new Error("todo"); }\n',
  );
  await writeFile(join(repo, '.gitignore'), '.reports/\n.devcontour-local/\n.devcontour/\n');
  return { root, repo };
}
const run = async (repo: string, file: string, seed: number, timeoutMs = 60000) => {
  const report = join(repo, '.reports', `${file}.json`);
  await rm(report, { force: true });
  const r = await command([process.execPath, file], repo, {
    timeoutMs,
    env: {
      PATH: process.env.PATH,
      DEVCONTOUR_SEED: String(seed),
      DEVCONTOUR_PROPERTY_REPORT: report,
    },
  });
  const text = await readFile(report, 'utf8').catch(() => '');
  return { ...r, report: text ? (JSON.parse(text) as PropertyReport) : undefined };
};

test('A generative gate catches defects that point tests pass, reproduces them by seed and names the input a hang stopped on', async () => {
  const p = await project();
  try {
    const found: Record<string, unknown> = {};
    for (const [name, source] of Object.entries(variants)) {
      if (name === 'hang') continue;
      await writeFile(join(p.repo, 'src/knap.mjs'), source);
      const pointsResult = await run(p.repo, 'points.mjs', 1);
      assert.equal(pointsResult.code, 0, `${name}: точки проходят`);
      const property = await run(p.repo, 'check.mjs', 7);
      const entry = property.report!.properties[0];
      if (name === 'correct') {
        assert.equal(property.code, 0);
        assert.equal(entry.status, 'passed');
        assert.equal(entry.cases, 400);
        continue;
      }
      assert.notEqual(property.code, 0, `${name}: свойство нарушено`);
      assert.equal(entry.status, 'failed');
      const c = entry.counterexample!;
      assert.notDeepEqual(c.expected, c.actual);
      // Уменьшение действительно работает: вход сведён к минимальному для
      // дефекта — без него reduced отсутствовал бы, а исходный вход был бы
      // случайным и крупнее.
      const reduced = c.reduced as { items: { w: number; v: number }[]; cap: number };
      assert.ok(reduced, `${name}: вход уменьшен`);
      const minimal = { greedy: 3, firstThree: 4, zeroWeight: 1 }[name as 'greedy'];
      assert.ok(
        reduced.items.length <= minimal,
        `${name}: ${JSON.stringify(reduced)} не длиннее ${minimal}`,
      );
      if (name === 'zeroWeight') assert.deepEqual(reduced, { items: [{ w: 0, v: 1 }], cap: 0 });
      if (name === 'firstThree') assert.equal(reduced.items.length, 4);
      found[name] = c;
      // Тот же seed — тот же контрпример.
      const again = await run(p.repo, 'check.mjs', 7);
      assert.deepEqual(again.report!.properties[0].counterexample, c, `${name}: воспроизводится`);
    }
    assert.deepEqual(Object.keys(found), ['greedy', 'firstThree', 'zeroWeight']);

    // Зависание: гейт останавливает проверку, отчёт называет вход.
    await writeFile(join(p.repo, 'src/knap.mjs'), variants.hang);
    const hung = await run(p.repo, 'check.mjs', 7, 3000);
    assert.equal(hung.timedOut, true);
    const entry = hung.report!.properties[0];
    assert.equal(entry.status, 'running');
    assert.equal((entry.current as { items: unknown[] }).items.length, 4);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('The controller seeds the gate, keeps the property report on failure and timeout and binds it to the pinned oracle', async () => {
  const p = await project();
  let store: Store | undefined, scheduler: Scheduler | undefined;
  try {
    await git(p.repo, 'init', '-q', '-b', 'main');
    await git(p.repo, 'add', '.');
    await git(p.repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'project');
    const config = configSchema.parse({
      version: 1,
      name: 'Property gate',
      repository: p.repo,
      mode: 'demo',
      concurrency: 1,
      maxAttempts: 1,
      resourceDatabase: join(p.root, 'resources.sqlite'),
      roles: { backend: { runtime: 'demo' } },
      reviewer: { runtime: 'demo' },
      gates: [
        {
          id: 'properties',
          kind: 'test',
          command: ['node', 'check.mjs'],
          timeoutMs: 5000,
          report: { type: 'junit', path: '.reports/properties.xml' },
          property: { path: '.reports/property.json' },
        },
      ],
      protectedPaths: ['check.mjs', 'harness.mjs', '.gitignore'],
    });
    store = new Store(join(p.root, 'state.sqlite'));
    const h = new DevContour(store, config);
    let variant: keyof typeof variants = 'greedy';
    const writer: AgentAdapter = {
      name: 'demo',
      async execute(r) {
        if (r.review) return adapters.demo.execute(r);
        await writeFile(join(r.cwd, 'src/knap.mjs'), variants[variant]);
        return {
          data: { completed: true, summary: variant, discoveries: [] },
          log: '',
          command: [],
        };
      },
    };
    scheduler = new Scheduler(h, p.root, { ...adapters, demo: writer });
    await scheduler.init();
    const pinned = await pinArtifacts({ id: 'main', path: p.repo }, [
      { path: 'oracle.mjs', purpose: 'Эталон: полный перебор' },
    ]);
    const contract = h.contract(
      'Knapsack',
      'Оптимум по oracle.mjs.',
      undefined,
      undefined,
      undefined,
      pinned.artifacts,
    );
    const evidenceOf = async () => {
      const board = h.createBoard('Knapsack ' + variant);
      const t = h.addTask(board.id, {
        title: 'Solve knapsack',
        description: 'Точный оптимум для малых входов.',
        role: 'backend',
        contracts: [contract.id],
        acceptance: ['knapsack-optimal'],
        writePaths: ['src/'],
      });
      h.approve(board.id);
      h.pause(false);
      await scheduler!.drain();
      const r = store!.read().runs.findLast((x) => x.taskId === t.id)!;
      return { run: r, gate: r.evidence.find((e) => e.gate === 'properties') as Evidence };
    };

    const failed = await evidenceOf();
    assert.equal(failed.gate.passed, false);
    const property = failed.gate.property!;
    assert.equal(property.seed, propertySeed(failed.run.id, 'candidate', 'properties'));
    assert.equal(property.reproduce, `DEVCONTOUR_SEED=${property.seed} node check.mjs`);
    assert.equal(property.report?.properties[0].status, 'failed');
    assert.ok(property.report?.properties[0].counterexample?.original);
    assert.deepEqual(property.artifacts, [{ path: 'oracle.mjs', blob: pinned.artifacts[0].blob }]);
    assert.deepEqual(property.contracts, { [contract.id]: contract.digest });
    // Следующая попытка видит контрпример в итоге гейта.
    assert.match(failed.gate.summary, /свойство knapsack-optimal нарушено на .*ожидалось/);
    // Команда повтора воспроизводит тот же контрпример.
    await writeFile(join(p.repo, 'src/knap.mjs'), variants.greedy);
    const again = await run(p.repo, 'check.mjs', property.seed);
    assert.deepEqual(
      again.report!.properties[0].counterexample,
      property.report.properties[0].counterexample,
    );

    // Таймаут гейта: отчёт свойств и seed сохранены, вход назван.
    variant = 'hang';
    const hung = await evidenceOf();
    assert.equal(hung.gate.passed, false);
    assert.equal(hung.gate.property?.report?.properties[0].status, 'running');
    assert.match(hung.gate.summary, /timeout.*не завершилось на входе/s);

    // Верная реализация проходит, и её evidence несёт тот же договор.
    variant = 'correct';
    const passed = await evidenceOf();
    assert.equal(passed.gate.passed, true, passed.gate.summary);
    assert.equal(passed.gate.property?.report?.properties[0].status, 'passed');
  } finally {
    await scheduler?.stop();
    store?.close();
    await rm(p.root, { recursive: true, force: true });
  }
});

test('A property report is read only as a regular file inside the worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-property-read-'));
  try {
    const tree = join(root, 'tree');
    const outside = join(root, 'controller');
    await mkdir(join(tree, '.reports'), { recursive: true });
    await mkdir(outside);
    const secret = JSON.stringify({
      version: 1,
      properties: [{ testId: 'private-marker-7717', status: 'passed', cases: 1 }],
    });
    await writeFile(join(outside, 'state.json'), secret);
    // Отчёт — symlink на файл контура.
    await symlink(join(outside, 'state.json'), join(tree, '.reports/property.json'));
    const viaFile = await readPropertyReport(join(tree, '.reports/property.json'), tree);
    assert.equal(viaFile.problem, 'отчёт свойств — symlink');
    assert.equal(JSON.stringify(viaFile).includes('private-marker'), false);
    // Каталог отчёта — symlink наружу.
    await rm(join(tree, '.reports'), { recursive: true });
    await symlink(outside, join(tree, '.reports'));
    await rename(join(outside, 'state.json'), join(outside, 'property.json'));
    const viaDir = await readPropertyReport(join(tree, '.reports/property.json'), tree);
    assert.equal(viaDir.problem, 'отчёт свойств вне worktree');
    // Обычный файл внутри worktree читается.
    await rm(join(tree, '.reports'));
    await mkdir(join(tree, '.reports'));
    await writeFile(join(tree, '.reports/property.json'), secret);
    assert.equal(
      (await readPropertyReport(join(tree, '.reports/property.json'), tree)).report?.properties[0]
        .testId,
      'private-marker-7717',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A property gate fails on exit 0 when the report is violated or missing', async () => {
  const p = await project();
  let store: Store | undefined, scheduler: Scheduler | undefined;
  try {
    // Команды, которые лгут кодом выхода.
    await writeFile(
      join(p.repo, 'violated.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.DEVCONTOUR_PROPERTY_REPORT, JSON.stringify({ version: 1, properties: [
  { testId: 'knapsack-optimal', status: 'failed', cases: 3, counterexample: { original: { items: [], cap: 1 }, expected: 1, actual: 0 } },
] }));
`,
    );
    await writeFile(join(p.repo, 'silent.mjs'), 'process.exitCode = 0;\n');
    await git(p.repo, 'init', '-q', '-b', 'main');
    await git(p.repo, 'add', '.');
    await git(p.repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'project');
    const gate = (command: string) => ({
      id: 'properties',
      kind: 'test' as const,
      command: ['node', command],
      timeoutMs: 5000,
      property: { path: '.reports/property.json' },
    });
    const config = configSchema.parse({
      version: 1,
      name: 'Lying gate',
      repository: p.repo,
      mode: 'demo',
      concurrency: 1,
      maxAttempts: 1,
      resourceDatabase: join(p.root, 'resources.sqlite'),
      roles: { qa: { runtime: 'demo' } },
      reviewer: { runtime: 'demo' },
      gates: [gate('violated.mjs')],
      protectedPaths: ['violated.mjs', 'silent.mjs'],
    });
    store = new Store(join(p.root, 'state.sqlite'));
    const h = new DevContour(store, config);
    const writer: AgentAdapter = {
      name: 'demo',
      async execute(r) {
        if (r.review) return adapters.demo.execute(r);
        await writeFile(join(r.cwd, 'src/knap.mjs'), variants.correct);
        return { data: { completed: true, summary: 'ok', discoveries: [] }, log: '', command: [] };
      },
    };
    scheduler = new Scheduler(h, p.root, { ...adapters, demo: writer });
    await scheduler.init();
    const evidence = async (title: string) => {
      const board = h.createBoard(title);
      const t = h.addTask(board.id, {
        title,
        description: 'Проверка лгущего кода выхода.',
        role: 'qa',
        acceptance: ['knapsack-optimal'],
        writePaths: ['src/'],
      });
      h.approve(board.id);
      h.pause(false);
      await scheduler!.drain();
      const r = store!.read().runs.findLast((x) => x.taskId === t.id)!;
      return r.evidence.find((e) => e.gate === 'properties')!;
    };
    const violated = await evidence('Violated');
    assert.equal(violated.exitCode, 0);
    assert.equal(violated.passed, false);
    assert.match(violated.summary, /свойство knapsack-optimal нарушено/);
    h.config.gates = [gate('silent.mjs')];
    const silent = await evidence('Silent');
    assert.equal(silent.exitCode, 0);
    assert.equal(silent.passed, false);
    assert.match(silent.summary, /не отчиталась: отчёт свойств не записан/);
  } finally {
    await scheduler?.stop();
    store?.close();
    await rm(p.root, { recursive: true, force: true });
  }
});

test('Under OS isolation a property check cannot swap its report directory for a link outside', async (t) => {
  if (!isolationSupport().ok) {
    t.skip('Песочница ОС недоступна');
    return;
  }
  const p = await project();
  let store: Store | undefined, scheduler: Scheduler | undefined;
  const outside = await mkdtemp(join(tmpdir(), 'devcontour-property-outside-'));
  try {
    await writeFile(
      join(outside, 'report.json'),
      JSON.stringify({
        version: 1,
        properties: [{ testId: 'PRIVATE_OUTSIDE_9922', status: 'passed', cases: 1 }],
      }),
    );
    // Проверка пытается заменить каталог отчёта ссылкой на чужой отчёт.
    await writeFile(
      join(p.repo, 'swap.mjs'),
      `import { renameSync, symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
const dir = dirname(process.env.DEVCONTOUR_PROPERTY_REPORT);
let swapped = false;
try { renameSync(dir, dir + '-moved'); symlinkSync(${JSON.stringify(outside)}, dir); swapped = true; } catch {}
console.log('REPORT=' + process.env.DEVCONTOUR_PROPERTY_REPORT + ' SWAPPED=' + swapped);
`,
    );
    await git(p.repo, 'init', '-q', '-b', 'main');
    await git(p.repo, 'add', '.');
    await git(p.repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'project');
    const config = configSchema.parse({
      version: 1,
      name: 'Swap gate',
      repository: p.repo,
      mode: 'demo',
      concurrency: 1,
      maxAttempts: 1,
      resourceDatabase: join(p.root, 'resources.sqlite'),
      roles: { qa: { runtime: 'demo' } },
      reviewer: { runtime: 'demo' },
      gates: [
        {
          id: 'properties',
          kind: 'test',
          command: ['node', 'swap.mjs'],
          timeoutMs: 20000,
          property: {},
        },
      ],
      protectedPaths: ['swap.mjs'],
    });
    store = new Store(join(p.root, 'state.sqlite'));
    const h = new DevContour(store, config);
    const writer: AgentAdapter = {
      name: 'demo',
      async execute(r) {
        if (r.review) return adapters.demo.execute(r);
        await writeFile(join(r.cwd, 'src/knap.mjs'), variants.correct);
        return { data: { completed: true, summary: 'ok', discoveries: [] }, log: '', command: [] };
      },
    };
    scheduler = new Scheduler(h, p.root, { ...adapters, demo: writer });
    await scheduler.init();
    const board = h.createBoard('Swap');
    const task = h.addTask(board.id, {
      title: 'Swap',
      description: 'Подмена каталога отчёта.',
      role: 'qa',
      acceptance: ['knapsack-optimal'],
      writePaths: ['src/'],
    });
    h.approve(board.id);
    h.pause(false);
    await scheduler.drain();
    const run = store.read().runs.findLast((x) => x.taskId === task.id)!;
    const e = run.evidence.find((x) => x.gate === 'properties')!;
    const log = await readFile(e.log, 'utf8');
    assert.match(log, /SWAPPED=false/, 'песочница не дала заменить каталог отчёта');
    const reported = /REPORT=(\S+)/.exec(log)![1];
    assert.equal(reported.startsWith(run.worktree!), false, 'отчёт вне worktree');
    assert.equal(e.passed, false);
    assert.equal(JSON.stringify(e).includes('PRIVATE_OUTSIDE_9922'), false);
  } finally {
    await scheduler?.stop();
    store?.close();
    await rm(outside, { recursive: true, force: true });
    await rm(p.root, { recursive: true, force: true });
  }
});

for (const [name, script] of [
  [
    'deletes its report directory',
    `import { rmSync } from 'node:fs';\nimport { dirname } from 'node:path';\nrmSync(dirname(process.env.DEVCONTOUR_PROPERTY_REPORT), { recursive: true, force: true });\n`,
  ],
  [
    'locks its report directory',
    `import { chmodSync, writeFileSync } from 'node:fs';\nimport { dirname } from 'node:path';\nconst report = process.env.DEVCONTOUR_PROPERTY_REPORT;\nwriteFileSync(report, JSON.stringify({ version: 1, properties: [{ testId: 'knapsack-optimal', status: 'passed', cases: 1 }] }));\nchmodSync(dirname(report), 0o000);\n`,
  ],
] as const)
  test(`A check that ${name} still leaves negative evidence`, async () => {
    const p = await project();
    let store: Store | undefined, scheduler: Scheduler | undefined;
    try {
      await writeFile(join(p.repo, 'vanish.mjs'), script);
      await git(p.repo, 'init', '-q', '-b', 'main');
      await git(p.repo, 'add', '.');
      await git(p.repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'project');
      const config = configSchema.parse({
        version: 1,
        name: 'Vanishing report',
        repository: p.repo,
        mode: 'demo',
        concurrency: 1,
        maxAttempts: 1,
        resourceDatabase: join(p.root, 'resources.sqlite'),
        // Без песочницы проверка вправе удалить каталог отчёта.
        isolation: { mode: 'none' },
        roles: { qa: { runtime: 'demo' } },
        reviewer: { runtime: 'demo' },
        gates: [
          {
            id: 'properties',
            kind: 'test',
            command: ['node', 'vanish.mjs'],
            timeoutMs: 20000,
            property: {},
          },
        ],
        protectedPaths: ['vanish.mjs'],
      });
      store = new Store(join(p.root, 'state.sqlite'));
      const h = new DevContour(store, config);
      const writer: AgentAdapter = {
        name: 'demo',
        async execute(r) {
          if (r.review) return adapters.demo.execute(r);
          await writeFile(join(r.cwd, 'src/knap.mjs'), variants.correct);
          return {
            data: { completed: true, summary: 'ok', discoveries: [] },
            log: '',
            command: [],
          };
        },
      };
      scheduler = new Scheduler(h, p.root, { ...adapters, demo: writer });
      await scheduler.init();
      const board = h.createBoard('Vanish');
      const task = h.addTask(board.id, {
        title: 'Vanish',
        description: 'Проверка удаляет каталог отчёта.',
        role: 'qa',
        acceptance: ['knapsack-optimal'],
        writePaths: ['src/'],
      });
      h.approve(board.id);
      h.pause(false);
      await scheduler.drain();
      const run = store.read().runs.findLast((x) => x.taskId === task.id)!;
      const e = run.evidence.find((x) => x.gate === 'properties');
      assert.ok(e, 'evidence записано');
      assert.equal(e.passed, false);
      assert.match(e.property?.problem ?? '', /не записан|не убран/);
    } finally {
      await scheduler?.stop();
      store?.close();
      await rm(p.root, { recursive: true, force: true });
    }
  });
