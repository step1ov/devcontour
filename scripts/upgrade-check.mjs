/**
 * T40/T41: обновление закреплённого пакета harness в DevContour между двумя
 * неизменяемыми архивами — на отдельной копии этого checkout, во временном
 * каталоге; рабочее дерево и любые реальные workspace не затрагиваются.
 *
 *   node scripts/upgrade-check.mjs <devcontour-harness-<from>.tgz> \
 *     <devcontour-harness-<to>.tgz> --to-commit <SHA исходников to> [--keep]
 *
 * Шаги (каждый — PASS или исключение с ненулевым exit):
 *  1. копия checkout (`git clone --no-local`, HEAD) закреплена на <from>:
 *     зависимость, lock и integrity соответствуют байтам архива;
 *  2. смена зависимости во второй копии (`vendor-harness.mjs`): меняются
 *     только package.json, package-lock.json и vendor/harness; версия, lock и
 *     integrity согласованы;
 *  3. состояние «до» (первая копия): принятая задача и активная попытка с
 *     живой ролью controller (аварийная остановка);
 *  4. состояние «после» (вторая копия, сразу): новая версия не перенимает живую роль прежнего
 *     процесса и не продолжает его попытку; после истечения — recovery и
 *     новая попытка с новым владением; принятая задача не меняется;
 *  5. smoke архива DevContour с новой зависимостью;
 *  6. новая версия оставляет живую роль; возврат прежнего lock ставит прежний
 *     пакет (пакет сам не обновляется), и прежняя версия отказывает над
 *     состоянием новой до записи и выдачи (T41).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'to-commit': { type: 'string' }, keep: { type: 'boolean', default: false } },
});
const [fromArg, toArg] = positionals;
const fail = (message) => {
  console.error('upgrade-check: ' + message);
  process.exit(1);
};
const archiveName = /^devcontour-harness-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/;
if (!fromArg || !toArg || !existsSync(fromArg) || !existsSync(toArg))
  fail('укажите два архива devcontour-harness-<version>.tgz');
if (!/^[0-9a-f]{40}$/.test(options['to-commit'] ?? ''))
  fail('укажите --to-commit <полный SHA исходников нового архива>');
const from = { path: resolve(fromArg), version: archiveName.exec(basename(fromArg))?.[1] };
const to = { path: resolve(toArg), version: archiveName.exec(basename(toArg))?.[1] };
if (!from.version || !to.version || from.version === to.version)
  fail('нужны два архива разных версий');

const source = fileURLToPath(new URL('../', import.meta.url));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
const work = realpathSync(mkdtempSync(join(tmpdir(), 'dc-upgrade-')));
// Две копии checkout: на прежнем пакете и после смены зависимости. Обе
// установлены заранее, чтобы шаг «после» начался, пока роль controller
// прежнего процесса ещё жива.
const before_ = join(work, 'consumer-from');
const after_ = join(work, 'consumer-to');
const state = join(work, 'state');
const results = [];
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sha512 = (path) =>
  'sha512-' + createHash('sha512').update(readFileSync(path)).digest('base64');
const run = (consumer, cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: consumer, encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
const pass = (id, detail) => {
  results.push({ id, status: 'PASS', ...detail });
  console.log(`PASS ${id}${detail ? ' ' + JSON.stringify(detail) : ''}`);
};
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const scenario = (consumer, step) => {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(consumer, 'scripts', 'upgrade-scenario.ts'), step, state],
    { cwd: consumer, encoding: 'utf8', maxBuffer: 1 << 24 },
  );
  if (r.status !== 0) throw new Error(`шаг ${step}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
};
const pinned = (consumer, archive) => {
  const pkg = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  const entry = lock.packages['node_modules/devcontour-harness'];
  const installed = JSON.parse(
    readFileSync(join(consumer, 'node_modules', 'devcontour-harness', 'package.json'), 'utf8'),
  ).version;
  const vendored = join(consumer, 'vendor', 'harness', basename(archive.path));
  check(
    pkg.dependencies['devcontour-harness'] === `file:vendor/harness/${basename(archive.path)}`,
    'зависимость не указывает на архив ' + basename(archive.path),
  );
  check(entry.version === archive.version, `lock: версия ${entry.version}`);
  check(entry.resolved === `file:vendor/harness/${basename(archive.path)}`, 'lock: resolved');
  check(entry.integrity === sha512(archive.path), 'lock: integrity не равна байтам архива');
  check(sha256(vendored) === sha256(archive.path), 'vendor: байты архива отличаются');
  check(installed === archive.version, `установлена версия ${installed}`);
  return { version: installed, integrity: entry.integrity };
};
const install = (consumer) =>
  run(consumer, 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']);

try {
  // 1. Копия checkout на прежнем пакете.
  for (const consumer of [before_, after_]) {
    execFileSync('git', ['clone', '-q', '--no-local', source, consumer]);
    run(consumer, 'git', ['checkout', '-q', '--detach', head]);
  }
  install(before_);
  pass('1-pinned-from', { head, ...pinned(before_, from) });

  // 2. Смена зависимости во второй копии: меняются только зависимость, lock и
  // vendor/harness; версия, lock и integrity согласованы.
  run(
    after_,
    process.execPath,
    ['scripts/vendor-harness.mjs', to.path, '--commit', options['to-commit']],
    {
      stdio: 'pipe',
    },
  );
  install(after_);
  const changed = run(after_, 'git', ['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
  const outside = changed.filter(
    (p) => !['package.json', 'package-lock.json'].includes(p) && !p.startsWith('vendor/harness/'),
  );
  check(outside.length === 0, 'смена зависимости изменила лишнее: ' + outside.join(', '));
  pass('2-pinned-to', { changed, ...pinned(after_, to) });

  // 3. Состояние прежней версии: принятая задача, активная попытка, живая роль.
  execFileSync('mkdir', ['-p', state]);
  const before = scenario(before_, 'before');
  check(before.harnessVersion === from.version, 'шаг before не под прежней версией');
  pass('3-state-before', { active: before.active, leader: before.leader });

  // 4. Новая версия над тем же состоянием, пока роль прежнего процесса жива.
  const after = scenario(after_, 'after');
  check(after.harnessVersion === to.version, 'шаг after не под новой версией');
  check(after.liveRefused === true, 'роль прежнего процесса истекла до шага after');
  pass('4-state-after', {
    liveRefused: after.liveRefused,
    previousAttempt: after.previousAttempt,
    newAttempt: after.newAttempt,
  });

  // 5. Smoke архива DevContour с новой зависимостью (временный архив копии).
  run(after_, 'npm', ['run', 'build:lib'], { stdio: 'pipe' });
  run(after_, 'npm', ['run', 'build:assets'], { stdio: 'pipe' });
  run(after_, process.execPath, ['scripts/smoke-package.mjs'], { stdio: 'pipe' });
  pass('5-smoke-to');

  // 6. Аварийная остановка новой версии; возврат прежнего lock ставит прежний
  // пакет (пакет сам не обновляется); прежняя версия отказывает до записи.
  const crash = scenario(after_, 'crash');
  check(crash.leader?.engineVersion === to.version, 'роль без версии новой версии');
  run(after_, 'git', [
    'checkout',
    '-q',
    '--',
    'package.json',
    'package-lock.json',
    'vendor/harness',
  ]);
  rmSync(join(after_, 'vendor', 'harness', basename(to.path)), { force: true });
  install(after_);
  pass('6a-lock-pins-from', pinned(after_, from));
  const refused = scenario(after_, 'old-refuses');
  check(refused.harnessVersion === from.version, 'отказ не прежней версии');
  pass('6b-old-refuses-new-state', { refusal: refused.refusal });

  writeFileSync(join(work, 'upgrade-check.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ from: from.version, to: to.version, results }, null, 2));
} catch (error) {
  results.push({ status: 'FAIL', error: String(error?.stack ?? error) });
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  // Удаляется только созданный здесь временный каталог.
  if (
    !options.keep &&
    dirname(work) === realpathSync(tmpdir()) &&
    basename(work).startsWith('dc-upgrade-')
  )
    rmSync(work, { recursive: true, force: true });
  else console.log('upgrade-check: каталог сохранён: ' + work);
}
