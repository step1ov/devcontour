/**
 * T40/T41: обновление закреплённого пакета harness в DevContour между двумя
 * неизменяемыми архивами — на отдельной копии этого checkout, во временном
 * каталоге; рабочее дерево и любые реальные workspace не затрагиваются.
 *
 *   node scripts/upgrade-check.mjs <devcontour-harness-<from>.tgz> \
 *     <devcontour-harness-<to>.tgz> --to-commit <SHA исходников to> \
 *     [--from-commit <SHA исходников from>] [--keep]
 *
 * Если HEAD закреплён не на <from> (например, проверяется обновление на
 * версию, которую поставляет HEAD), обе копии сначала закрепляются на <from>
 * тем же `vendor-harness.mjs` локальным коммитом копии; нужен `--from-commit`.
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
 *
 * Две версии DevContour (AC25): каждая сторона — свой source snapshot со
 * своим закреплённым пакетом; режим выше годится только для обновления
 * одной зависимости.
 *
 *   node scripts/upgrade-check.mjs <devcontour-harness-<from>.tgz> \
 *     <devcontour-harness-<to>.tgz> --from-commit <SHA исходников from> \
 *     --to-commit <SHA исходников to> \
 *     --from-devcontour-commit <полный SHA DevContour «до»> \
 *     --to-devcontour-commit <полный SHA DevContour «после»> \
 *     [--to-worktree] [--out <manifest.json>] [--keep]
 *
 * Snapshot — `git clone --no-local` этого репозитория во временный каталог,
 * detached на указанном SHA; ветка, HEAD и index checkout не меняются.
 * Закрепление не перепаковывается: snapshot «до» обязан сам поставлять
 * <from>, snapshot «после» — <to>; старый пакет под новые исходники (и
 * наоборот) не ставится. `--to-worktree` (только если
 * --to-devcontour-commit — HEAD этого checkout) переносит в snapshot
 * «после» незакоммиченные изменения checkout (`git diff HEAD` и
 * неигнорируемые untracked) и сверяет их байты.
 *
 * Шаги (каждый — PASS или исключение с ненулевым exit; каждый сценарный
 * шаг — `node --import tsx <snapshot>/scripts/…` с cwd в snapshot той
 * версии, которую он представляет, production modules — только её):
 *  P1/P2. snapshot «до»/«после»: HEAD равен SHA, digest `git ls-tree -r`,
 *     зависимость, lock, integrity, байты vendored archive и строка
 *     `vendor/harness/README.md` (SHA-256 архива, commit исходников harness)
 *     соответствуют аргументам; `npm ci` своей стороны;
 *  P3. `upgrade-scenario.ts`: «до» — принятая задача и активная попытка с
 *     живой ролью; «после» — живую роль не перенимает, после истечения
 *     recovery, явный повтор — новая попытка с новым владением; принятая
 *     задача не меняется;
 *  P4. `rollback-scenario.ts` в топологиях central и component на настоящих
 *     Git-репозиториях: «до» принимает A и B и выполняет Git sync
 *     (receipts); «после» открывает без перезаписи баз, история, SHA,
 *     попытки и receipts прежние, сверка Git сходится, продолжение — C под
 *     новой версией, её Git sync не меняет прежние receipts;
 *  P5. «после» оставляет живую роль; «до» над этим состоянием отказывает до
 *     записи или не перенимает роль (дополнительная проверка старого
 *     читателя; формат состояния D1–D3 не менялся);
 *  P6. smoke архива DevContour snapshot «после».
 * Итог и fingerprints обеих сторон — `upgrade-check.json` во временном
 * каталоге и в `--out`.
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
    'from-commit': { type: 'string' },
    keep: { type: 'boolean', default: false },
    rollback: { type: 'boolean', default: false },
    'baseline-commit': { type: 'string' },
    'from-devcontour-commit': { type: 'string' },
    'to-devcontour-commit': { type: 'string' },
    'to-worktree': { type: 'boolean', default: false },
    out: { type: 'string' },
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
const fullSha = /^[0-9a-f]{40}$/;
const pairMode =
  options['from-devcontour-commit'] !== undefined || options['to-devcontour-commit'] !== undefined;
if (pairMode) {
  for (const flag of ['from-devcontour-commit', 'to-devcontour-commit', 'from-commit'])
    if (!fullSha.test(options[flag] ?? '')) fail(`укажите --${flag} <полный SHA>`);
  if (options['from-devcontour-commit'] === options['to-devcontour-commit'])
    fail('--from-devcontour-commit и --to-devcontour-commit совпадают');
  if (options.rollback || options['baseline-commit'])
    fail('--rollback/--baseline-commit не сочетаются с двумя snapshots DevContour');
} else if (options['to-worktree']) fail('--to-worktree — только с --to-devcontour-commit');
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
const scenario = (consumer, step, dir = state) => {
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(consumer, 'scripts', 'upgrade-scenario.ts'), step, dir],
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

    // в. Аварийная остановка новой версии. Если формат изменён — прежняя
    // версия отказывает до записи; если формат совместим — она не перенимает
    // живую роль новой версии и ничего не записывает (fencing). Оба исхода
    // доводятся до восстановления копии, сверки Git и повтора.
    const copy = backup(dir, 'backup-before-crash');
    const beforeCrash = step(after_, 'read', dir, topology);
    pin(after_, to);
    const crash = step(after_, 'crash', dir, topology, 'D');
    check(crash.leader?.engineVersion === to.version, 'роль без версии новой версии');
    pin(after_, from);
    const refused = step(after_, 'write', dir, topology);
    same(
      refused.databases,
      crash.databases,
      refused.refusal
        ? 'отказ прежней версии после записи'
        : 'прежняя версия записала поверх состояния новой',
    );
    if (!refused.refusal) {
      const kept = step(after_, 'read', dir, topology);
      same(kept.leader, crash.leader, 'прежняя версия перехватила живую роль новой');
    }
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
    pass(id(refused.refusal ? 'c-format-changed-restore' : 'c-compatible-crash-restore'), {
      refusal: refused.refusal?.slice(0, 160) ?? null,
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

/* ------------------------------------------------------------------ */
/* AC25: две версии DevContour, каждая со своим закреплённым пакетом    */
/* ------------------------------------------------------------------ */

