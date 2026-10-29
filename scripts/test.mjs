import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

// Scheduling hints, not a test allowlist. Every tests/*.test.ts file is run.
// Start expensive files first to avoid a single long file at the end. Keep
// process isolation and the existing limit of four simultaneous test files.
const slowFirst = [
  'contract-change',
  'runner',
  'check-sync',
  'git-sync',
  'engineering',
  'product',
  'check-corpus',
  'preview',
  'intent',
  'property-recovery',
  'contract-revise',
  'panel-projections',
];
const directory = new URL('../tests/', import.meta.url);
const rank = (name) => {
  const index = slowFirst.indexOf(name.replace(/\.test\.ts$/, ''));
  return index < 0 ? slowFirst.length : index;
};
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.ts'))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  .map((name) => fileURLToPath(new URL(name, directory)));

if (!files.length) throw new Error('No tests/*.test.ts files found');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--list') {
  console.log(files.join('\n'));
} else {
  if (args.length)
    throw new Error('For targeted runs use node --import tsx --test <options> <files>');
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
  const results = run({
    files,
    concurrency: 4,
    execArgv: ['--import', 'tsx'],
    signal: controller.signal,
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
  });
  results.compose(spec).pipe(process.stdout);
}
