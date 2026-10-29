import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';

// Run the runner helper in a separate process, exactly as suite children inherit it.
const helper = new URL('../scripts/test-environment.mjs', import.meta.url).href;
test('Suite children use disposable user caches and Git identity, including a HOME-only child', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { testEnvironment } from ${JSON.stringify(helper)};
       import { execFileSync } from 'node:child_process';
       import { chooseCheckoutRoot } from 'devcontour-harness';
       import { mkdirSync } from 'node:fs';
       import { join } from 'node:path';
       const e = testEnvironment({...process.env, XDG_CACHE_HOME:'/must-not-use', GIT_CONFIG_GLOBAL:'/must-not-use', NPM_CONFIG_CACHE:'/must-not-use'});
       try {
         Object.assign(process.env, e.env);
         const repo = join(e.home, 'repo'); mkdirSync(repo);
         const choice = chooseCheckoutRoot({stateDirs:[join(repo,'.state')],repositories:[repo]});
         const email = execFileSync('git',['config','user.email'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:e.home}}).trim();
         console.log(JSON.stringify({home:e.home,env:e.env,root:choice.root,email}));
       } finally { e.cleanup(); }`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout) as {
    home: string;
    env: Record<string, string>;
    root: string;
    email: string;
  };
  assert.ok(value.root.startsWith(value.home + sep), value.root);
  for (const name of [
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_GLOBAL',
    'NPM_CONFIG_CACHE',
    'npm_config_userconfig',
  ])
    assert.ok(value.env[name].startsWith(value.home + sep), name);
  assert.equal(value.email, 'test@example.invalid');
  assert.equal(existsSync(value.home), false, 'temporary home removed after the child exits');
});