const digest = (data) => createHash('sha256').update(data).digest('hex');
const git = (cwd, args, opts = {}) =>
  execFileSync('git', args, { cwd, maxBuffer: 1 << 28, ...opts });

/**
 * Незакоммиченные изменения checkout (`git diff HEAD` и неигнорируемые
 * untracked) переносятся в snapshot «после»; байты сверяются.
 */
function overlay(dir) {
  const diffArgs = ['-c', 'diff.noprefix=false', 'diff', '--binary', '--no-ext-diff', 'HEAD'];
  const diff = git(source, diffArgs);
  const changed = git(source, ['diff', '--name-only', '-z', 'HEAD'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const untracked = git(source, ['ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  if (diff.length) git(dir, ['apply', '--whitespace=nowarn', '-'], { input: diff });
  for (const file of untracked) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(source, file), join(dir, file));
  }
  check(digest(git(dir, diffArgs)) === digest(diff), 'snapshot: diff checkout перенесён не точно');
  const files = {};
  for (const file of [...changed, ...untracked].sort()) {
    const here = existsSync(join(source, file)) ? sha256(join(source, file)) : null;
    const there = existsSync(join(dir, file)) ? sha256(join(dir, file)) : null;
    check(here === there, 'snapshot: байты отличаются от checkout: ' + file);
    files[file] = here;
  }
  return { diffSha256: digest(diff), files };
}

/**
 * Source snapshot одной стороны: клон на SHA, проверка fingerprint и
 * закрепления пакета этой стороны, установка только её lock.
 */
function snapshot(name, commit, archive, harnessCommit, withWorktree) {
  const dir = join(work, name);
  execFileSync('git', ['clone', '-q', '--no-local', '--no-checkout', source, dir]);
  run(dir, 'git', ['checkout', '-q', '--detach', commit]);
  const resolved = run(dir, 'git', ['rev-parse', 'HEAD']).trim();
  check(resolved === commit, `snapshot ${name}: HEAD ${resolved}, ожидался ${commit}`);
  const tree = run(dir, 'git', ['ls-tree', '-r', '--full-tree', 'HEAD']);
  const fingerprint = {
    commit: resolved,
    tree: run(dir, 'git', ['rev-parse', 'HEAD^{tree}']).trim(),
    lsTreeSha256: digest(tree),
    trackedFiles: tree.split('\n').filter(Boolean).length,
  };
  if (withWorktree) fingerprint.worktree = overlay(dir);
  else {
    const dirty = git(source, ['status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8',
    });
    if (commit === head && dirty.trim())
      console.log(`upgrade-check: незакоммиченные изменения checkout не входят в ${name}`);
  }
  // Пакет этой стороны — тот, что поставляет её commit; не перепаковывается.
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const vendored = join(dir, 'vendor', 'harness', basename(archive.path));
  check(
    pkg.dependencies['devcontour-harness'] === `file:vendor/harness/${basename(archive.path)}`,
    `snapshot ${name} закреплён не на ${basename(archive.path)}: ` +
      pkg.dependencies['devcontour-harness'],
  );
  check(existsSync(vendored), `snapshot ${name}: нет ${vendored}`);
  const archiveSha256 = sha256(archive.path);
  check(sha256(vendored) === archiveSha256, `snapshot ${name}: байты vendored archive отличаются`);
  const readme = readFileSync(join(dir, 'vendor', 'harness', 'README.md'), 'utf8');
  const row = readme.split('\n').find((line) => line.includes(`\`${archiveSha256}\``));
  check(
    row?.includes(`\`${harnessCommit}\``) && row.includes(archive.version),
    `snapshot ${name}: vendor/harness/README.md не называет ${archive.version} ` +
      `${archiveSha256} @ ${harnessCommit}`,
  );
  install(dir);
  const pin = pinned(dir, archive);
  return {
    dir,
    devcontourVersion: pkg.version,
    harnessVersion: pin.version,
    fingerprint: {
      ...fingerprint,
      devcontourVersion: pkg.version,
      harness: {
        version: pin.version,
        archive: basename(archive.path),
        archiveSha256,
        integrity: pin.integrity,
        sourceCommit: harnessCommit,
      },
    },
  };
}

/** Байты общих записей `.devcontour` обоих репозиториев fixture. */
const sharedRecords = (dir) =>
  Object.fromEntries(
    ['product', 'workspace'].flatMap((repo) => {
      const root = join(dir, repo, '.devcontour');
      if (!existsSync(root)) return [];
      return readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const file = join(e.parentPath, e.name);
          return [file.slice(dir.length + 1), sha256(file)];
        });
    }),
  );
