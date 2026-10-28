import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { testEnvironment } from './test-environment.mjs';
import { slowFile, slowFirst, slowPatterns } from './test-tiers.mjs';

// Without options every tests/*.test.ts file and every test in it is run: that
// is the release check. The day-to-day tiers only narrow it and keep the same
// runner options:
//   --fast       leave out the slow tier of scripts/test-tiers.mjs
//   --affected   only files whose import closure reaches a change since the
//                merge base with --base (default master); needs `--import tsx`
//   --depth N    with --affected: only files within N import hops (not fail safe)
//   --list       print the selected files instead of running them
// Keep process isolation and the existing limit of four simultaneous test files.
const directory = new URL('../tests/', import.meta.url);
const rank = (name) => {
  const index = slowFirst.indexOf(name.replace(/\.test\.ts$/, ''));
  return index < 0 ? slowFirst.length : index;
};
const all = readdirSync(directory)
  .filter((name) => name.endsWith('.test.ts'))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
if (!all.length) throw new Error('No tests/*.test.ts files found');

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      list: { type: 'boolean' },
      fast: { type: 'boolean' },
      affected: { type: 'boolean' },
      base: { type: 'string' },
      depth: { type: 'string' },
    },
  }));
} catch {
  throw new Error('For targeted runs use node --import tsx --test <options> <files>');
}
if ((options.base || options.depth) && !options.affected)
  throw new Error('--base and --depth apply to --affected');

let names = all;
if (options.affected) {
  let affected;
  try {
    ({ affected } = await import('./affected-tests.ts'));
  } catch (error) {
    throw new Error('--affected needs the tsx loader: node --import tsx scripts/test.mjs', {
      cause: error,
    });
  }
  const depth = options.depth === undefined ? undefined : Number(options.depth);
  if (depth !== undefined && !(depth >= 1)) throw new Error('--depth must be a positive number');
  const { base, mergeBase, selection } = affected(options.base, { depth });
  console.error(
    `affected: base ${base}${mergeBase ? ` (merge base ${mergeBase.slice(0, 12)})` : ''}`,
  );
  for (const { path, effect } of selection.changes) console.error(`  ${path}: ${effect}`);
  console.error(`affected: ${selection.full ? 'full suite, ' : ''}${selection.reason}`);
  if (!selection.full) {
    const chosen = new Set(selection.tests.map((path) => path.replace(/^tests\//, '')));
    names = all.filter((name) => chosen.has(name));
  }
}
if (options.fast) {
  const kept = names.filter((name) => !slowFile(name.replace(/\.test\.ts$/, '')));
  if (kept.length < names.length)
    console.error(`fast: ${names.length - kept.length} slow file(s) and slow tests left out`);
  names = kept;
}
const files = names.map((name) => fileURLToPath(new URL(name, directory)));

if (options.list) {
  console.log(files.join('\n'));
} else if (!files.length) {
  console.error('No test file is affected.');
} else {
  // Node's CLI sorts file arguments alphabetically. The public run API preserves
  // the supplied order while retaining the normal Node test runner semantics.
  const controller = new AbortController();
  const interrupt = () => {
    process.exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    process.exitCode = 143;
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  // Тесты держат рабочие деревья в своих временных каталогах (checkoutRoot
  // фикстур). Новый элемент в настоящем кэше пользователя после прогона —
  // тест, который пишет туда: прогон не проходит. Сравнение — до и после,
  // поэтому во время полного прогона другие процессы harness не запускают.
  const xdg = process.env.XDG_CACHE_HOME;
  const cache =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'devcontour-harness')
      : join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache'), 'devcontour-harness');
  const entries = () => {
    try {
      return new Set(readdirSync(cache));
    } catch {
      return new Set();
    }
  };
  const before = entries();
  const originalEnv = { ...process.env };
  const isolated = testEnvironment();
  Object.assign(process.env, isolated.env);
  const cleanup = () => {
    for (const key of Object.keys(isolated.env)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    isolated.cleanup();
  };
  process.once('exit', cleanup);
  const results = run({
    files,
    concurrency: 4,
    execArgv: ['--import', 'tsx'],
    signal: controller.signal,
    // Tests left out by name are not reported at all, so the skip/todo
    // refusal below stays exact in every tier.
    ...(options.fast ? { testSkipPatterns: slowPatterns() } : {}),
  });
  results.on('test:fail', () => (process.exitCode ||= 1));
  results.on('test:pass', ({ skip, todo }) => {
    if (skip || todo) {
      console.error('Full test suite must not contain skipped or todo tests.');
      process.exitCode ||= 1;
    }
  });
  results.once('end', () => {
    const added = [...entries()].filter((name) => !before.has(name));
    if (added.length) {
      console.error(
        `Tests created ${added.length} entr${added.length === 1 ? 'y' : 'ies'} in the real user cache ${cache}: ${added.join(', ')}. Give the fixture a checkoutRoot (tests/helpers.ts testCheckoutRoot).`,
      );
      process.exitCode ||= 1;
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    cleanup();
    process.removeListener('exit', cleanup);
  });
  results.compose(spec).pipe(process.stdout);
}
