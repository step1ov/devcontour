#!/usr/bin/env node
// Вход CLI. Версии и справка печатаются без загрузки команд: команды
// открывают SQLite, и node выводил бы в stderr предупреждение о его
// экспериментальном статусе даже там, где база не нужна.
import { createRequire } from 'node:module';
import { printHelp } from './cli-help.ts';

const args = process.argv.slice(2);
const operation = args[0] ?? 'serve';
// У этих команд `--help` разбирают они сами (как и прежде, до справки).
const ownHelp = [
  'eval-compare',
  'engineering-evals',
  'contract-evals',
  'evals',
  'skill-path',
  'capabilities',
];

if (operation === 'version' || operation === '--version') {
  const require = createRequire(import.meta.url);
  const own = require('../package.json') as { version: string };
  const harness = require('devcontour-harness/package.json') as { version: string };
  console.log(`devcontour ${own.version}\ndevcontour-harness ${harness.version}`);
} else if (operation === 'help' || (args.includes('--help') && !ownHelp.includes(operation))) {
  printHelp();
} else {
  await import('./commands.ts');
}