/** Шаг выполнен именно версией этого snapshot. */
const ran = (result, side, label) => {
  check(
    result.harnessVersion === side.harnessVersion &&
      (result.devcontourVersion ?? side.devcontourVersion) === side.devcontourVersion,
    `${label}: выполнен не версией ${side.harnessVersion}: ${result.harnessVersion}`,
  );
  return result;
};

function pairCheck() {
  const a = snapshot(
    'devcontour-from',
    options['from-devcontour-commit'],
    from,
    options['from-commit'],
    false,
  );
  pass('P1-snapshot-from', a.fingerprint);
  const b = snapshot(
    'devcontour-to',
    options['to-devcontour-commit'],
    to,
    options['to-commit'],
    options['to-worktree'],
  );
  pass('P2-snapshot-to', b.fingerprint);
  snapshots = { from: a.fingerprint, to: b.fingerprint };

  // P3. Живая роль и активная попытка «до»; «после» — fencing, recovery, повтор.
  mkdirSync(state, { recursive: true });
  const before = ran(scenario(a.dir, 'before'), a, 'before');
  const after = ran(scenario(b.dir, 'after'), b, 'after');
  check(after.liveRefused === true, 'роль прежнего процесса истекла до шага after');
  check(after.newAttempt.engineVersion === b.harnessVersion, 'новая попытка не под новой версией');
  pass('P3-lease-fencing-resume', {
    before: { accepted: before.accepted, active: before.active, leader: before.leader },
    liveRefused: after.liveRefused,
    previousAttempt: after.previousAttempt,
    newAttempt: after.newAttempt,
    leader: after.leader,
  });

  // P4. Настоящие Git-репозитории, обе топологии: история и receipts «до»
  // открываются и продолжаются «после».
  for (const topology of ['central', 'component']) {
    const dir = join(work, 'pair-' + topology, 'workspace-dir');
    mkdirSync(dir, { recursive: true });
    const label = (s) => `${topology} ${s}`;
    ran(step(a.dir, 'init', dir, topology), a, label('init'));
    ran(step(a.dir, 'work', dir, topology, 'B'), a, label('work B'));
    const syncA = ran(step(a.dir, 'sync', dir, topology), a, label('sync'));
    check(syncA.status === 'synchronized' && syncA.receipts > 0, 'Git sync прежней версии');
    const old = ran(step(a.dir, 'read', dir, topology), a, label('read'));
    check(!old.refusal, 'прежняя версия не читает своё состояние');
    const oldRuns = old.runs.map((r) => r.engineVersion);
    check(
      oldRuns.length > 0 && oldRuns.every((v) => v === a.harnessVersion),
      'fixture создан не прежним движком: ' + JSON.stringify(oldRuns),
    );
    const oldGit = ran(step(a.dir, 'reconcile', dir, topology), a, label('reconcile'));
    check(oldGit.consistent, 'Git расходится с базой прежней версии');
    const refs0 = refs(dir);
    const records0 = sharedRecords(dir);
    check(Object.keys(records0).length > 0, 'нет общих записей .devcontour');

    const opened = ran(step(b.dir, 'read', dir, topology), b, label('read'));
    check(!opened.refusal, 'новая версия не открыла состояние: ' + opened.refusal);
    same(opened.databases, old.databases, 'первое открытие новой версией переписало базы');
    same(
      { tasks: opened.tasks, runs: opened.runs, leader: opened.leader },
      { tasks: old.tasks, runs: old.runs, leader: old.leader },
      'история читается иначе',
    );
    const openedGit = ran(step(b.dir, 'reconcile', dir, topology), b, label('reconcile'));
    check(openedGit.consistent && openedGit.main === oldGit.main, 'сверка Git новой версией');
    same(sharedRecords(dir), records0, 'открытие изменило общие записи');

    const resumed = ran(step(b.dir, 'work', dir, topology, 'C'), b, label('work C'));
    check(resumed.tasks['Task C'].status === 'done', 'новая версия не продолжила цепочку');
    const fresh = resumed.runs.filter((r) => r.task === 'Task C');
    check(
      fresh.length === 1 && fresh[0].engineVersion === b.harnessVersion,
      'попытка C не под новой версией: ' + JSON.stringify(fresh),
    );
    for (const t of ['Task A', 'Task B'])
      same(resumed.tasks[t], old.tasks[t], `история ${t} изменена`);
    same(
      resumed.runs.filter((r) => r.task !== 'Task C'),
      old.runs,
      'попытки прежней версии изменены',
    );
    const syncB = ran(step(b.dir, 'sync', dir, topology), b, label('sync'));
    check(
      syncB.status === 'synchronized' && !syncB.conflicts?.length,
      'Git sync новой версии: ' + JSON.stringify(syncB.conflicts),
    );
    const records1 = sharedRecords(dir);
    // Прежние receipts и записи прежних задач — байтово те же; меняется
    // только запись продолженной задачи C.
    const rewritten = Object.keys(records0).filter(
      (p) =>
        records1[p] !== records0[p] &&
        JSON.parse(readFileSync(join(dir, p), 'utf8')).data?.title !== 'Task C',
    );
    check(rewritten.length === 0, 'Git sync новой версии изменил прежние записи: ' + rewritten);
    const newReceipts = Object.keys(records1).filter(
      (p) => !records0[p] && p.includes('/receipts/'),
    );
    check(
      newReceipts.length > 0 && Object.keys(records0).some((p) => p.includes('/receipts/')),
      'receipts прежней и новой версии не найдены',
    );
    const newGit = ran(step(b.dir, 'reconcile', dir, topology), b, label('reconcile'));
    check(newGit.consistent, 'Git расходится с базой после продолжения');
    for (const repo of ['product', 'workspace'])
      git(join(dir, repo), ['merge-base', '--is-ancestor', refs0[repo], 'main']);
    pass(`P4-${topology}-history-resume`, {
      accepted: Object.fromEntries(
        Object.entries(old.tasks)
          .filter(([, v]) => v.status === 'done')
          .map(([t, v]) => [t, v.resultSha]),
      ),
      databasesUnchangedOnOpen: old.databases,
      receiptsKept: Object.keys(records0).filter((p) => p.includes('/receipts/')),
      receiptsAdded: newReceipts,
      continued: resumed.accepted,
      engineVersions: { before: a.harnessVersion, continued: fresh[0].engineVersion },
    });
  }

  // P5. Старый читатель — действительно старый DevContour над живой ролью новой.
  const crash = ran(scenario(b.dir, 'crash'), b, 'crash');
  check(crash.leader?.engineVersion === b.harnessVersion, 'роль без версии новой версии');
  const refused = ran(scenario(a.dir, 'old-refuses'), a, 'old-refuses');
  pass('P5-old-reader-new-state', {
    refusal: refused.refusal ?? null,
    lead: refused.lead,
    issued: refused.issued,
    unchanged: refused.unchanged,
  });

  // P6. Smoke архива DevContour snapshot «после».
  run(b.dir, 'npm', ['run', 'build:lib'], { stdio: 'pipe' });
  run(b.dir, 'npm', ['run', 'build:assets'], { stdio: 'pipe' });
  run(b.dir, process.execPath, ['scripts/smoke-package.mjs'], { stdio: 'pipe' });
  pass('P6-smoke-to');
}
let snapshots;

