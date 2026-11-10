import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => (output += String(chunk)));
        child.stderr.on('data', (chunk) => (output += String(chunk)));
        const closed = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
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
          unrelated.kill('SIGKILL');
          child.kill('SIGKILL');
          if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
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

/** A release check over stub steps; `body` is the step script (argv[2] names the step). */
async function releaseCheck(body: string) {
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
  const env: NodeJS.ProcessEnv = { ...process.env, DEVCONTOUR_TEST_CONCURRENCY: '4' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [join(scripts, 'check.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  const pid = async (file: string) => Number(await readFile(join(root, file), 'utf8'));
  return { root, result, output: result.stdout + result.stderr, pid };
}

for (const outcome of ['pass', 'e2e-fails', 'test-fails'] as const)
  test(`Release check runs the browser suite beside the Node suite, one file slot fewer, and keeps each output whole (${outcome})`, async () => {
    // The Node suite finishes only after the browser suite has printed, so a
    // passing check proves they overlap; their lines interleave in time, and
    // the browser suite's still must come out as one block. A failing suite
    // must stop the other one, which would otherwise wait forever.
    const { root, result, output, pid } = await releaseCheck(`
if(name==='test') {
  writeFileSync('test.pid',String(process.pid));
  writeFileSync('concurrency',String(process.env.DEVCONTOUR_TEST_CONCURRENCY));
  console.log('ℹ tests 1');
  await wait('e2e-started');
  console.log('ℹ pass 1');
  ${outcome === 'test-fails' ? "await wait('e2e-diagnostics');process.exit(1);" : ''}
  await wait('e2e-line');
} else if(name==='e2e') {
  writeFileSync('e2e.pid',String(process.pid));
  writeFileSync('e2e-started','1');
  console.log('e2e first');
  await sleep(100);
  console.error('e2e diagnostics');
  writeFileSync('e2e-diagnostics','1');
  // Chunks of the two pipes keep their order only when apart in time.
  await sleep(100);
  ${outcome === 'e2e-fails' ? 'process.exit(1);' : ''}
  ${outcome === 'test-fails' ? "await wait('never');" : ''}
  console.log('  1 passed');
  writeFileSync('e2e-line','1');
} else if(name==='smoke') console.log('smoke line');
`);
    try {
      assert.equal(result.status, outcome === 'pass' ? 0 : 1, output);
      assert.equal(await readFile(join(root, 'concurrency'), 'utf8'), '3');
      // Node suite lines stream unprefixed: its summary greps as in a run of its own.
      assert.match(result.stdout, /^ℹ tests 1$/m);
      // The browser suite is one contiguous section with its stderr inside.
      const section = new RegExp(
        `──── test:e2e ────\ne2e first\ne2e diagnostics\n${outcome === 'pass' ? ' {2}1 passed\n✔' : '(?:[^\n]*\n)*?✖'} test:e2e [^\n]*\n──── end of test:e2e ────\n`,
      );
      assert.match(result.stdout, section, result.stdout);
      // The final line is the only authoritative result besides the exit code.
      const last = result.stderr.trimEnd().split('\n').at(-1);
      if (outcome === 'pass') {
        assert.match(result.stdout, /──── smoke-package ────\nsmoke line\n✔ smoke-package/);
        assert.match(last ?? '', /^check: passed in /);
      } else {
        assert.match(
          last ?? '',
          new RegExp(`^check: failed in ${outcome === 'e2e-fails' ? 'test:e2e' : 'test'} \\(`),
        );
        // The sibling that would have waited forever was stopped with the check.
        const sibling = await pid(outcome === 'e2e-fails' ? 'test.pid' : 'e2e.pid');
        await until(() => !alive(sibling), 'the other suite was stopped');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('A step that exits but leaves a descendant holding its output does not hang the check; the descendant is stopped', async () => {
  const { root, result, output, pid } = await releaseCheck(`
if(name==='smoke') {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],detached:true});
  writeFileSync('leak.pid',String(child.pid));
  child.unref();
  console.log('smoke line');
}
`);
  try {
    assert.equal(result.signal, null, 'the check hung: ' + output);
    assert.equal(result.status, 0, output);
    assert.match(output, /✔ smoke-package [^\n]*a descendant kept its output open/);
    const leaked = await pid('leak.pid');
    await until(() => !alive(leaked), 'the leaked descendant was stopped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
