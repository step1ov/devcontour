// Закрепление пакета harness в DevContour: зависимость — точная версия
// `devcontour-harness` из npm registry (без ^/~ и без вложения в архив).
// Опубликованная версия неизменяема, поэтому точная версия означает одни и
// те же байты пакета harness; `package-lock.json` checkout фиксирует их
// resolved и integrity. Смена версии — осознанный выпуск DevContour.
//
// `--archive` (обязателен) — локальная копия проверенного архива той же
// версии: integrity опубликованного пакета обязана совпасть с его байтами,
// иначе отказ до изменений. Так закрепляются именно те байты, которые
// проверялись до публикации.
//
// После установки сверяются lock (версия, resolved с registry.npmjs.org,
// integrity), установленная копия (версия и каждый файл) и общие с harness
// зависимости — одних и тех же точных версий. Любой отказ после первой
// записи возвращает package.json и package-lock.json к прежним байтам.
//
//   node scripts/pin-harness.mjs <version> --commit <sha> --archive <path/devcontour-harness-<version>.tgz>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor', 'harness');
const record = join(vendor, 'README.md');
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
// Закрепление идёт только из публичного registry. Переменная — для теста с
// локальным registry; lock checkout проверяет tests/boundaries.test.ts.
const registry = process.env.PIN_HARNESS_REGISTRY ?? 'https://registry.npmjs.org/';
const registryHost = new URL(registry).host;

const fail = (message) => {
  console.error('pin-harness: ' + message);
  process.exit(1);
};

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const version = args.find(
  (a, i) => !a.startsWith('--') && !['--commit', '--archive'].includes(args[i - 1]),
);
const commit = valueOf('--commit');
const archive = valueOf('--archive');
if (!version || !exactVersion.test(version))
  fail('укажите точную версию devcontour-harness (без ^, ~ и диапазонов)');
if (!commit || !/^[0-9a-f]{40}$/.test(commit))
  fail('укажите --commit <полный SHA исходников harness>');
if (!archive) fail('укажите --archive <проверенный архив devcontour-harness-<version>.tgz>');

const path = resolve(archive);
if (!existsSync(path)) fail('нет архива ' + archive);
if (basename(path) !== `devcontour-harness-${version}.tgz`)
  fail(`имя архива должно быть devcontour-harness-${version}.tgz: ${basename(path)}`);
const manifest = JSON.parse(
  execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }),
);
if (manifest.name !== 'devcontour-harness') fail('в архиве пакет ' + manifest.name);
if (manifest.version !== version) fail(`версия в архиве ${manifest.version}, нужна ${version}`);
const integrity = 'sha512-' + createHash('sha512').update(readFileSync(path)).digest('base64');

// До любых изменений: опубликованы ли именно эти байты.
let published;
try {
  published = JSON.parse(
    execFileSync(
      'npm',
      ['view', `devcontour-harness@${version}`, 'dist.integrity', '--json', '--registry', registry],
      { cwd: root, encoding: 'utf8' },
    ) || 'null',
  );
} catch (error) {
  fail(`версия ${version} не найдена в registry: ${error.stderr || error.message}`);
}
if (published !== integrity)
  fail(`опубликованные байты ${version} отличаются от архива: ${published} ≠ ${integrity}`);

const packagePath = join(root, 'package.json');
const lockPath = join(root, 'package-lock.json');
const saved = [packagePath, lockPath].map((file) => [
  file,
  existsSync(file) ? readFileSync(file) : null,
]);
const installedDir = join(root, 'node_modules', 'devcontour-harness');

