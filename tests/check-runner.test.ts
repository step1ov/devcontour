import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('../', import.meta.url));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, detail: string) {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await delay(20);
  assert.ok(check(), detail);
}

/**
 * Check runs under test give every stub `CHECK_RUNNER_STUB=<the run's root>`.
 * Stubs are detached and outlive a killed check; cleanup SIGKILLs a recorded
 * pid only while it still carries the marker (the pid may have been reused).
 */
async function killRecordedStubs(root: string, files: string[]) {
  const needle = `CHECK_RUNNER_STUB=${root}`;
  const owned = async (pid: number) => {
    try {
      if (process.platform === 'linux')
        return (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').includes(needle);
      const ps = spawnSync('/bin/ps', ['-Eww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 15_000,
        killSignal: 'SIGKILL',
      });
      return ps.stdout.split(/\s/).includes(needle);
    } catch {
      return false;
    }
  };
  for (const file of files) {
    const recorded = existsSync(join(root, file))
      ? Number(await readFile(join(root, file), 'utf8'))
      : 0;
    if (Number.isInteger(recorded) && recorded > 1 && (await owned(recorded)))
      try {
        process.kill(recorded, 'SIGKILL');
      } catch {
        /* Already stopped. */
      }
  }
}

for (const detached of [false, true])
  for (const mode of ['failure', 'signal'] as const)
    test(
      `Parallel check ${mode} stops a ${detached ? 'detached' : 'grouped'} descendant that ignores SIGTERM`,
      { timeout: 20_000 },
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'check-runner-'));
        let pid: number | undefined;
        const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          stdio: 'ignore',
        });
        const scripts = join(root, 'scripts');
        await mkdir(scripts);
        for (const file of ['check.mjs', 'check-processes.mjs'])
          await copyFile(join(source, 'scripts', file), join(scripts, file));
        await writeFile(
          join(root, 'package.json'),
          JSON.stringify({
            type: 'module',
            scripts: {
              lint: 'node step.mjs lint',
              typecheck: 'node step.mjs typecheck',
              'test:affected': 'node step.mjs unexpected-next-stage',
            },
          }),
        );
        await writeFile(
          join(root, 'step.mjs'),
          `
      import {spawn} from 'node:child_process';
      import {existsSync,writeFileSync} from 'node:fs';
      const name=process.argv[2];
      writeFileSync(name+'.pid',String(process.pid));
      if(name==='typecheck') {
        spawn(process.execPath,['-e',
          "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)"
        ],{stdio:'ignore',detached:${detached}});
        setInterval(()=>{},1000);
      } else if(name==='lint') {
        const timer=setInterval(()=>{
          if(existsSync('descendant.pid')) {
            clearInterval(timer);
            ${mode === 'failure' ? 'process.exit(1)' : 'setInterval(()=>{},1000)'};
          }
        },20);
      } else writeFileSync('unexpected-stage','started');
    `,
        );
        const child = spawn(process.execPath, [join(scripts, 'check.mjs'), ...['--fast']], {
          cwd: root,
          env: { ...process.env, CHECK_RUNNER_STUB: root },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => (output += String(chunk)));
        child.stderr.on('data', (chunk) => (output += String(chunk)));
        // Bounded by the test, not by the check (whose SIGTERM handling is
        // under test): past the bound the check is SIGKILLed, so the test
        // ends and its cleanup runs before the test timeout.
        const bound = setTimeout(() => {
          output += '\n[the check hung; SIGKILLed by the test]';
          child.kill('SIGKILL');
        }, 15_000);
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        });
        try {
          await until(() => existsSync(join(root, 'descendant.pid')), 'descendant started');
          pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
          if (mode === 'signal') child.kill('SIGTERM');
          assert.equal(await closed, mode === 'signal' ? 143 : 1, output);
          await until(() => !alive(pid!), 'descendant terminated after the check stopped');
          assert.ok(alive(unrelated.pid!), 'an unrelated process is left running');
          assert.equal(
            existsSync(join(root, 'unexpected-stage')),
            false,
            'later stages never started',
          );
        } finally {
          clearTimeout(bound);
          unrelated.kill('SIGKILL');
          child.kill('SIGKILL');
          await killRecordedStubs(root, ['lint.pid', 'typecheck.pid', 'descendant.pid']);
          await rm(root, { recursive: true, force: true });
        }
      },
    );

