// Снимок выдачи прежнего резолвера DevContour (до перехода на harness).
// Запуск на дереве 59e5000, где src/runner/packs.ts ещё содержал собственный
// алгоритм:
//   git show 59e5000:src/runner/packs.ts > src/runner/packs.ts   # если уже заменён
//   node --import tsx tests/fixtures/profiles-host/capture.ts
// Результат — tests/fixtures/profiles-host/expected.json; руками не правится.
import { writeFileSync, readdirSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';
import { fileURLToPath } from 'node:url';
import { resolveProfile } from '../../../src/runner/packs.ts';
import { projectConfig } from '../../../src/runner/setup.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = here + 'repo';
const builtin = readdirSync(fileURLToPath(new URL('../../../packs/profiles/', import.meta.url)))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();
const local = [
  './profiles/single.json',
  './profiles/base.json',
  './profiles/nested/extra.json',
  './profiles/leaf.json',
  './profiles/on-builtin.json',
];
const cases = [
  ...builtin.map((ref) => ({ ref, repositoryId: 'main' })),
  ...local.map((ref) => ({ ref, repositoryId: 'main' })),
  { ref: './profiles/leaf.json', repositoryId: 'api' },
];
const expected = cases.map(({ ref, repositoryId }) => {
  const p = resolveProfile(ref, repo, repositoryId);
  return {
    ref,
    repositoryId,
    keys: Object.keys(p),
    profile: p,
    config: projectConfig('/fixture/product', p),
  };
});
const out = here + 'expected.json';
const options = { ...(await resolveConfig(out)), filepath: out };
writeFileSync(out, await format(JSON.stringify(expected), options));
console.log('captured', expected.length, 'profiles');
