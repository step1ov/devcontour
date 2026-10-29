import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
for (const mode of ['pass', 'fail', 'cancel', 'fast', 'unit'] as const)
  test(`Runner preflight ${mode}: tools share the isolated HOME and fail before tests`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'suite-preflight-'));
    try {
      await mkdir(join(root, 'scripts'));
      await mkdir(join(root, 'tests'));
      await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
      for (const file of [
        'test.mjs',
        'test-tiers.mjs',
        'test-environment.mjs',
        'check-test-environment.mjs',
        'check-processes.mjs',
      ])
        await copyFile(join(source, 'scripts', file), join(root, 'scripts', file));
      // Instrument the external-tool worker, leaving the runner, isolation and
      // subprocess supervision real. No Docker/browser installation is needed.
      await writeFile(
        join(root, 'scripts', 'check-test-tools.mjs'),
        `
        import {writeFileSync} from 'node:fs';
        import assert from 'node:assert/strict';
        assert.notEqual(process.env.HOME, process.env.PREFLIGHT_ORIGINAL_HOME);
        writeFileSync('tool-home', process.env.HOME);
        if (process.env.PREFLIGHT_FIXTURE_MODE === 'cancel') {
          setTimeout(()=>process.kill(process.ppid,'SIGTERM'),50);
          setInterval(()=>{},1000);
        } else if (process.env.PREFLIGHT_FIXTURE_MODE !== 'pass') throw new Error('tool unavailable');
      `,
      );
      await writeFile(
        join(root, 'tests', mode === 'unit' ? 'unit.test.ts' : 'preview.test.ts'),
        `
        import {test} from 'node:test';
        import {writeFileSync} from 'node:fs';
        test('fixture passes',()=>writeFileSync('worker-home', process.env.HOME));
      `,
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PREFLIGHT_ORIGINAL_HOME: process.env.HOME,
        PREFLIGHT_FIXTURE_MODE: mode,
      };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(
        process.execPath,
        ['scripts/test.mjs', ...(mode === 'fast' ? ['--fast'] : [])],
        {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 15000,
        },
      );
      const output = result.stdout + result.stderr;
      assert.equal(result.status, mode === 'fail' ? 1 : mode === 'cancel' ? 143 : 0, output);
      if (mode === 'fast' || mode === 'unit') {
        assert.equal(existsSync(join(root, 'tool-home')), false, 'excluded tools are never probed');
        assert.ok(existsSync(join(root, 'worker-home')), 'remaining fast unit case runs');
      } else {
        const home = await readFile(join(root, 'tool-home'), 'utf8');
        assert.equal(existsSync(home), false, 'temporary tooling HOME was removed');
        if (mode === 'fail' || mode === 'cancel') {
          assert.match(output, /Isolated test prerequisites failed/);
          if (mode === 'fail') assert.match(output, /tool unavailable/);
          assert.equal(existsSync(join(root, 'worker-home')), false, 'no expensive test began');
        } else assert.equal(await readFile(join(root, 'worker-home'), 'utf8'), home);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('Real tooling worker refuses a missing Compose plugin before browser launch or image pulls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'suite-compose-preflight-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'bin'));
    await symlink(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const file of [
      'check-test-environment.mjs',
      'check-test-tools.mjs',
      'check-processes.mjs',
      'test-environment.mjs',
    ])
      await copyFile(join(source, 'scripts', file), join(root, 'scripts', file));
    const docker = join(root, 'bin', 'docker');
    await writeFile(
      docker,
      `#!${process.execPath}
      const fs=require('node:fs');
      const args=process.argv.slice(2);
      fs.appendFileSync(process.env.PREFLIGHT_TRACE, JSON.stringify({args,home:process.env.HOME})+'\\n');
      if(args[0]==='compose') {console.error('Compose plugin unavailable');process.exit(7)}
      console.log('unix:///tmp/fixture-docker.sock');
    `,
    );
    await chmod(docker, 0o755);
    const trace = join(root, 'trace');
    const result = spawnSync(process.execPath, ['scripts/check-test-environment.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: join(root, 'bin') + delimiter + process.env.PATH,
        PREFLIGHT_TRACE: trace,
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Compose plugin unavailable/);
    const calls = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; home: string });
    assert.deepEqual(
      calls.map(({ args }) => args[0]),
      ['context', 'info', 'compose'],
    );
    assert.notEqual(calls[1].home, process.env.HOME);
    assert.equal(existsSync(calls[1].home), false, 'failed tooling environment removed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