test('Fast tier omits its named slow test but still refuses explicit skip and todo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'test-tier-refusal-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'tests'));
    await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const file of [
      'test.mjs',
      'test-tiers.mjs',
      'test-scratch.mjs',
      'test-environment.mjs',
      'check-test-environment.mjs',
      'check-processes.mjs',
    ])
      await copyFile(join(source, 'scripts', file), join(root, 'scripts', file));
    const tiersFile: string = '../scripts/test-tiers.mjs';
    const tiers = (await import(tiersFile)) as { slowTests: Record<string, true | string[]> };
    const slowPrefix = Object.values(tiers.slowTests).flatMap((entry) =>
      entry === true ? [] : entry,
    )[0];
    await writeFile(
      join(root, 'tests', 'probe.test.ts'),
      `
      import {test} from 'node:test';
      test(SLOW_NAME,()=>{throw new Error('excluded slow test ran')});
      test('unexpected skip',{skip:true},()=>{});
      test('unfinished assertion',{todo:true},()=>{});
    `.replace('SLOW_NAME', JSON.stringify(slowPrefix)),
    );
    const env = { ...process.env };
    // This child is a new runner, not a nested test worker, and runs with the
    // default concurrency, not the one check gave this suite.
    delete env.NODE_TEST_CONTEXT;
    delete env.DEVCONTOUR_TEST_CONCURRENCY;
    const result = spawnSync(process.execPath, ['scripts/test.mjs', '--fast'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /must not contain skipped or todo/);
    assert.doesNotMatch(result.stdout + result.stderr, /excluded slow test ran/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A hung test fails by name, a file that never exits is named, and late tests still run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'test-hang-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'tests'));
    await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const file of [
      'test.mjs',
      'test-tiers.mjs',
      'test-scratch.mjs',
      'test-environment.mjs',
      'check-test-environment.mjs',
      'check-processes.mjs',
    ])
      await copyFile(join(source, 'scripts', file), join(root, 'scripts', file));
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(
      join(root, 'tests', 'awaits.test.ts'),
      `
      import {test} from 'node:test';
      test('awaits forever',()=>new Promise(()=>{}));
    `,
    );
    // Файлов больше, чем исполнителей, и прогон дольше предела тишины: файлы
    // в очереди и те, чьи события ждут предыдущих, тревоги не поднимают.
    for (const n of [1, 2, 3, 4, 5])
      await writeFile(
        join(root, 'tests', `long${n}.test.ts`),
        `
        import {test} from 'node:test';
        for (const i of [1, 2, 3])
          test('long ${n}.' + i, () => new Promise((r) => setTimeout(r, 1000)));
      `,
      );
    // Тест, объявленный после await, выполняется: раннер не завершает файл раньше.
    await writeFile(
      join(root, 'tests', 'late.test.ts'),
      `
      import {test} from 'node:test';
      await new Promise((r)=>setTimeout(r,200));
      test('declared after await',()=>{});
    `,
    );
    await writeFile(
      join(root, 'tests', 'open.test.ts'),
      `
      import {test} from 'node:test';
      import {createServer} from 'node:http';
      test('leaves a server open',()=>{createServer().listen(0)});
    `,
    );
    const env: NodeJS.ProcessEnv = { ...process.env, DEVCONTOUR_TEST_TIMEOUT_MS: '2000' };
    // This child is a new runner, not a nested test worker, and runs with the
    // default concurrency, not the one check gave this suite.
    delete env.NODE_TEST_CONTEXT;
    delete env.DEVCONTOUR_TEST_CONCURRENCY;
    const result = spawnSync(process.execPath, ['scripts/test.mjs'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.signal, null, 'the runner hung: ' + result.stdout + result.stderr);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /✖ awaits forever/);
    assert.match(result.stdout, /✔ leaves a server open/);
    assert.match(result.stdout, /✔ declared after await/);
    for (const n of [1, 2, 3, 4, 5]) assert.match(result.stdout, new RegExp(`✔ long ${n}\\.3`));
    assert.match(result.stderr, /No test events for \d+ s.*: tests\/open\.test\.ts$/m);
    assert.equal(result.stderr.match(/No test events/g)?.length, 1, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Check cleanup never signals a reused PID or follows its unrelated children', async () => {
  const module: string = '../scripts/check-processes.mjs';
  const { ownedProcesses, signalSameProcesses } = (await import(module)) as {
    ownedProcesses(
      this: void,
      rows: { pid: number; ppid: number; start: string; marked: boolean }[],
      seen: Map<number, string>,
    ): Map<number, string>;
    signalSameProcesses(
      this: void,
      candidates: Map<number, string>,
      current: { pid: number; ppid: number; start: string; marked: boolean }[],
      signal: string,
      kill: (pid: number, signal: string) => void,
    ): void;
  };
  const seen = new Map([
    [901, 'old'],
    [902, 'owned'],
  ]);
  const candidates = ownedProcesses(
    [
      { pid: 901, ppid: 1, start: 'reused', marked: false },
      { pid: 903, ppid: 901, start: 'unrelated-child', marked: false },
      { pid: 902, ppid: 1, start: 'owned', marked: false },
      { pid: 904, ppid: 1, start: 'tagged-orphan', marked: true },
    ],
    seen,
  );
  assert.deepEqual(
    [...candidates],
    [
      [902, 'owned'],
      [904, 'tagged-orphan'],
    ],
  );
  const killed: number[] = [];
  signalSameProcesses(
    candidates,
    [
      { pid: 902, ppid: 1, start: 'reused-after-inventory', marked: false },
      { pid: 904, ppid: 1, start: 'tagged-orphan', marked: true },
    ],
    'SIGKILL',
    (pid) => {
      killed.push(pid);
    },
  );
  assert.deepEqual(killed, [904], 'identity changed after discovery: do not signal that PID');
});

