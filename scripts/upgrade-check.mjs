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
 *     состоянием новой до записи и выдачи (T41). *
 * С `--rollback --baseline-commit <SHA прежней версии DevContour>` вместо
 * шагов 3–6 выполняется T42 (`scripts/rollback-scenario.ts`) в двух
 * топологиях хранения, central и component, на настоящих Git-репозиториях:
 *  а. прерванная установка нового пакета: состояние и refs не тронуты,
 *     первое открытие новой версией ничего не переписывает, повтор проходит;
 *  б. откат только пакета при совместимом формате (штатная остановка новой
 *     версии): возврат зависимости и lock, прежняя версия читает и продолжает;
 *  в. формат изменён (аварийная остановка новой версии): прежняя версия
 *     отказывает до записи; восстановление согласованной копии всех баз;
 *     сверка Git находит принятие, о котором копия не знает, и успеха без
 *     неё нет; повторная попытка закрывает расхождение;
 *  г. откат DevContour к прежней версии после Git sync новой (receipt с
 *     `gateIdentity`): прежняя версия не продолжает без мутаций; копия баз
 *     и `git revert` коммитов общих записей, сверка и повтор.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  options: {
    'to-commit': { type: 'string' },
    keep: { type: 'boolean', default: false },
    rollback: { type: 'boolean', default: false },
    'baseline-commit': { type: 'string' },
  },
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
if (options.rollback && !/^[0-9a-f]{7,40}$/.test(options['baseline-commit'] ?? ''))
  fail('для --rollback укажите --baseline-commit <SHA прежней версии DevContour>');
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

/* ------------------------------------------------------------------ */
/* T42: прерванное обновление, откат пакета, восстановление копии       */
/* ------------------------------------------------------------------ */

