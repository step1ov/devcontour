// Проверка совместимости данных новой версии на копии workspace, не трогая
// оригинал. Проверяется только хранение и формат (`doctor --scope data`):
// конфигурация штатного загрузчика, владение баз компонентов, версия движка и
// роль controller, документ исполнения строгими схемами. Модели, CLI и
// песочница в контейнере не проверяются — готовность среды подтверждает полный
// `devcontour doctor` на хосте после установки, до возобновления writers.
//
// Конфигурация и базы хранят абсолютные пути (workspace, репозитории, владелец
// базы компонента), поэтому копия в другом каталоге — это уже другой
// workspace. Копия проверяется в изолированном контейнере, где она смонтирована
// по тем же абсолютным путям, что оригинал; оригинал в контейнер не попадает.
//
//   node scripts/copy-precheck.mjs --root R --workspace W --archive devcontour-<v>.tgz
//     [--image node:24.3.0-bookworm] [--keep]
//
// R — общий каталог, внутри которого лежат workspace и все репозитории из его
// конфигурации; W — каталог workspace (внутри R) или каталог данных с
// config.json прежней раскладки (тогда doctor получает --data W). Запускается из
// checkout той версии DevContour, архив которой проверяется. Нужен Docker. Перед
// запуском остановите writers исходного workspace (docs/upgrade.md).
//
// Копируется R целиком, а сравниваются (оригинал с копией до проверки,
// оригинал и копия до и после неё) только каталоги данных: каталог данных
// workspace и `.devcontour-local` каждого репозитория конфигурации. Только их
// читает `doctor --scope data`. Git (worktrees, index, refs) проверка данных не
// читает, и его изменения во время копирования на её итог не влияют.
//
// Перед копированием скрипт сверяет свободное место во временном каталоге с
// размером R. Свою временную копию он удаляет при любом исходе, кроме
// завершённой проверки с `--keep`. Удаляется только каталог, созданный этим
// запуском: `$TMPDIR/dc-copy-precheck-*` с меткой, в которой токен запуска.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
// Временный каталог этого запуска и метка с токеном, которую пишет только он.
const scratchPrefix = join(tmpdir(), 'dc-copy-precheck-');
const markerName = '.dc-copy-precheck-owner';
const token = randomUUID();
let scratch;
let keepScratch = false;
const removeOwnScratch = () => {
  const dir = scratch;
  scratch = undefined;
  if (!dir || keepScratch) return;
  let mark;
  try {
    if (dir.startsWith(scratchPrefix) && lstatSync(dir).isDirectory())
      mark = readFileSync(join(dir, markerName), 'utf8');
  } catch {
    /* метки нет */
  }
  if (mark !== token) {
    console.error(
      'copy-precheck: временный каталог не удалён — в нём нет метки этого запуска: ' + dir,
    );
    return;
  }
  rmSync(dir, { recursive: true, force: true });
};
process.on('exit', removeOwnScratch);
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
])
  process.on(signal, () => {
    console.error('copy-precheck: прервано (' + signal + ')');
    process.exit(code);
  });

const fail = (message) => {
  console.error('copy-precheck: ' + message);
  process.exit(2);
};
// Пути в сообщении — не больше limit строк.
const listed = (paths, limit = 20) =>
  paths.slice(0, limit).join('\n  ') +
  (paths.length > limit ? `\n  … и ещё ${paths.length - limit}` : '');
const gib = (bytes) => (bytes / 2 ** 30).toFixed(1) + ' ГБ';
const arg = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const root = arg('--root') && realpathSync(resolve(arg('--root')));
const workspace = arg('--workspace') && realpathSync(resolve(arg('--workspace')));
const archive = arg('--archive') && resolve(arg('--archive'));
const image = arg('--image') ?? 'node:24.3.0-bookworm';
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
// Обычный workspace держит конфигурацию в `.devcontour-local/`; каталог данных
// прежней раскладки (`--data`) — прямо в W.
const localConfig = join(workspace, '.devcontour-local', 'config.json');
const dataConfig = join(workspace, 'config.json');
const configFile = [localConfig, dataConfig].find(existsSync);
if (!configFile) fail('config.json workspace не найден');
const target = configFile === localConfig ? ['--workspace', workspace] : ['--data', workspace];
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

// Каталоги данных относительно R: каталог данных workspace (с config.json) и
// `.devcontour-local` каждого репозитория конфигурации (базы компонентов).
const realOrResolved = (path) => (existsSync(path) ? realpathSync(path) : resolve(path));
const repositoryPaths = [
  ...(typeof config.repository === 'string' ? [config.repository] : []),
  ...[...(config.repositories ?? []), ...(config.components ?? [])]
    .map((r) => r?.path)
    .filter((p) => typeof p === 'string' && isAbsolute(p)),
];
const dataDirs = [
  ...new Set([
    relative(root, dirname(configFile)),
    ...repositoryPaths.map((p) => relative(root, join(realOrResolved(p), '.devcontour-local'))),
  ]),
].sort();

