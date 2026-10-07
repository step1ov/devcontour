import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config } from '../src/core/model.ts';
import type { CheckDeclaration } from '../src/core/checks.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentAdapter, type AgentRequest } from '../src/runner/adapters.ts';
import { pinArtifacts } from '../src/runner/contract-artifacts.ts';
import { git } from '../src/runner/process.ts';

/**
 * Обезличенный проект для договора проверки: рюкзак на малых входах и
 * полнота достижимых сумм. Эталоны — полный перебор, закреплены договором;
 * генераторы и семейства входов — в общем файле проверок `check.mjs`.
 */
export const oracle = `export function best(items, cap) {
  let top = 0;
  for (let mask = 0; mask < 1 << items.length; mask++) {
    let w = 0, v = 0;
    items.forEach((it, i) => { if (mask & (1 << i)) { w += it.w; v += it.v; } });
    if (w <= cap && v > top) top = v;
  }
  return top;
}
export function sums(weights, cap) {
  const out = new Set();
  for (let mask = 0; mask < 1 << weights.length; mask++) {
    let w = 0;
    weights.forEach((x, i) => { if (mask & (1 << i)) w += x; });
    if (w <= cap) out.add(w);
  }
  return [...out].sort((a, b) => a - b);
}
`;
export const check = (cases = 120) => `import { properties } from './harness.mjs';
import { best, sums } from './oracle.mjs';
import { solve } from './src/knap.mjs';
import { reach } from './src/reach.mjs';
const int = (rng, max) => Math.floor(rng() * (max + 1));
const item = (rng) => ({ w: int(rng, 6), v: int(rng, 9) });
const valid = (x) => !!x && Array.isArray(x.items) && x.items.length <= 8 &&
  x.items.every((it) => Number.isInteger(it.w) && it.w >= 0 && Number.isInteger(it.v) && it.v >= 0) &&
  Number.isInteger(x.cap) && x.cap >= 0 && x.cap <= 30;
await properties([
  {
    testId: 'knapsack-optimal',
    cases: ${cases},
    valid,
    families: [
      { id: 'boundary', cases: 30, generate: (rng) => ({
        items: Array.from({ length: 1 + int(rng, 3) }, () => ({ w: int(rng, 1) * int(rng, 6), v: int(rng, 9) })),
        cap: int(rng, 1) ? 0 : int(rng, 6),
      }) },
      { id: 'adversarial', cases: 30, generate: (rng) => ({
        items: Array.from({ length: 5 + int(rng, 2) }, () => item(rng)),
        cap: 4 + int(rng, 10),
      }) },
    ],
    generate: (rng) => ({ items: Array.from({ length: int(rng, 6) }, () => item(rng)), cap: int(rng, 10) }),
    oracle: ({ items, cap }) => best(items, cap),
    subject: ({ items, cap }) => solve(items, cap),
    shrink: ({ items, cap }) => [
      ...items.map((_, i) => ({ items: items.filter((__, j) => j !== i), cap })),
      ...(cap > 0 ? [{ items, cap: cap - 1 }] : []),
    ],
  },
  {
    testId: 'reach-complete',
    cases: ${cases},
    valid: (x) => !!x && Array.isArray(x.weights) && x.weights.length <= 8 && Number.isInteger(x.cap),
    families: [
      { id: 'boundary', cases: 20, generate: (rng) => ({ weights: [0, int(rng, 3)], cap: int(rng, 3) }) },
    ],
    generate: (rng) => ({ weights: Array.from({ length: int(rng, 5) }, () => int(rng, 6)), cap: int(rng, 12) }),
    oracle: ({ weights, cap }) => sums(weights, cap),
    subject: ({ weights, cap }) => reach(weights, cap),
  },
]);
`;
const dp = (filter = 'items') => `export function solve(items, cap) {
  const t = new Array(cap + 1).fill(0);
  for (const it of ${filter}) for (let c = cap; c >= it.w; c--) t[c] = Math.max(t[c], t[c - it.w] + it.v);
  return t[cap];
}
`;
/** Реализации рюкзака: верная и дефектные, которые точечные тесты пропускают. */
export const knap = {
  correct: dp(),
  // Учитывает только первые три предмета: часть входов пропущена.
  firstThree: dp('items.slice(0, 3)'),
  // Ошибается на границе: предметы нулевого веса не берёт.
  zeroWeight: dp('items.filter((it) => it.w > 0)'),
  // Подогнана под один контрпример: исправлен ровно он, класс остался.
  fitted: (input: { items: { w: number; v: number }[]; cap: number }, answer: number) =>
    `const fixed = ${JSON.stringify(JSON.stringify(input))};
export function solve(items, cap) {
  if (JSON.stringify({ items, cap }) === fixed) return ${answer};
  const t = new Array(cap + 1).fill(0);
  for (const it of items.slice(0, 3)) for (let c = cap; c >= it.w; c--) t[c] = Math.max(t[c], t[c - it.w] + it.v);
  return t[cap];
}
`,
  stub: 'export function solve() { throw new Error("todo"); }\n',
};
export const reach = {
  correct: `export function reach(weights, cap) {
  let set = new Set([0]);
  for (const w of weights) for (const s of [...set]) if (s + w <= cap) set.add(s + w);
  return [...set].filter((s) => s <= cap).sort((a, b) => a - b);
}
`,
  stub: 'export function reach() { throw new Error("todo"); }\n',
};
// Точечные тесты: их проходят все дефектные варианты.
export const points = `import assert from 'node:assert/strict';
import { solve } from './src/knap.mjs';
assert.equal(solve([], 10), 0);
assert.equal(solve([{ w: 2, v: 3 }, { w: 3, v: 4 }], 5), 7);
assert.equal(solve([{ w: 4, v: 1 }], 3), 0);
`;

