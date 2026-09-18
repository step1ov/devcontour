// Explicit, bounded integration check. Never invoked by npm test/check or CI.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { configSchema } from '../lib/core/model.js';
import { DevContour } from '../lib/core/service.js';
import { Store } from '../lib/core/store.js';
import { adapters } from '../lib/runner/adapters.js';
import { Scheduler } from '../lib/runner/scheduler.js';
import { git } from '../lib/runner/process.js';
import { usageTotals } from '../lib/core/usage.js';
import { doctor } from '../lib/runner/doctor.js';
import { observedCommand } from '../lib/runner/review.js';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    'author-model': { type: 'string' },
    'reviewer-model': { type: 'string' },
    'require-review-commands': { type: 'boolean', default: false },
  },
});
assert.ok(
  values.live && values['author-model'] && values['reviewer-model'],
  'Explicit opt-in required: --live --author-model ID --reviewer-model ID',
);
const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-live-')));
const repo = join(root, 'repo');
const specification =
  'Change list() to return {items, total}. Preserve the existing two items. Update names() to consume the new API and continue returning Ada,Lin.';
await mkdir(join(repo, 'src'), { recursive: true });
await writeFile(join(repo, '.gitignore'), '.reports/\n.devcontour-local/\n');
await writeFile(join(repo, 'spec.md'), specification + '\n');
await writeFile(
  join(repo, 'src/api.mjs'),
  'export const list = () => [{name:"Ada"},{name:"Lin"}];\n',
);
await writeFile(
  join(repo, 'src/consumer.mjs'),
  'import {list} from "./api.mjs"; export const names=()=>list().map(x=>x.name).join(",");\n',
);
await writeFile(
  join(repo, 'verify.mjs'),
  `import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
let failed=false;
try { const {list}=await import('./src/api.mjs'); const {names}=await import('./src/consumer.mjs');
assert.deepEqual(list(),{items:[{name:'Ada'},{name:'Lin'}],total:2}); assert.equal(names(),'Ada,Lin'); }
catch(e) {failed=true;console.error(e.message);}
if (!process.argv.includes('--read-only')) {
 mkdirSync('.reports',{recursive:true});
 writeFileSync('.reports/tests.xml','<testsuite tests="1" failures="'+(failed?1:0)+'"><testcase name="API and consumer contract">'+(failed?'<failure message="behavior mismatch"/>':'')+'</testcase></testsuite>');
} else if (!failed) console.log('REVIEW_TEST_PASS');
if(failed)process.exitCode=1;
`,
);
await git(repo, 'init', '-b', 'main');
await git(repo, 'add', '.');
await git(repo, 'commit', '-m', 'Bounded live pilot input');
// Give only workers the provider environment; test commands never receive API keys.
const inherit = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
].filter((key) => process.env[key] !== undefined);
const config = configSchema.parse({
  version: 1,
  name: 'Bounded live pilot',
  repository: repo,
  mode: 'local',
  concurrency: 1,
  maxAttempts: 1,
  runTimeoutMs: 240000,
  resourceDatabase: join(root, 'resources.sqlite'),
  roles: Object.fromEntries(
    ['architect', 'backend', 'frontend', 'qa'].map((role) => [
      role,
      { runtime: 'claude', model: values['author-model'] },
    ]),
  ),
  reviewer: { runtime: 'codex', model: values['reviewer-model'] },
  toolProfiles: {
    claude: { runtime: 'claude', environment: { inherit } },
    'codex-review': { runtime: 'codex', environment: { inherit } },
  },
  gates: [
    {
      id: 'behavior',
      kind: 'test',
      command: ['node', 'verify.mjs'],
      report: { type: 'junit', path: '.reports/tests.xml' },
    },
  ],
  protectedPaths: ['verify.mjs', 'spec.md', '.gitignore'],
});
const store = new Store(join(root, 'state.sqlite'));
const h = new DevContour(store, config);
const board = h.createBoard('Live API change', '', 'main');
const contract = h.contract('Pinned API contract', specification, { actor: 'operator' }, 'main');
h.addTask(board.id, {
  contracts: [contract.id],
  title: 'Change API and preserve consumer',
  description: specification,
  role: 'backend',
  acceptance: [specification],
  writePaths: ['src/'],
});
h.approve(board.id, undefined, { actor: 'operator' });
let calls = 0;
const bounded = (adapter) => ({
  ...adapter,
  async execute(request) {
    assert.ok(calls < 3, 'Pilot invocation limit reached');
    calls++;
    console.log(
      `Call ${calls}/3: ${adapter.name}, ${request.review ? 'review' : 'implementation'}`,
    );
    const strictReview = request.review && values['require-review-commands'];
    const result = await adapter.execute({
      ...request,
      prompt:
        request.prompt +
        (strictReview
          ? '\nExecute node verify.mjs --read-only in the provided cwd. Report its exact exit code and output in execution. Do not edit any files.'
          : ''),
    });
    if (strictReview)
      assert.ok(
        observedCommand(result.inspection, 'node verify.mjs --read-only', 'REVIEW_TEST_PASS'),
        'Reviewer did not execute the required read-only test; pilot fails',
      );
    return result;
  },
});
const scheduler = new Scheduler(h, root, {
  ...adapters,
  claude: bounded(adapters.claude),
  codex: bounded(adapters.codex),
});
console.log(`Local artifacts: ${root}`);
const started = Date.now();
let setupError;
try {
  await scheduler.init();
  const readiness = await doctor(config, root);
  await writeFile(join(root, 'doctor.json'), JSON.stringify(readiness, null, 2));
  assert.ok(readiness.ready, 'Preflight is blocked; inspect doctor.json');
  h.pause(false);
  await scheduler.drain();
} catch (error) {
  setupError = error instanceof Error ? error.message : String(error);
} finally {
  await scheduler.stop();
  const state = store.read();
  const usages = Object.values(store.localRecords('usage', 'main'));
  const report = {
    mode: 'live',
    requireReviewCommands: values['require-review-commands'],
    setupError,
    authorModel: values['author-model'],
    reviewerModel: values['reviewer-model'],
    scope: 'One pre-approved task; product planning and board acceptance are not evaluated',
    limits: { maxCalls: 3, maxAttempts: 1, timeoutMs: 240000, monetaryHardCap: false },
    durationMs: Date.now() - started,
    calls,
    passed: state.tasks[0]?.status === 'done',
    tasks: state.tasks,
    runs: state.runs,
    usage: usages,
    totals: usageTotals(usages),
  };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        calls,
        durationMs: report.durationMs,
        error: setupError ?? state.runs[0]?.error ?? null,
        totals: report.totals,
        report: join(root, 'report.json'),
      },
      null,
      2,
    ),
  );
  store.close();
  if (!report.passed) process.exitCode = 1;
}