test('Darwin process snapshots do not signal same-second PID replacements with a different invocation marker', async () => {
  const module: string = '../scripts/check-processes.mjs';
  type Row = { pid: number; ppid: number; start: string; marked: boolean };
  const { parsePsInventory, ownedProcesses, signalSameProcesses } = (await import(module)) as {
    parsePsInventory(this: void, stdout: string, mark: string): Row[];
    ownedProcesses(this: void, rows: Row[], seen: Map<number, string>): Map<number, string>;
    signalSameProcesses(
      this: void,
      candidates: Map<number, string>,
      rows: Row[],
      signal: string,
      kill: (pid: number, signal: string) => void,
    ): void;
  };
  const row = (pid: number, ppid: number, marker = '') =>
    `${pid} ${ppid} Fri Oct 30 08:00:00 2026 S node fixture ${marker ? 'DEVCONTOUR_CHECK_INVOCATION=' + marker : ''}`;
  const discovered = parsePsInventory(row(901, 1, 'owned'), 'owned');
  const candidates = ownedProcesses(discovered, new Map());
  const replacement = parsePsInventory(
    [row(901, 1, 'different'), row(902, 901)].join('\n'),
    'owned',
  );
  assert.ok(discovered[0]);
  assert.ok(replacement[0]);
  assert.equal(
    discovered[0].start,
    replacement[0].start,
    'real ps format cannot distinguish these start times',
  );
  const killed: number[] = [];
  signalSameProcesses(candidates, replacement, 'SIGKILL', (pid) => {
    killed.push(pid);
  });
  assert.equal(
    killed.length,
    0,
    'fresh invocation ownership is required even when PID/start match',
  );

  const current = parsePsInventory([row(901, 1, 'owned'), row(902, 901)].join('\n'), 'owned');
  const owned = ownedProcesses(current, new Map());
  signalSameProcesses(owned, current, 'SIGTERM', (pid) => {
    killed.push(pid);
  });
  assert.deepEqual(
    killed,
    [901, 902],
    'tagged orphans and their current untagged children still terminate',
  );

  assert.ok(current[0]);
  const rememberedOrphan = new Map([[903, current[0].start]]);
  signalSameProcesses(
    rememberedOrphan,
    parsePsInventory(row(903, 1), 'owned'),
    'SIGKILL',
    (pid) => {
      killed.push(pid);
    },
  );
  assert.deepEqual(killed, [901, 902], 'history alone cannot authorize killing an unmarked orphan');
});

