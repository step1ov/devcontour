import { after } from 'node:test';
import { join } from 'node:path';
import { demoPool, testDemo } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';

// The runner tests are split over several files (runner*.test.ts) so that no
// single file bounds the suite. Each file is its own process with its own
// pool of demo workspaces.
const demos = demoPool(testDemo);
after(() => demos.close());
export async function runtimeFixture() {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const scheduler = new Scheduler(h, root);
  await scheduler.init();
  return {
    root,
    config,
    store,
    h,
    scheduler,
    cleanup: async () => {
      await scheduler.stop();
      store.close();
      seed.release();
    },
  };
}
