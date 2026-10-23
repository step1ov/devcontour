// Поставка пакета harness в DevContour: проверенный архив копируется в
// vendor/harness/, зависимость и lock указывают на этот относительный
// versioned archive. Уже поставленный номер не перепаковывается: архив той же
// версии с другими байтами — отказ; `--replace` явно заменяет байты ещё не
// выпущенного кандидата того же номера.
//
// npm не переустанавливает пакет той же версии из `file:`-архива с другими
// байтами: lock и node_modules остались бы прежними. Поэтому перед установкой
// запись пакета в lock и его установленная копия удаляются, а после установки
// integrity в lock и каждый установленный файл сверяются с байтами архива.
//
//   node scripts/vendor-harness.mjs <path/devcontour-harness-<version>.tgz> --commit <sha> [--replace]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor', 'harness');
const archiveName = /^devcontour-harness-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/;

const fail = (message) => {
  console.error('vendor-harness: ' + message);
  process.exit(1);
};

const args = process.argv.slice(2);
const source = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--commit');
const commitAt = args.indexOf('--commit');
const commit = commitAt >= 0 ? args[commitAt + 1] : undefined;
const replace = args.includes('--replace');
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
  createHash('sha256').update(readFileSync(target)).digest('hex') !== sha256 &&
  !replace
)
  fail(
    `версия ${version} уже поставлена другими байтами; выпустите новый номер ` +
      '(или --replace для невыпущенного кандидата)',
  );
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');

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

// Прежняя запись lock и установленная копия: иначе npm оставит байты той же версии.
const lockPath = join(root, 'package-lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  delete lock.packages?.['node_modules/devcontour-harness'];
  delete lock.dependencies?.['devcontour-harness'];
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
const installedDir = join(root, 'node_modules', 'devcontour-harness');
rmSync(installedDir, { recursive: true, force: true });

execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: root,
  stdio: 'inherit',
});

// Установлены именно эти байты: integrity в lock, версия и каждый файл пакета.
const entry = JSON.parse(readFileSync(lockPath, 'utf8')).packages?.[
  'node_modules/devcontour-harness'
];
if (entry?.integrity !== integrity) fail(`integrity в lock ${entry?.integrity} ≠ ${integrity}`);
if (entry?.resolved !== `file:vendor/harness/${basename(path)}`)
  fail('lock: resolved ' + entry?.resolved);
const unpacked = mkdtempSync(join(tmpdir(), 'vendor-harness-'));
try {
  execFileSync('tar', ['-xzf', path, '-C', unpacked]);
  const files = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(dir, join(e.parentPath, e.name)))
      .filter((f) => !f.startsWith('node_modules'))
      .sort();
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const expected = files(join(unpacked, 'package'));
  const actual = files(installedDir);
  const differing = [...new Set([...expected, ...actual])].filter(
    (f) =>
      !existsSync(join(unpacked, 'package', f)) ||
      !existsSync(join(installedDir, f)) ||
      hash(join(unpacked, 'package', f)) !== hash(join(installedDir, f)),
  );
  if (differing.length)
    fail('установленный пакет отличается от архива: ' + differing.slice(0, 10).join(', '));
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}

// Таблица README в форме, которую принимает format:check репозитория.
if (existsSync(join(root, 'node_modules', '.bin', 'prettier')))
  execFileSync(
    join(root, 'node_modules', '.bin', 'prettier'),
    ['--write', join(vendor, 'README.md')],
    {
      cwd: root,
      stdio: 'ignore',
    },
  );
console.log(`vendor-harness: ${version} (${sha256})`);