test('A slow process snapshot under load does not stop the check; a lasting failure still does', async () => {
  const module: string = '../scripts/check-processes.mjs';
  const { pollFailures, POLL_FAILURE_LIMIT } = (await import(module)) as {
    pollFailures(this: void, previous: number, failed: boolean): { count: number; fatal: boolean };
    POLL_FAILURE_LIMIT: number;
  };
  assert.ok(POLL_FAILURE_LIMIT > 1);
  let count = 0;
  for (let i = 1; i < POLL_FAILURE_LIMIT; i++) {
    const next = pollFailures(count, true);
    assert.equal(next.fatal, false, `failure ${i} alone is tolerated`);
    count = next.count;
  }
  assert.equal(pollFailures(count, false).count, 0, 'a good snapshot resets the streak');
  assert.equal(pollFailures(count, true).fatal, true, 'a lasting failure stops the check');
});

/**
 * A run of the release check is bounded by the test, not by the check: the
 * check handles SIGTERM by stopping its steps, so a broken stop path would
 * ignore a polite timeout (and spawnSync would block the test's own timeout).
 * A normal run takes a few seconds; past the bound the check is SIGKILLed.
 */
const RELEASE_CHECK_BOUND_MS = 25_000;
const releaseTest = { timeout: 30_000 };
/** Stub pids a release check records; its stubs are detached and may outlive a killed check. */
const stubPidFiles = ['test.pid', 'smoke.pid', 'leak.pid'];

/** A release check over stub steps; `body` is the step script (argv[2] names the step). */
async function releaseCheck(body: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'check-release-'));
  const scripts = join(root, 'scripts');
  await mkdir(scripts);
  for (const file of ['check.mjs', 'check-processes.mjs'])
    await copyFile(join(source, 'scripts', file), join(scripts, file));
  const steps = ['check:environment', 'lint', 'build:lib', 'check:skill', 'build:assets'];
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: {
        ...Object.fromEntries(steps.map((s) => [s, `node step.mjs ${s}`])),
        test: 'node step.mjs test',
        'test:e2e': 'node step.mjs e2e',
      },
    }),
  );
  await writeFile(join(scripts, 'smoke-package.mjs'), "import '../step.mjs';\n");
  await writeFile(
    join(root, 'step.mjs'),
    `import {existsSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const name=process.argv[2]??'smoke';
const wait=(file)=>new Promise((r)=>{const t=setInterval(()=>{if(existsSync(file)){clearInterval(t);r();}},10);});
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
${body}`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVCONTOUR_TEST_CONCURRENCY: '4',
    // Inherited by every stub and its descendants: cleanup signals a recorded
    // pid only while it still carries this run's own root.
    CHECK_RUNNER_STUB: root,
    ...extraEnv,
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [join(scripts, 'check.mjs')], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, RELEASE_CHECK_BOUND_MS);
  // The exit, not the close: a stub left alive by a broken check may still
  // hold a pipe the check passed on to it.
  const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once('exit', (code, sig) => resolve([code, sig])),
  );
  clearTimeout(timer);
  await Promise.race([new Promise((done) => child.once('close', done)), delay(1000)]);
  child.stdout.destroy();
  child.stderr.destroy();
  const result = { status, signal, stdout, stderr, timedOut };
  const pid = async (file: string) => Number(await readFile(join(root, file), 'utf8'));
  /**
   * SIGKILL every recorded stub still alive (none after a working check),
   * remove a smoke log the check had no chance to remove, then the root.
   */
  const cleanup = async () => {
    await killRecordedStubs(root, stubPidFiles);
    const log = /output is held until it ends; meanwhile: (\S+)$/m.exec(stderr)?.[1];
    if (log && dirname(log) === tmpdir() && /^devcontour-check-[\w-]+\.log$/.test(basename(log)))
      await rm(log, { force: true });
    await rm(root, { recursive: true, force: true });
  };
  return { root, result, output: stdout + stderr, pid, cleanup };
}