export async function checkProject(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-checks-'));
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await copyFile(
    new URL('../packs/property/harness.mjs', import.meta.url),
    join(repo, 'harness.mjs'),
  );
  const all: Record<string, string> = {
    'oracle.mjs': oracle,
    'check.mjs': check(),
    'points.mjs': points,
    'src/knap.mjs': knap.stub,
    'src/reach.mjs': reach.stub,
    '.gitignore': '.reports/\n.devcontour-local/\n',
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git(repo, 'init', '-q', '-b', 'main');
  await commit(repo, 'project');
  return { root, repo };
}
export async function commit(repo: string, message: string) {
  await git(repo, 'add', '-A');
  await git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@e',
    'commit',
    '--allow-empty',
    '-qm',
    message,
  );
  return git(repo, 'rev-parse', 'HEAD');
}

export const propertyGate = (command = ['node', 'check.mjs'], timeoutMs = 30000) => ({
  id: 'properties',
  kind: 'test' as const,
  command,
  timeoutMs,
  report: { type: 'junit' as const, path: '.reports/properties.xml' },
  property: {},
});

export function fixtureConfig(p: { root: string; repo: string }, extra: Partial<Config> = {}) {
  return configSchema.parse({
    version: 1,
    name: 'Check contract fixture',
    repository: p.repo,
    mode: 'demo',
    concurrency: 1,
    maxAttempts: 3,
    resourceDatabase: join(p.root, 'resources.sqlite'),
    isolation: { mode: 'none' },
    roles: { backend: { runtime: 'demo' }, qa: { runtime: 'demo' } },
    reviewer: { runtime: 'demo' },
    gates: [propertyGate()],
    protectedPaths: ['check.mjs', 'harness.mjs', 'oracle.mjs', 'points.mjs', '.gitignore'],
    ...extra,
  });
}

