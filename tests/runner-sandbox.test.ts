import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler } from '../src/runner/scheduler.ts';
import { command } from '../src/runner/process.ts';
import { lsofName, osToolEnv } from '../src/runner/os-tools.ts';
import { runCheck } from 'devcontour-harness';
import { fixture, reapprove } from './helpers.ts';
import { runtimeFixture } from './runner-fixture.ts';

test('Проверка исполняется в песочнице: полезное работает, запрещённое отклоняется', async () => {
  // Прежде проверка шла обычным процессом хоста: читала базу контура,
  // писала рядом с worktree и ходила в сеть, а сверка HEAD и отслеживаемых
  // файлов после неё этого не видела. Сама проверка записывает в отчёт, что
  // удалось; внешняя сверка ниже не доверяет её словам.
  const f = await runtimeFixture();
  try {
    const outside = join(f.root, 'outside-write.txt');
    const script = `
const fs=require('fs'),net=require('net'),https=require('https'),path=require('path');
const cases=[];const ok=(id,v)=>cases.push('<testcase name="'+id+'">'+(v?'':'<failure message="'+id+'"/>')+'</testcase>');
const tryDo=(f)=>{try{f();return true}catch{return false}};
ok('reads-own-worktree', tryDo(()=>fs.readdirSync('.')));
ok('writes-scratch', tryDo(()=>fs.writeFileSync(path.join(process.env.TMPDIR,'t'),'x')));
ok('controller-db-hidden', !tryDo(()=>fs.readFileSync(${JSON.stringify(join(f.root, 'state.sqlite'))})));
ok('write-outside-denied', !tryDo(()=>fs.writeFileSync(${JSON.stringify(outside)},'x')));
ok('source-checkout-hidden', !tryDo(()=>fs.readFileSync(${JSON.stringify(join(f.config.repository, 'verify.mjs'))})));
ok('git-in-own-worktree', tryDo(()=>require('child_process').execFileSync('git',['status','--porcelain'],{stdio:'pipe'})));
const done=()=>{fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite>'+cases.join('')+'</testsuite>');process.exit(0)};
const s=net.createServer(c=>c.end('pong')).listen(0,'127.0.0.1',()=>{
  net.connect(s.address().port,'127.0.0.1').on('data',()=>{ok('localhost-works',true);s.close();
    https.get('https://example.com',{timeout:5000},()=>{ok('egress-denied',false);done()}).on('error',()=>{ok('egress-denied',true);done()}).on('timeout',function(){this.destroy()});
  }).on('error',()=>{ok('localhost-works',false);done()});
});`;
    f.h.config.gates[0].command = [process.execPath, '-e', script];
    f.h.config.gates[0].report = { type: 'junit', path: '.reports/isolation.xml' };
    reapprove(f.h);
    f.h.pause(false);
    await new Scheduler(f.h, f.root).drain();

    // Демо-фикстура приходит с уже выполненными задачами: берётся прогон,
    // созданный этим запуском.
    const run = f.store.read().runs.at(-1)!;
    const task = f.store.read().tasks.find((t) => t.id === run.taskId)!;
    const evidence = run.evidence.find((e) => e.gate === f.h.config.gates[0].id)!;
    assert.deepEqual(
      Object.fromEntries((evidence.tests ?? []).map((t) => [t.id, t.status])),
      {
        'reads-own-worktree': 'passed',
        'writes-scratch': 'passed',
        'controller-db-hidden': 'passed',
        'write-outside-denied': 'passed',
        'source-checkout-hidden': 'passed',
        'git-in-own-worktree': 'passed',
        'localhost-works': 'passed',
        'egress-denied': 'passed',
      },
      evidence.summary,
    );
    assert.equal(existsSync(outside), false, 'внешняя сверка: файла вне worktree нет');
    assert.equal(task.status, 'done', task.failure);
    // Политика записана рядом с артефактами проверки — видно, чем её ограничили.
    const policy = JSON.parse(
      await readFile(
        join(f.root, 'artifacts', run.id, 'candidate', f.h.config.gates[0].id, 'isolation.json'),
        'utf8',
      ),
    );
    assert.ok(policy.filesystem.denyRead.some((p: string) => p.endsWith('/.ssh')));
  } finally {
    await f.cleanup();
  }
});
// «Без механизма песочницы проверка не запускается; снять изоляцию можно
// только явно» — гарантия runner harness: tests/isolation.test.ts пакета (T29),
// отказ без запуска команды и явный режим none. Путь отчёта через symlink,
// разбор JUnit, распознавание отказа сети и причины провала gate —
// tests/gates.test.ts пакета.
// Предел времени: возврат к очистке по close повесил бы тест на унаследованном
// pipe — регресс должен быть провалом, а не зависанием. Шесть исходов идут
// около двух минут; предел с запасом на нагрузку полного прогона.
test(
  'Проверка не оставляет процессов — ни по таймауту, ни при отмене, ни при падении',
  { timeout: 1_200_000 },
  async () => {
    // Сигнал группе не достаёт потомка, сменившего группу и сессию: такой
    // процесс переживал проверку и продолжал вычисление. Каждый исход — с
    // отсоединившимся потомком внутри песочницы; живость проверяется по PID.
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Кроме обычного потомка — два обхода: потомок с очищенным окружением (без
    // метки) и потомок, унаследовавший stdout/stderr, из-за которого close не
    // наступал, и очистка не начиналась.
    for (const outcome of [
      'timeout',
      'cancel',
      'crash',
      'success',
      'clean-env',
      'inherited-pipes',
    ] as const) {
      const f = await runtimeFixture();
      try {
        const spawnOrphan =
          outcome === 'clean-env'
            ? `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});c.unref();console.log('ORPHAN-PID:'+c.pid);`
            : outcome === 'inherited-pipes'
              ? `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});c.unref();console.log('ORPHAN-PID:'+c.pid);`
              : `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();console.log('ORPHAN-PID:'+c.pid);`;
        const tail = {
          timeout: 'setInterval(()=>{},1000)',
          cancel: 'setInterval(()=>{},1000)',
          crash: 'process.exit(2)',
          success:
            "require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name=\\'ok\\'/></testsuite>')",
          'clean-env':
            "require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name=\\'ok\\'/></testsuite>')",
          'inherited-pipes':
            "require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name=\\'ok\\'/></testsuite>')",
        }[outcome];
        f.h.config.gates[0].command = [process.execPath, '-e', spawnOrphan + tail];
        // Таймаут с запасом на старт node под нагрузкой полного прогона: при
        // 4 с проверка иногда истекала раньше, чем потомок успевал запуститься.
        f.h.config.gates[0].timeoutMs = outcome === 'timeout' ? 15000 : 60000;
        reapprove(f.h);
        f.h.pause(false);
        const scheduler = new Scheduler(f.h, f.root);
        const draining = scheduler.drain();
        if (outcome === 'cancel') {
          // Отмена приходит, когда потомок уже запущен.
          for (
            let i = 0;
            i < 100 &&
            !f.store.read().runs.some((r) => r.status === 'active' && r.phase === 'verifying');
            i++
          )
            await new Promise((r) => setTimeout(r, 100));
          // Фиксированной паузы под нагрузкой не хватало: отмена приходила до
          // старта потомка. Ждём его PID в логе проверки (до 30 с).
          const active = f.store.read().runs.find((r) => r.status === 'active')!;
          const liveLog = join(
            f.root,
            'artifacts',
            active.id,
            'candidate',
            f.h.config.gates[0].id + '.log',
          );
          for (let i = 0; i < 300; i++) {
            const text = await readFile(liveLog, 'utf8').catch(() => '');
            if (/ORPHAN-PID:\d+/.test(text)) break;
            await new Promise((r) => setTimeout(r, 100));
          }
          f.h.cancel(active.taskId);
        }
        await draining;
        await scheduler.stop();
        // PID потомка — из лога проверки: worktree и scratch к этому моменту
        // удалены, а лог остаётся в артефактах.
        const run = f.store.read().runs.at(-1)!;
        const log = await readFile(
          join(f.root, 'artifacts', run.id, 'candidate', f.h.config.gates[0].id + '.log'),
          'utf8',
        );
        const pid = Number(/ORPHAN-PID:(\d+)/.exec(log)?.[1]);
        assert.ok(pid > 0, `${outcome}: потомок был запущен`);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(alive(pid), false, `${outcome}: отсоединившийся потомок ${pid} завершён`);
      } finally {
        await f.cleanup();
      }
    }
  },
);
test('Потомок с очищенным окружением завершается при любой локали пользователя', async () => {
  // Локаль наследуют ps и lsof: в ru_RU время старта из ps не читалось, и
  // потомок без метки, найденный только по каталогу, считался старше команды;
  // в C lsof экранировал кириллицу пути, и каталог не узнавался.
  // Команда выходит до первого опроса: потомка находит лишь поиск по каталогу.
  const cases = [
    { locale: 'ru_RU.UTF-8', prefix: 'devcontour-locale-' },
    { locale: 'C', prefix: 'devcontour-локаль-' },
  ];
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  for (const { locale, prefix } of cases) {
    process.env.LANG = process.env.LC_ALL = locale;
    const dir = await mkdtemp(join(tmpdir(), prefix));
    let pid = 0;
    try {
      const result = await command(
        [
          process.execPath,
          '-e',
          `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH}});c.unref();console.log('ORPHAN-PID:'+c.pid);`,
        ],
        dir,
        { contain: { dirs: [dir] }, timeoutMs: 30000 },
      );
      pid = Number(/ORPHAN-PID:(\d+)/.exec(result.stdout)?.[1]);
      assert.ok(pid > 0, 'потомок был запущен');
      await new Promise((r) => setTimeout(r, 300));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `потомок ${pid} завершён (локаль ${locale})`);
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      if (pid > 0)
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      if (dir.startsWith(join(tmpdir(), prefix))) await rm(dir, { recursive: true, force: true });
    }
  }
});
test('Локаль системных утилит: даты и числа в C, кодировка символов пользователя; экранирование lsof снимается', () => {
  const env = osToolEnv({ PATH: '/bin', LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8' });
  assert.equal(env.LC_ALL, undefined, 'LC_ALL перекрыл бы LC_TIME');
  assert.equal(env.LC_TIME, 'C');
  assert.equal(env.LC_CTYPE, 'ru_RU.UTF-8', 'LC_CTYPE берётся из LC_ALL');
  assert.equal(env.PATH, '/bin');
  assert.equal(osToolEnv({ LC_CTYPE: 'en_US.UTF-8' }).LC_CTYPE, 'en_US.UTF-8');
  assert.equal(lsofName('/tmp/\\xd0\\xbb\\xd0\\xbe\\xd0\\xba'), '/tmp/лок');
  assert.equal(lsofName('/tmp/a\\\\x41b'), '/tmp/a\\x41b', 'экранированная обратная косая');
  assert.equal(lsofName('/tmp/лок a'), '/tmp/лок a');
});
test('Проверка повторяется, только если песочница отказала до запуска команды', async () => {
  // Повтор по тексту stderr перезапускал уже начавшуюся команду: её первый
  // провал терялся, а побочные эффекты удваивались. Признак — метка старта,
  // которую обёртка создаёт внутри песочницы перед exec.
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'devcontour-retry-'));
  try {
    const count = join(dir, 'count.txt');
    const run = (argv: string[], env: NodeJS.ProcessEnv) =>
      runCheck(f.h, {
        argv,
        cwd: dir,
        env,
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        write: [dir],
        readable: [],
        controller: [],
        settingsDir: join(dir, 'settings'),
      });
    // Команда начала работу, напечатала ту же строку, что sandbox-runtime
    // при отказе, и упала: это её провал, повтора нет.
    const started = await run(
      [
        process.execPath,
        '-e',
        `const fs=require('fs');fs.appendFileSync(${JSON.stringify(count)},'x');console.error("Error: Shell 'bash' not found in PATH");process.exit(1)`,
      ],
      { PATH: process.env.PATH, HOME: process.env.HOME },
    );
    assert.equal(started.code, 1);
    assert.equal(started.attempts, 1);
    assert.equal(await readFile(count, 'utf8'), 'x', 'команда выполнилась ровно один раз');

    // Песочница отказала до старта (в PATH нет даже `which`): повторы идут,
    // а команда не выполнялась ни разу.
    const refused = await run(
      [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(count)},'y')`],
      { PATH: '/nonexistent', HOME: process.env.HOME },
    );
    assert.notEqual(refused.code, 0);
    assert.equal(refused.attempts, 3, 'отказ до старта повторяется');
    assert.equal(await readFile(count, 'utf8'), 'x', 'непосредственно команда не запускалась');
  } finally {
    f.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Граница закрывает исходные checkout всех репозиториев, оставляя их .git', async () => {
  // Работа идёт в своём worktree; чужое рабочее дерево исполнителю и
  // проверке не нужно. В демо-фикстуре репозиторий лежит внутри каталога
  // контура, поэтому здесь проверяется сама граница, а её исполнение — в
  // тесте песочницы проверки выше.
  const f = await runtimeFixture();
  try {
    const boundary = new Scheduler(f.h, f.root).boundary('main');
    assert.ok(boundary.hidden.includes(f.config.repository), 'исходный checkout закрыт');
    assert.ok(boundary.hidden.includes(f.root), 'каталог контура закрыт');
    assert.deepEqual(boundary.readable, [join(f.config.repository, '.git')]);
  } finally {
    await f.cleanup();
  }
});

test('Проверка, которой песочница закрыла сеть, — отказ окружения, а не провал кода', async () => {
  const f = await runtimeFixture();
  try {
    const networkCommand = [
      'sh',
      '-c',
      'echo "GET https://registry.npmjs.org/-/ping"; curl -sS -o /dev/null https://registry.npmjs.org/-/ping',
    ];
    // Проверка с сетью — отдельная проверка вида check рядом с test gate профиля.
    f.h.config.gates.push({
      ...f.h.config.gates[0],
      id: 'network-check',
      kind: 'check',
      report: undefined,
      command: networkCommand,
    });
    reapprove(f.h);
    f.h.pause(false);
    await new Scheduler(f.h, f.root).drain();
    const run = f.store.read().runs.at(-1)!;
    assert.equal(run.failureKind, 'environment', run.error);
    assert.match(run.error!, /registry\.npmjs\.org/);
    assert.match(run.error!, /isolation\.domains/);
  } finally {
    await f.cleanup();
  }
});