try {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.dependencies = Object.fromEntries(
    Object.entries({ ...pkg.dependencies, 'devcontour-harness': version }).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  // Пакет harness ставится из registry, а не внутри архива DevContour.
  if (pkg.bundledDependencies) {
    pkg.bundledDependencies = pkg.bundledDependencies.filter((n) => n !== 'devcontour-harness');
    if (!pkg.bundledDependencies.length) delete pkg.bundledDependencies;
  }
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

  // Прежняя запись lock и установленная копия: иначе npm оставит запись той же
  // версии с прежним resolved (например, локальный архив) и прежними флагами.
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    delete lock.packages?.['node_modules/devcontour-harness'];
    delete lock.dependencies?.['devcontour-harness'];
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }
  rmSync(installedDir, { recursive: true, force: true });

  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registry],
    { cwd: root, stdio: 'inherit' },
  );

  const entry = JSON.parse(readFileSync(lockPath, 'utf8')).packages?.[
    'node_modules/devcontour-harness'
  ];
  if (entry?.version !== version)
    throw new Error(`lock: версия ${entry?.version}, нужна ${version}`);
  let resolved;
  try {
    resolved = new URL(entry.resolved);
  } catch {
    throw new Error('lock: resolved не из registry: ' + entry.resolved);
  }
  if (resolved.host !== registryHost || !resolved.pathname.endsWith(`-${version}.tgz`))
    throw new Error(`lock: resolved не из ${registryHost}: ${entry.resolved}`);
  if (entry.inBundle) throw new Error('lock: пакет всё ещё вложен (inBundle)');
  if (entry.integrity !== integrity)
    throw new Error(`lock: integrity ${entry.integrity} ≠ байтам архива ${integrity}`);

  const installed = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
  if (installed.version !== version) throw new Error('установлена версия ' + installed.version);
  // Общие зависимости пакетов — одних и тех же точных версий.
  for (const [name, range] of Object.entries(installed.dependencies ?? {}))
    if (pkg.dependencies[name] !== undefined && pkg.dependencies[name] !== range)
      throw new Error(`${name}: у DevContour ${pkg.dependencies[name]}, у harness ${range}`);

  const unpacked = mkdtempSync(join(tmpdir(), 'pin-harness-'));
  try {
    execFileSync('tar', ['-xzf', path, '-C', unpacked]);
    const files = (dir) =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(dir, join(e.parentPath, e.name)))
        .filter((f) => !f.startsWith('node_modules'))
        .sort();
    const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const want = files(join(unpacked, 'package'));
    const got = files(installedDir);
    const differing = [...new Set([...want, ...got])].filter(
      (f) =>
        !existsSync(join(unpacked, 'package', f)) ||
        !existsSync(join(installedDir, f)) ||
        hash(join(unpacked, 'package', f)) !== hash(join(installedDir, f)),
    );
    if (differing.length)
      throw new Error(
        'установленный пакет отличается от архива: ' + differing.slice(0, 10).join(', '),
      );
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
} catch (error) {
  // Прежние package.json и lock; node_modules восстановит `npm ci`.
  for (const [file, bytes] of saved)
    if (bytes === null) rmSync(file, { force: true });
    else writeFileSync(file, bytes);
  fail(`${error.message}; package.json и package-lock.json возвращены, выполните npm ci`);
}

// Прежняя форма закрепления — вложенный архив; после перехода он не нужен.
if (existsSync(vendor))
  for (const name of readdirSync(vendor))
    if (/^devcontour-harness-.+\.tgz$/.test(name)) rmSync(join(vendor, name));
writeFileSync(
  record,
  `# Закреплённая версия harness

Зависимость \`devcontour-harness\` — точная версия из npm registry; она не
вкладывается в архив DevContour. \`package-lock.json\` фиксирует resolved и
integrity опубликованных байтов; при закреплении integrity сверена с
проверенным архивом. Смена версии — новый выпуск DevContour:
\`node scripts/pin-harness.mjs <версия> --commit <SHA> --archive <архив>\`.

| Версия | Integrity опубликованного пакета | Исходный commit harness |
| --- | --- | --- |
| ${version} | \`${integrity}\` | \`${commit}\` |
`,
);
// Таблица в форме, которую принимает format:check репозитория.
if (existsSync(join(root, 'node_modules', '.bin', 'prettier')))
  execFileSync(join(root, 'node_modules', '.bin', 'prettier'), ['--write', record], {
    cwd: root,
    stdio: 'ignore',
  });
console.log(`pin-harness: ${version} (${integrity})`);