// Отпечаток каталогов данных: путь относительно base → содержимое файла
// (ссылка — её цель). Отсутствующий каталог даёт пустой отпечаток.
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
  for (const dir of dataDirs) {
    const full = join(base, dir);
    if (!existsSync(full)) continue;
    const st = lstatSync(full);
    if (st.isDirectory()) visit(full);
    else out[dir] = st.isSymbolicLink() ? 'link:' + readlinkSync(full) : 'not-a-directory';
  }
  return out;
}
const diff = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

// Место под копию: R целиком и временные копии баз для чтения их содержимого.
const usage = (path) => {
  let bytes = 0;
  const visit = (p) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) visit(join(p, name));
    else if (!st.isSymbolicLink()) bytes += Math.ceil(st.size / 4096) * 4096;
  };
  visit(path);
  return bytes;
};
const originalBefore = tree(root);
const databaseBytes = Object.keys(originalBefore)
  .filter((rel) => /\.sqlite(-wal|-shm|-journal)?$/.test(rel))
  .reduce((sum, rel) => sum + lstatSync(join(root, rel)).size, 0);
const needed = usage(root) + databaseBytes;
const required = needed + Math.max(needed * 0.05, 256 * 2 ** 20);
const space = statfsSync(tmpdir());
const free = Number(space.bavail) * Number(space.bsize);
if (free < required)
  fail(
    `недостаточно места в ${tmpdir()} для копии ${root}: нужно около ${gib(required)}, свободно ${gib(free)}. ` +
      'Освободите место или укажите TMPDIR на другом диске.',
  );

scratch = mkdtempSync(scratchPrefix);
writeFileSync(join(scratch, markerName), token);
const copy = join(scratch, 'copy');
cpSync(root, copy, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
const copyBefore = tree(copy);
const mismatch = diff(originalBefore, copyBefore);
if (mismatch.length)
  fail(
    'копия не совпала с оригиналом: во время копирования менялись каталоги данных ' +
      '(остановите writers базы и повторите):\n  ' +
      listed(mismatch),
  );

// Содержимое баз (все таблицы) отдельно от байтов файла: открытие может
// сменить journal mode, не меняя данных. Читается не сама база копии, а её
// временная копия вместе с файлами журнала: даже соединение только для
// чтения создаёт рядом с базой WAL файлы `-wal` и `-shm`, а копия, которую
// получает контейнер, должна побайтно совпадать с оригиналом.
let probes = 0;
const databases = (base) =>
  Object.fromEntries(
    Object.keys(tree(base))
      .filter((rel) => rel.endsWith('.sqlite'))
      .map((rel) => {
        const probe = join(scratch, 'db-probe-' + ++probes);
        mkdirSync(probe);
        const file = join(probe, 'state.sqlite');
        for (const suffix of ['', '-wal', '-shm', '-journal'])
          if (existsSync(join(base, rel + suffix))) cpSync(join(base, rel + suffix), file + suffix);
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((t) => t.name);
          const rows = Object.fromEntries(
            tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all()]),
          );
          return [rel, createHash('sha256').update(JSON.stringify(rows)).digest('hex')];
        } finally {
          db.close();
          rmSync(probe, { recursive: true, force: true });
        }
      }),
  );
const dataBefore = databases(copy);
const touched = diff(copyBefore, tree(copy));
if (touched.length) fail('чтение баз изменило копию до проверки:\n  ' + listed(touched));

const script = [
  'set -e',
  'git config --global --add safe.directory "*"',
  'git config --global user.name precheck && git config --global user.email precheck@example.invalid',
  'mkdir -p /opt/dc && cd /opt/dc',
  'npm install --omit=dev --ignore-scripts --no-audit --no-fund /archive/' +
    basename(archive) +
    ' >/dev/null',
  'cd /',
  `/opt/dc/node_modules/.bin/devcontour doctor --scope data ${target.map((a) => JSON.stringify(a)).join(' ')}`,
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
const copyDataChanged = diff(dataBefore, databases(copy));
const report = {
  root,
  workspace,
  archive: basename(archive),
  image,
  scope: 'data-compatibility',
  compared: dataDirs,
  dataCheckExit: status,
  originalUnchanged: originalChanged.length === 0,
  copyChanged,
  copyDataChanged,
  ...(keep ? { copy } : {}),
  output: output.slice(-20000),
};
console.log(JSON.stringify(report, null, 2));
// `--keep` оставляет копию только после завершённой проверки.
keepScratch = keep;
if (originalChanged.length) {
  console.error('copy-precheck: оригинал изменился:\n  ' + listed(originalChanged));
  process.exit(3);
}
process.exit(status === 0 ? 0 : 1);