/** Договор проверки рюкзака и полноты сумм. */
export function declaration(overrides: Partial<CheckDeclaration> = {}): CheckDeclaration {
  const obligation = (property: string, requirement: string) => ({
    property,
    requirements: [requirement],
    promise: property === 'knapsack-optimal' ? ('optimality' as const) : ('completeness' as const),
    domain: {
      inputs: 'Целые неотрицательные веса и ценности, до 8 предметов',
      bounds: 'Вместимость от 0 до 30',
      invalid: 'Отрицательные и нецелые значения отклоняются',
    },
    answer: { rules: 'Точное значение; порядок не важен', ties: 'Равные оптимумы равнозначны' },
    method: {
      kind: 'oracle' as const,
      description: 'Полный перебор подмножеств',
      applicability: 'До 8 предметов',
      artifacts: ['oracle.mjs', 'check.mjs'],
    },
    coverage: {
      families:
        property === 'knapsack-optimal'
          ? [
              {
                id: 'boundary',
                kind: 'boundary' as const,
                description: 'Нулевые веса',
                minCases: 30,
              },
              {
                id: 'adversarial',
                kind: 'adversarial' as const,
                description: 'Много предметов',
                minCases: 30,
              },
            ]
          : [{ id: 'boundary', kind: 'boundary' as const, description: 'Нули', minCases: 20 }],
      minCases: 100,
      corpus: true,
    },
    resources: { subject: 'Меньше секунды на вход', oracle: 'Меньше секунды на вход' },
    hard: false,
  });
  return {
    version: 1,
    gate: 'properties',
    obligations: [
      obligation('knapsack-optimal', 'AC-optimal'),
      obligation('reach-complete', 'AC-reach'),
    ],
    corpus: { format: 'JSON-вход свойства', extensible: true, maxCases: 500 },
    ...overrides,
  };
}

/** Счётчики вызовов адаптеров: тест считает их сам, а не по итогам контура. */
export interface Calls {
  implementation: number;
  review: number;
  reviews: { phase: string; prompt: string }[];
}

/**
 * Контур на fixture: исполнитель пишет выбранный вариант реализации,
 * ревьюер — детерминированный адаптер (по умолчанию одобряет).
 */
export async function fixture(
  p: { root: string; repo: string },
  options: {
    config?: Partial<Config>;
    declaration?: CheckDeclaration | false;
    reviewer?: (request: AgentRequest, calls: Calls) => unknown;
  } = {},
) {
  const config = fixtureConfig(p, options.config);
  const store = new Store(join(p.root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const calls: Calls = { implementation: 0, review: 0, reviews: [] };
  const files: Record<string, string> = {};
  const writer: AgentAdapter = {
    name: 'demo',
    async execute(r) {
      if (r.review) {
        calls.review++;
        calls.reviews.push({
          phase: r.artifactDir.includes('integration') ? 'integration' : 'candidate',
          prompt: r.prompt,
        });
        if (options.reviewer) {
          const data = await options.reviewer(r, calls);
          if (data) return { data, log: '', command: ['reviewer'] };
        }
        return {
          data: { approved: true, summary: 'Fixture review approves', findings: [] },
          log: '',
          command: ['reviewer'],
        };
      }
      calls.implementation++;
      for (const [path, content] of Object.entries(files))
        await writeFile(join(r.cwd, path), content);
      return { data: { completed: true, summary: 'ok', discoveries: [] }, log: '', command: [] };
    },
  };
  const scheduler = new Scheduler(h, p.root, { ...adapters, demo: writer });
  await scheduler.init();
  let contract: ReturnType<DevContour['contract']> | undefined;
  if (options.declaration !== false) {
    const pinned = await pinArtifacts({ id: 'main', path: p.repo }, [
      { path: 'oracle.mjs', purpose: 'Эталоны: полный перебор' },
      { path: 'check.mjs', purpose: 'Генераторы и свойства' },
      { path: 'harness.mjs', purpose: 'Harness генеративной проверки' },
    ]);
    contract = h.contract(
      'Knapsack',
      'Оптимум рюкзака и полнота сумм по oracle.mjs.',
      undefined,
      undefined,
      undefined,
      pinned.artifacts,
      options.declaration ?? declaration(),
    );
  }
  return {
    h,
    store,
    scheduler,
    calls,
    contract,
    /** Что исполнитель запишет в следующей попытке. */
    write(path: string, content: string) {
      files[path] = content;
    },
    async close() {
      await scheduler.stop();
      store.close();
    },
  };
}

export async function removeRoot(root: string) {
  await rm(root, { recursive: true, force: true });
}