try {
  if (pairMode) {
    pairCheck();
    const manifest = { from: from.version, to: to.version, snapshots, results };
    writeFileSync(join(work, 'upgrade-check.json'), JSON.stringify(manifest, null, 2));
    if (options.out) writeFileSync(resolve(options.out), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    // 1. Копия checkout на прежнем пакете.
    for (const consumer of [before_, after_]) {
      execFileSync('git', ['clone', '-q', '--no-local', source, consumer]);
      run(consumer, 'git', ['checkout', '-q', '--detach', head]);
      const dependency = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'))
        .dependencies['devcontour-harness'];
      if (dependency !== `file:vendor/harness/${basename(from.path)}`) {
        if (!/^[0-9a-f]{40}$/.test(options['from-commit'] ?? ''))
          fail(
            'HEAD закреплён не на ' + basename(from.path) + ': укажите --from-commit <полный SHA>',
          );
        run(
          consumer,
          process.execPath,
          ['scripts/vendor-harness.mjs', from.path, '--commit', options['from-commit']],
          { stdio: 'pipe' },
        );
        run(consumer, 'git', [
          'add',
          '-A',
          '--',
          'package.json',
          'package-lock.json',
          'vendor/harness',
        ]);
        run(consumer, 'git', [
          '-c',
          'user.name=upgrade-check',
          '-c',
          'user.email=upgrade-check@localhost',
          'commit',
          '-q',
          '-m',
          'pin ' + basename(from.path),
        ]);
      }
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
  }
} catch (error) {
  results.push({ status: 'FAIL', error: String(error?.stack ?? error) });
  console.error(JSON.stringify(results, null, 2));
  if (pairMode && options.out)
    writeFileSync(resolve(options.out), JSON.stringify({ snapshots, results }, null, 2));
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