/** Шаг `scripts/rollback-scenario.ts` версией из `consumer` над `dir`. */
const step = (consumer, name, dir, topology, arg) => {
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(consumer, 'scripts', 'rollback-scenario.ts'),
      name,
      dir,
      topology,
      ...(arg ? [arg] : []),
    ],
    { cwd: consumer, encoding: 'utf8', maxBuffer: 1 << 24 },
  );
  if (r.status !== 0) throw new Error(`${topology} ${name} ${arg ?? ''}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
};
const databaseFiles = (dir) =>
  [join(dir, 'workspace', '.devcontour-local'), join(dir, 'product', '.devcontour-local')]
    .filter(existsSync)
    .flatMap((d) =>
      readdirSync(d)
        .filter((f) => /^state\.sqlite(-wal|-shm)?$/.test(f))
        .map((f) => join(d, f)),
    );
/** Согласованная копия всех баз workspace — при остановленных writers. */
const backup = (dir, name) => {
  const target = join(dir, '..', name);
  for (const file of databaseFiles(dir)) {
    const to = join(target, file.slice(dir.length + 1));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(file, to);
  }
  return target;
};
/** Восстановление копии: текущие файлы баз заменяются файлами копии. */
const restore = (dir, copy) => {
  for (const file of databaseFiles(dir)) rmSync(file);
  for (const sub of ['workspace', 'product']) {
    const from = join(copy, sub, '.devcontour-local');
    if (!existsSync(from)) continue;
    for (const f of readdirSync(from))
      copyFileSync(join(from, f), join(dir, sub, '.devcontour-local', f));
  }
};
const refs = (dir) =>
  Object.fromEntries(
    ['product', 'workspace'].map((r) => [
      r,
      execFileSync('git', ['rev-parse', 'main'], { cwd: join(dir, r), encoding: 'utf8' }).trim(),
    ]),
  );
const same = (a, b, message) =>
  check(JSON.stringify(a) === JSON.stringify(b), `${message}: ${JSON.stringify({ a, b })}`);
const tasksOf = (summary) =>
  Object.fromEntries(Object.entries(summary.tasks).map(([k, v]) => [k, v.status]));
/** Смена закреплённого пакета в копии `consumer` (как при обновлении). */
const pin = (consumer, archive) => {
  run(consumer, 'git', [
    'checkout',
    '-q',
    '--',
    'package.json',
    'package-lock.json',
    'vendor/harness',
  ]);
  run(consumer, 'git', ['clean', '-qfd', '--', 'vendor/harness']);
  if (archive === to)
    run(
      consumer,
      process.execPath,
      ['scripts/vendor-harness.mjs', to.path, '--commit', options['to-commit']],
      { stdio: 'pipe' },
    );
  install(consumer);
  return pinned(consumer, archive);
};

function rollback() {
  // Прежняя версия DevContour — копия этого checkout на её коммите; файл
  // шагов один и тот же.
  const baseline = join(work, 'consumer-baseline');
  execFileSync('git', ['clone', '-q', '--no-local', source, baseline]);
  run(baseline, 'git', ['checkout', '-q', '--detach', options['baseline-commit']]);
  install(baseline);
  copyFileSync(
    join(before_, 'scripts', 'rollback-scenario.ts'),
    join(baseline, 'scripts', 'rollback-scenario.ts'),
  );
  const baselineVersion = JSON.parse(readFileSync(join(baseline, 'package.json'), 'utf8')).version;

  for (const topology of ['central', 'component']) {
    const root = join(work, 't42-' + topology);
    const dir = join(root, 'workspace-dir');
    mkdirSync(dir, { recursive: true });
    const id = (x) => `T42${x}-${topology}`;

    // а. Прерванная установка нового пакета.
    pin(after_, from);
    const init = step(before_, 'init', dir, topology);
    const refs0 = refs(dir);
    // Зависимость уже указывает на новый архив, установка обрывается.
    run(
      after_,
      process.execPath,
      ['scripts/vendor-harness.mjs', to.path, '--commit', options['to-commit']],
      { stdio: 'pipe' },
    );
    const child = spawnSync(
      'sh',
      ['-c', 'npm ci --prefer-offline --no-audit --no-fund & sleep 2; kill -9 $!'],
      {
        cwd: after_,
        encoding: 'utf8',
      },
    );
    check(child.status === 0, 'прерывание установки не выполнено');
    const interrupted = step(before_, 'read', dir, topology);
    same(interrupted.databases, init.databases, 'прерванная установка изменила базы');
    same(refs(dir), refs0, 'прерванная установка изменила Git refs');
    const pinnedTo = pin(after_, to);
    const firstOpen = step(after_, 'read', dir, topology);
    same(firstOpen.databases, init.databases, 'первое открытие новой версией переписало базы');
    pass(id('a-interrupted-install'), { pinnedTo, tasks: tasksOf(firstOpen) });

    // б. Новая версия работает и останавливается штатно; откат только пакета.
    const workTo = step(after_, 'work', dir, topology, 'B');
    check(!workTo.leader, 'штатная остановка оставила роль controller');
    const pinnedFrom = pin(after_, from);
    const back = step(after_, 'read', dir, topology);
    same(back.databases, workTo.databases, 'чтение после отката пакета изменило базы');
    check(back.tasks['Task B'].status === 'done', 'принятие новой версии потеряно');
    const resumed = step(after_, 'work', dir, topology, 'C');
    check(resumed.tasks['Task C'].status === 'done', 'прежняя версия не продолжила работу');
    const reconciledB = step(after_, 'reconcile', dir, topology);
    check(reconciledB.consistent, 'Git расходится с базой после отката пакета');
    pass(id('b-package-only'), {
      pinnedFrom,
      acceptedByNew: workTo.accepted,
      continuedByOld: resumed.accepted,
    });

    // в. Аварийная остановка новой версии: формат изменён.
    const copy = backup(dir, 'backup-before-crash');
    const beforeCrash = step(after_, 'read', dir, topology);
    pin(after_, to);
    const crash = step(after_, 'crash', dir, topology, 'D');
    check(crash.leader?.engineVersion === to.version, 'роль без версии новой версии');
    pin(after_, from);
    const refused = step(after_, 'write', dir, topology);
    check(refused.refusal, 'прежняя версия записала поверх состояния новой');
    same(refused.databases, crash.databases, 'отказ прежней версии после записи');
    restore(dir, copy);
    const restored = step(after_, 'read', dir, topology);
    same(restored.databases, beforeCrash.databases, 'восстановленная копия отличается');
    check(restored.tasks['Task D'].status !== 'done', 'ложное принятие D после восстановления');
    const drift = step(after_, 'reconcile', dir, topology);
    check(!drift.consistent, 'сверка не нашла принятие, о котором копия не знает');
    check(
      drift.unrecorded.some((c) => c.sha === crash.accepted.sha),
      'сверка не назвала коммит принятия новой версии',
    );
    const redo = step(after_, 'work', dir, topology, 'D');
    check(redo.accepted.run !== crash.accepted.run, 'повтор D — та же попытка');
    const reconciled = step(after_, 'reconcile', dir, topology);
    check(reconciled.consistent, 'расхождение Git не закрыто повтором');
    for (const t of ['Task A', 'Task B', 'Task C'])
      same(redo.tasks[t], beforeCrash.tasks[t], `история ${t} изменена`);
    pass(id('c-format-changed-restore'), {
      refusal: refused.refusal.slice(0, 160),
      unrecorded: drift.unrecorded,
      redo: redo.accepted,
    });

    // г. Откат DevContour к прежней версии после Git sync новой версии.
    const g = join(root, 'baseline-dir');
    mkdirSync(g, { recursive: true });
    const gInit = step(baseline, 'init', g, topology);
    const gSync = step(baseline, 'sync', g, topology);
    check(
      gSync.status === 'synchronized' && gSync.receiptsWithIdentity === 0,
      'sync прежней версии',
    );
    const gCopy = backup(g, 'backup-before-upgrade');
    const gBefore = step(baseline, 'read', g, topology);
    const upgraded = step(before_, 'work', g, topology, 'B');
    const newSync = step(before_, 'sync', g, topology);
    check(newSync.receiptsWithIdentity > 0, 'новая версия не выпустила receipt с тождеством');
    const oldRead = step(baseline, 'read', g, topology);
    const oldSync = step(baseline, 'sync-only', g, topology);
    check(
      oldRead.refusal || oldSync.result?.refusal || oldSync.result?.conflicts?.length,
      'прежняя версия продолжила над состоянием и receipts новой',
    );
    same(oldSync.databases, newSync.databases, 'отказ прежней версии после записи');
    restore(g, gCopy);
    for (const commit of newSync.committed) {
      const [repo, sha] = commit.split('@');
      execFileSync('git', ['revert', '--no-edit', sha], {
        cwd: join(g, repo),
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Rollback check',
          GIT_AUTHOR_EMAIL: 'rollback-check@example.invalid',
          GIT_COMMITTER_NAME: 'Rollback check',
          GIT_COMMITTER_EMAIL: 'rollback-check@example.invalid',
        },
      });
    }
    const gRestored = step(baseline, 'read', g, topology);
    same(gRestored.databases, gBefore.databases, 'восстановленная копия отличается');
    const gResync = step(baseline, 'sync-only', g, topology);
    check(
      gResync.result?.status === 'synchronized' && !gResync.result.conflicts?.length,
      'прежняя версия не синхронизирует после revert: ' + JSON.stringify(gResync.result),
    );
    const gDrift = step(baseline, 'reconcile', g, topology);
    check(
      gDrift.unrecorded.some((c) => c.sha === upgraded.accepted.sha),
      'сверка не назвала принятие новой версии',
    );
    const gRedo = step(baseline, 'work', g, topology, 'B');
    const gDone = step(baseline, 'reconcile', g, topology);
    check(gDone.consistent, 'расхождение Git не закрыто повтором прежней версией');
    same(gRedo.tasks['Task A'], gInit.tasks['Task A'], 'история A изменена');
    pass(id('d-devcontour-to-' + baselineVersion), {
      refusal: (oldRead.refusal ?? JSON.stringify(oldSync.result)).slice(0, 200),
      reverted: newSync.committed,
      unrecorded: gDrift.unrecorded,
      redo: gRedo.accepted,
    });
  }
}

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

  if (options.rollback) {
    rollback();
    writeFileSync(join(work, 'upgrade-check.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ from: from.version, to: to.version, results }, null, 2));
  } else {
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
  }
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
