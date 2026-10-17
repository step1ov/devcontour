// Поставка пакета harness в DevContour: проверенный архив копируется в
// vendor/harness/, зависимость и lock указывают на этот относительный
// versioned archive. Уже поставленный номер не перепаковывается: архив той же
// версии с другими байтами — отказ.
//
//   node scripts/vendor-harness.mjs <path/devcontour-harness-<version>.tgz> --commit <sha>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor', 'harness');
const archiveName = /^devcontour-harness-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/;

const fail = (message) => {
  console.error('vendor-harness: ' + message);
  process.exit(1);
};

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const commitAt = args.indexOf('--commit');
const commit = commitAt >= 0 ? args[commitAt + 1] : undefined;
if (!source) fail('укажите путь к архиву devcontour-harness-<version>.tgz');
if (!commit || !/^[0-9a-f]{40}$/.test(commit))
  fail('укажите --commit <полный SHA исходников harness>');

const path = resolve(source);
const match = archiveName.exec(basename(path));
if (!match) fail('имя архива должно быть devcontour-harness-<version>.tgz: ' + basename(path));
const version = match[1];
const manifest = JSON.parse(
  execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }),
);
if (manifest.name !== 'devcontour-harness') fail('в архиве пакет ' + manifest.name);
if (manifest.version !== version)
  fail(`версия в архиве ${manifest.version} не совпадает с именем файла ${version}`);

const bytes = readFileSync(path);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const target = join(vendor, basename(path));
if (
  existsSync(target) &&
  createHash('sha256').update(readFileSync(target)).digest('hex') !== sha256
)
  fail(`версия ${version} уже поставлена другими байтами; выпустите новый номер`);

mkdirSync(vendor, { recursive: true });
// Прежние архивы — только файлы этого каталога по точному образцу имени.
for (const name of readdirSync(vendor))
  if (archiveName.test(name) && name !== basename(path)) rmSync(join(vendor, name));
copyFileSync(path, target);

const packagePath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
pkg.dependencies = {
  ...pkg.dependencies,
  'devcontour-harness': `file:vendor/harness/${basename(path)}`,
};
pkg.dependencies = Object.fromEntries(
  Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)),
);
pkg.bundledDependencies = [...new Set([...(pkg.bundledDependencies ?? []), 'devcontour-harness'])];
// Общие зависимости пакетов — одних и тех же точных версий.
for (const [name, range] of Object.entries(manifest.dependencies ?? {}))
  if (pkg.dependencies[name] !== undefined && pkg.dependencies[name] !== range)
    fail(`${name}: у DevContour ${pkg.dependencies[name]}, у harness ${range}`);
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

writeFileSync(
  join(vendor, 'README.md'),
  `# Поставленный пакет harness

Зависимость \`devcontour-harness\` — относительный versioned archive из этого
каталога; \`package-lock.json\` фиксирует его integrity. Обновление —
\`node scripts/vendor-harness.mjs <архив> --commit <SHA>\`: новый номер версии,
уже поставленный номер другими байтами не заменяется.

| Версия | SHA-256 архива | Исходный commit harness |
| --- | --- | --- |
| ${version} | \`${sha256}\` | \`${commit}\` |
`,
);

execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: root,
  stdio: 'inherit',
});
// Таблица README в форме, которую принимает format:check репозитория.
execFileSync('npx', ['prettier', '--write', join(vendor, 'README.md')], {
  cwd: root,
  stdio: 'ignore',
});
console.log(`vendor-harness: ${version} (${sha256})`);