for (const outcome of ['pass', 'smoke-fails', 'test-fails'] as const)
  test(
    `Release check runs the package smoke beside the Node suite and the browser suite after both (${outcome})`,
    releaseTest,
    async () => {
      // Overlap is proven by two things: the smoke prints as a held-back
      // section (a step alone in its stage inherits stdio and prints none), and
      // in the test-fails case the Node suite fails while the smoke still waits
      // on a file nobody writes, so the check ends only if the two ran at once
      // and the failure stopped the smoke. A passing run alone would also finish
      // if the smoke ran first. The smoke's lines must come out as one block,
      // and the browser suite starts only after the Node suite has passed.
      const { root, result, output, pid, cleanup } = await releaseCheck(`
if(name==='test') {
  writeFileSync('test.pid',String(process.pid));
  writeFileSync('concurrency',String(process.env.DEVCONTOUR_TEST_CONCURRENCY));
  console.log('ℹ tests 1');
  await wait('smoke-started');
  console.log('ℹ pass 1');
  ${outcome === 'test-fails' ? "await wait('smoke-diagnostics');process.exit(1);" : ''}
  await wait('smoke-line');
  writeFileSync('test-finished','1');
} else if(name==='smoke') {
  writeFileSync('smoke.pid',String(process.pid));
  writeFileSync('smoke-started','1');
  console.log('smoke first');
  await sleep(100);
  console.error('smoke diagnostics');
  writeFileSync('smoke-diagnostics','1');
  // Chunks of the two pipes keep their order only when apart in time.
  await sleep(100);
  ${outcome === 'smoke-fails' ? 'process.exit(1);' : ''}
  ${outcome === 'test-fails' ? "await wait('never');" : ''}
  console.log('smoke done');
  writeFileSync('smoke-line','1');
} else if(name==='e2e') {
  writeFileSync('e2e-started',existsSync('test-finished')?'after the Node suite':'too early');
  console.log('  1 passed');
}
`);
      try {
        // The run ended by itself within the bound: a check whose stop path is
        // broken waits forever for the stopped sibling.
        assert.equal(result.timedOut, false, 'the check hung: ' + output);
        assert.equal(result.status, outcome === 'pass' ? 0 : 1, output);
        // The Node suite keeps the concurrency it was given.
        assert.equal(await readFile(join(root, 'concurrency'), 'utf8'), '4');
        // Node suite lines stream unprefixed: its summary greps as in a run of its own.
        assert.match(result.stdout, /^ℹ tests 1$/m);
        // The smoke is one contiguous section with its stderr inside.
        const section = new RegExp(
          `──── smoke-package ────\nsmoke first\nsmoke diagnostics\n${outcome === 'pass' ? 'smoke done\n✔' : '(?:[^\n]*\n)*?✖'} smoke-package [^\n]*\n──── end of smoke-package ────\n`,
        );
        assert.match(result.stdout, section, result.stdout);
        // While held back, the smoke's output goes to a log named on its start
        // line; the section replaces it, so the log is gone afterwards.
        const log = /smoke-package output is held until it ends; meanwhile: (\S+)$/m.exec(
          result.stderr,
        )?.[1];
        assert.ok(log, result.stderr);
        assert.equal(existsSync(log), false, 'the smoke log is removed after its section');
        // The final line is the only authoritative result besides the exit code.
        const last = result.stderr.trimEnd().split('\n').at(-1) ?? '';
        if (outcome === 'pass') {
          assert.equal(await readFile(join(root, 'e2e-started'), 'utf8'), 'after the Node suite');
          assert.match(result.stdout, /^ {2}1 passed$/m);
          assert.match(last, /^check: passed in /);
        } else {
          assert.match(
            last,
            new RegExp(
              `^check: failed in ${outcome === 'smoke-fails' ? 'smoke-package' : 'test'} \\(`,
            ),
          );
          // The sibling that would have waited forever was stopped with the check.
          const sibling = await pid(outcome === 'smoke-fails' ? 'test.pid' : 'smoke.pid');
          await until(() => !alive(sibling), 'the other step was stopped');
          assert.equal(existsSync(join(root, 'e2e-started')), false, 'e2e never started');
        }
      } finally {
        await cleanup();
      }
    },
  );

