// Закрепление пакета harness в DevContour: зависимость — точная версия
// `devcontour-harness` из npm registry (без ^/~ и без вложения в архив),
// `package-lock.json` фиксирует resolved и integrity опубликованных байтов.
// Смена версии — осознанный выпуск DevContour; установка DevContour не
// подтягивает другую версию harness.
//
// `--archive` — локальная копия проверенного архива той же версии: integrity
// опубликованного пакета обязана совпасть с его байтами, иначе отказ. Так
// закрепляются именно те байты, которые проверялись до публикации.
//
// После установки сверяются lock (версия, resolved из registry, integrity),
// установленная копия (версия и, с `--archive`, каждый файл) и общие с harness
// зависимости — одних и тех же точных версий.
//
//   node scripts/pin-harness.mjs <version> --commit <sha> [--archive <path/devcontour-harness-<version>.tgz>]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const record = join(root, 'vendor', 'harness', 'README.md');
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

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

let expected;
if (archive !== undefined) {
  const path = resolve(archive);
  if (!existsSync(path)) fail('нет архива ' + archive);
  if (basename(path) !== `devcontour-harness-${version}.tgz`)
    fail(`имя архива должно быть devcontour-harness-${version}.tgz: ${basename(path)}`);
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }),
  );
  if (manifest.name !== 'devcontour-harness') fail('в архиве пакет ' + manifest.name);
  if (manifest.version !== version) fail(`версия в архиве ${manifest.version}, нужна ${version}`);
  expected = {
    path,
    integrity: 'sha512-' + createHash('sha512').update(readFileSync(path)).digest('base64'),
  };
  // До любых изменений: опубликованы ли именно эти байты.
  let published;
  try {
    published = JSON.parse(
      execFileSync('npm', ['view', `devcontour-harness@${version}`, 'dist.integrity', '--json'], {
        cwd: root,
        encoding: 'utf8',
      }) || 'null',
    );
  } catch (error) {
    fail(`версия ${version} не найдена в registry: ${error.stderr || error.message}`);
  }
  if (published !== expected.integrity)
    fail(
      `опубликованные байты ${version} отличаются от архива: ${published} ≠ ${expected.integrity}`,
    );
}

const packagePath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
pkg.dependencies = Object.fromEntries(
  Object.entries({ ...pkg.dependencies, 'devcontour-harness': version }).sort(([a], [b]) =>
    a.localeCompare(b),
  ),
);
// Пакет harness ставится из registry рядом с DevContour, а не внутри архива.
if (pkg.bundledDependencies) {
  pkg.bundledDependencies = pkg.bundledDependencies.filter((n) => n !== 'devcontour-harness');
  if (!pkg.bundledDependencies.length) delete pkg.bundledDependencies;
}
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

// Прежняя запись lock и установленная копия: иначе npm оставит запись той же
// версии с прежним resolved (например, локальный архив) и прежними флагами.
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

const entry = JSON.parse(readFileSync(lockPath, 'utf8')).packages?.[
  'node_modules/devcontour-harness'
];
if (entry?.version !== version) fail(`lock: версия ${entry?.version}, нужна ${version}`);
if (!/^https?:\/\//.test(entry.resolved ?? '') || !entry.resolved.endsWith(`-${version}.tgz`))
  fail('lock: resolved не из registry: ' + entry.resolved);
if (!/^sha512-/.test(entry.integrity ?? '')) fail('lock: нет integrity sha512');
if (entry.inBundle) fail('lock: пакет всё ещё вложен (inBundle)');
if (expected && entry.integrity !== expected.integrity)
  fail(
    `опубликованные байты ${version} отличаются от архива: ${entry.integrity} ≠ ${expected.integrity}`,
  );

const installed = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'));
if (installed.version !== version) fail('установлена версия ' + installed.version);
// Общие зависимости пакетов — одних и тех же точных версий.
for (const [name, range] of Object.entries(installed.dependencies ?? {}))
  if (pkg.dependencies[name] !== undefined && pkg.dependencies[name] !== range)
    fail(`${name}: у DevContour ${pkg.dependencies[name]}, у harness ${range}`);

if (expected) {
  const unpacked = mkdtempSync(join(tmpdir(), 'pin-harness-'));
  try {
    execFileSync('tar', ['-xzf', expected.path, '-C', unpacked]);
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
      fail('установленный пакет отличается от архива: ' + differing.slice(0, 10).join(', '));
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

writeFileSync(
  record,
  `# Закреплённая версия harness

Зависимость \`devcontour-harness\` — точная версия из npm registry; она не
вкладывается в архив DevContour. \`package-lock.json\` фиксирует resolved и
integrity опубликованных байтов. Смена версии — новый выпуск DevContour:
\`node scripts/pin-harness.mjs <версия> --commit <SHA> [--archive <архив>]\`.

| Версия | Integrity опубликованного пакета | Исходный commit harness |
| --- | --- | --- |
| ${version} | \`${entry.integrity}\` | \`${commit}\` |
`,
);
// Таблица в форме, которую принимает format:check репозитория.
if (existsSync(join(root, 'node_modules', '.bin', 'prettier')))
  execFileSync(join(root, 'node_modules', '.bin', 'prettier'), ['--write', record], {
    cwd: root,
    stdio: 'ignore',
  });
console.log(`pin-harness: ${version} (${entry.integrity})`);
