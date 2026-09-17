import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config, type Task } from '../src/core/model.ts';
import { Harness } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
export const config = (overrides: Partial<Config> = {}): Config =>
  configSchema.parse({
    version: 1,
    name: 'Test',
    repository: '/tmp',
    mode: 'demo',
    concurrency: 2,
    roles: {
      architect: { runtime: 'demo' },
      backend: { runtime: 'demo' },
      frontend: { runtime: 'demo' },
      qa: { runtime: 'demo' },
    },
    reviewer: { runtime: 'demo' },
    gates: [
      {
        id: 'test',
        kind: 'test',
        command: ['node', 'verify.mjs'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
    ...overrides,
  });
export const input = (title = 'Example task', dependsOn: string[] = []) => ({
  title,
  description: 'An observable independent outcome.',
  role: 'qa',
  dependsOn,
  acceptance: ['The expected result is checked.'],
});
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-test-'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new Harness(store, config());
  return {
    root,
    store,
    h,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function complete(h: Harness, id: string) {
  h.pause(false);
  const run = h.claim('test')!;
  if (run.taskId !== id) throw new Error('Wrong claim');
  h.phase(run.id, run.token, 'integrating', {
    candidateSha: 'candidate',
    integrationSha: 'merged',
  });
  for (const phase of ['candidate', 'integration'] as const) {
    const sha = phase === 'candidate' ? 'candidate' : 'merged';
    for (const kind of ['test', 'review'] as const)
      h.evidence(run.id, run.token, {
        kind,
        phase,
        sha,
        gate: kind === 'test' ? 'test' : 'independent-review',
        passed: true,
        command: ['fixture'],
        exitCode: 0,
        log: 'fixture',
        digest: 'fixture',
        summary: 'Unit-test fixture',
      });
  }
  h.finish(run.id, run.token, 'merged');
  return run;
}