test(
  'A step that exits but leaves a descendant holding its output does not hang the check; the descendant is stopped',
  releaseTest,
  async () => {
    const { result, output, pid, cleanup } = await releaseCheck(`
if(name==='smoke') {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],detached:true});
  writeFileSync('leak.pid',String(child.pid));
  child.unref();
  console.log('smoke line');
}
`);
    try {
      assert.equal(result.timedOut, false, 'the check hung: ' + output);
      assert.equal(result.signal, null, output);
      assert.equal(result.status, 0, output);
      assert.match(output, /✔ smoke-package [^\n]*a descendant kept its output open/);
      const leaked = await pid('leak.pid');
      await until(() => !alive(leaked), 'the leaked descendant was stopped');
    } finally {
      await cleanup();
    }
  },
);

test(
  'A bad DEVCONTOUR_TEST_CONCURRENCY fails the check before any step, and the Node suite runner reads it too',
  releaseTest,
  async () => {
    for (const value of ['0', '-1', '1.5', 'abc']) {
      const { root, result, output, cleanup } = await releaseCheck(
        "writeFileSync('started-'+name,'1');",
        { DEVCONTOUR_TEST_CONCURRENCY: value },
      );
      try {
        assert.equal(result.timedOut, false, output);
        assert.notEqual(result.status, 0, `${value}: ${output}`);
        assert.match(
          result.stderr,
          new RegExp(`DEVCONTOUR_TEST_CONCURRENCY must be a positive integer, got ${value}`),
        );
        assert.doesNotMatch(output, /▶ /, `${value}: no step started`);
        assert.deepEqual(
          (await readdir(root)).filter((f) => f.startsWith('started-')),
          [],
          `${value}: no step ran`,
        );
      } finally {
        await cleanup();
      }
    }
    // scripts/test.mjs validates the same variable itself: it refuses a bad
    // value even when it is started without check, and accepts a good one.
    const root = await mkdtemp(join(tmpdir(), 'test-concurrency-'));
    try {
      await mkdir(join(root, 'scripts'));
      await mkdir(join(root, 'tests'));
      for (const file of [
        'test.mjs',
        'test-tiers.mjs',
        'test-scratch.mjs',
        'test-environment.mjs',
        'check-test-environment.mjs',
        'check-processes.mjs',
      ])
        await copyFile(join(source, 'scripts', file), join(root, 'scripts', file));
      await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(root, 'tests', 'probe.test.ts'), '');
      const list = (value: string) => {
        const env: NodeJS.ProcessEnv = { ...process.env, DEVCONTOUR_TEST_CONCURRENCY: value };
        delete env.NODE_TEST_CONTEXT;
        return spawnSync(process.execPath, ['scripts/test.mjs', '--list'], {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 15_000,
          killSignal: 'SIGKILL',
        });
      };
      for (const value of ['0', 'abc']) {
        const refused = list(value);
        assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
        assert.match(
          refused.stderr,
          new RegExp(`DEVCONTOUR_TEST_CONCURRENCY must be a positive integer, got ${value}`),
        );
      }
      const accepted = list('3');
      assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
      assert.match(accepted.stdout, /probe\.test\.ts$/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'A step that cannot be started fails the check by name with its cause and the final line',
  releaseTest,
  async () => {
    // PATH without npm: every npm step fails to spawn (ENOENT), which emits
    // an error and possibly no exit.
    const { result, output, cleanup } = await releaseCheck('', { PATH: '/nonexistent' });
    try {
      assert.equal(result.timedOut, false, 'the check hung: ' + output);
      assert.equal(result.status, 1, output);
      const last = result.stderr.trimEnd().split('\n').at(-1) ?? '';
      assert.match(last, /^check: failed in [\w:]+: Cannot start npm: [^\n]*ENOENT/, output);
    } finally {
      await cleanup();
    }
  },
);
