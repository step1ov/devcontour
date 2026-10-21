// Предпроверка новой версии на копии workspace, не трогая оригинал.
//
// Конфигурация и базы хранят абсолютные пути (workspace, репозитории, владелец
// базы компонента), поэтому копия в другом каталоге — это уже другой
// workspace. Копия проверяется в изолированном контейнере, где она смонтирована
// по тем же абсолютным путям, что оригинал; оригинал в контейнер не попадает.
//
//   node scripts/copy-precheck.mjs --root R --workspace W --archive devcontour-<v>.tgz
//     [--image node:24.3.0-bookworm-slim] [--keep]
//
// R — общий каталог, внутри которого лежат workspace и все репозитории из его
// конфигурации; W — каталог workspace (внутри R). Нужен Docker. Перед
// запуском остановите writers исходного workspace (docs/upgrade.md).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const fail = (message) => {
  console.error('copy-precheck: ' + message);
  process.exit(2);
};
const args = process.argv.slice(2);
const arg = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const root = arg('--root') && realpathSync(resolve(arg('--root')));
const workspace = arg('--workspace') && realpathSync(resolve(arg('--workspace')));
const archive = arg('--archive') && resolve(arg('--archive'));
const image = arg('--image') ?? 'node:24.3.0-bookworm-slim';
if (!root || !workspace || !archive)
  fail('нужны --root R, --workspace W и --archive devcontour-<version>.tgz');
if (!existsSync(archive)) fail('архив не найден: ' + archive);
const inside = (path, base) => {
  const r = relative(base, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
if (!inside(workspace, root)) fail('workspace должен лежать внутри --root');

// Все абсолютные пути конфигурации должны лежать внутри R: иначе копия
// ссылалась бы на оригинал.
const configFile = [
  join(workspace, 'config.json'),
  join(workspace, '.devcontour', 'config.json'),
].find(existsSync);
if (!configFile) fail('config.json workspace не найден');
const outside = [];
const walk = (value, path) => {
  if (typeof value === 'string') {
    if (!isAbsolute(value)) return;
    const real = existsSync(value) ? realpathSync(value) : resolve(value);
    if (!inside(real, root)) outside.push(`${path}: ${value}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
};
const config = JSON.parse(readFileSync(configFile, 'utf8'));
for (const key of ['repository', 'workspaceRoot', 'repositories', 'components'])
  if (key in config) walk(config[key], key);
if (outside.length)
  fail('пути конфигурации вне --root (копия ссылалась бы на оригинал):\n  ' + outside.join('\n  '));

// Отпечаток дерева: относительный путь → тип и содержимое (ссылки — цель).
function tree(base) {
  const out = {};
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(base, full);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = 'link:' + readlinkSync(full);
      else if (st.isDirectory()) visit(full);
      else out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  visit(base);
  return out;
}
const diff = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

const scratch = mkdtempSync(join(tmpdir(), 'dc-copy-precheck-'));
const copy = join(scratch, 'copy');
const originalBefore = tree(root);
cpSync(root, copy, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
const copyBefore = tree(copy);
if (diff(originalBefore, copyBefore).length) fail('копия не совпала с оригиналом');

const script = [
  'set -e',
  'git config --global --add safe.directory "*"',
  'git config --global user.name precheck && git config --global user.email precheck@example.invalid',
  'mkdir -p /opt/dc && cd /opt/dc',
  'npm install --omit=dev --ignore-scripts --no-audit --no-fund /archive/' +
    basename(archive) +
    ' >/dev/null',
  'cd /',
  `/opt/dc/node_modules/.bin/devcontour doctor --workspace ${JSON.stringify(workspace)}`,
].join('\n');
let output = '';
let status = 0;
try {
  output = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      // Копия смонтирована по абсолютному пути оригинала; сам оригинал — нет.
      '-v',
      `${copy}:${root}`,
      '-v',
      `${dirname(archive)}:/archive:ro`,
      image,
      'bash',
      '-c',
      script,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (error) {
  status = error.status ?? 1;
  output = String(error.stdout ?? '') + String(error.stderr ?? '');
}
const originalChanged = diff(originalBefore, tree(root));
const copyChanged = diff(copyBefore, tree(copy));
const report = {
  root,
  workspace,
  archive: basename(archive),
  image,
  doctorExit: status,
  originalUnchanged: originalChanged.length === 0,
  copyChanged,
  ...(args.includes('--keep') ? { copy } : {}),
  output: output.slice(-20000),
};
console.log(JSON.stringify(report, null, 2));
if (!args.includes('--keep') && scratch.startsWith(join(tmpdir(), 'dc-copy-precheck-')))
  rmSync(scratch, { recursive: true, force: true });
if (originalChanged.length) {
  console.error('copy-precheck: оригинал изменился: ' + originalChanged.join(', '));
  process.exit(3);
}
process.exit(status === 0 ? 0 : 1);
