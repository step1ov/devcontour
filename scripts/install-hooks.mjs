import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
if (realpathSync(root) !== realpathSync(process.cwd()))
  throw new Error(
    'Создайте Git-репозиторий в корне шаблона; настройки родительского репозитория не изменяются.',
  );
execFileSync('git', ['config', 'core.hooksPath', '.githooks']);
console.log('Hooks installed for this repository.');
