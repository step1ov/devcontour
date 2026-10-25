import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveProfile as harnessResolveProfile } from 'devcontour-harness';
import { HarnessError } from 'devcontour-harness/contracts';
import { resolveProfile, profilePin } from '../src/runner/packs.ts';
import { projectConfig } from '../src/runner/setup.ts';

// OP-PROFILE-01 (Q5): DevContour разрешает профили алгоритмом harness, а не
// своей копией. expected.json — выдача прежнего резолвера DevContour
// (src/runner/packs.ts на 59e5000), снятая до перехода командой
//   node --import tsx tests/fixtures/profiles-host/capture.ts
// и руками не правленная (см. комментарий в capture.ts).
const fixtures = fileURLToPath(new URL('./fixtures/profiles-host/', import.meta.url));
const repo = fixtures + 'repo';
const builtinDir = fileURLToPath(new URL('../packs/profiles/', import.meta.url));
const builtin = readdirSync(builtinDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();
type Captured = {
  ref: string;
  repositoryId: string;
  keys: string[];
  profile: Record<string, unknown> & { closure: unknown[]; source?: unknown; raw: string };
  config: unknown;
};
const expected = JSON.parse(readFileSync(fixtures + 'expected.json', 'utf8')) as Captured[];
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('Adapter output equals the previous DevContour resolver for every builtin and local profile', () => {
  assert.equal(builtin.length, 9);
  assert.deepEqual(
    expected.filter((c) => !c.ref.startsWith('./')).map((c) => c.ref),
    builtin,
  );
  // Локальные: лист без extends, local→local (через подкаталог и ромб), local→builtin.
  assert.ok(expected.some((c) => c.ref === './profiles/leaf.json' && c.repositoryId === 'api'));
  assert.ok(expected.some((c) => c.ref === './profiles/on-builtin.json'));
  for (const c of expected) {
    const actual = resolveProfile(c.ref, repo, c.repositoryId);
    // Набор и порядок ключей — как раньше, включая явные undefined-поля.
    assert.deepEqual(Object.keys(actual), c.keys, c.ref);
    // Байты сериализации совпадают: config.json и packs.lock.json не меняются.
    assert.equal(JSON.stringify(actual), JSON.stringify(c.profile), c.ref);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), c.profile, c.ref);
    // Умолчания gates, ролей и contextPacks в конфигурации setup — те же.
    assert.equal(
      JSON.stringify(projectConfig('/fixture/product', actual)),
      JSON.stringify(c.config),
      c.ref,
    );
    // Формула digest хоста сохраняется.
    assert.equal(
      actual.digest,
      actual.closure.length === 1 && !actual.source
        ? sha256(actual.raw)
        : sha256(JSON.stringify(actual.closure)),
      c.ref,
    );
  }
  // Встроенный лист закреплён байтами своего файла, как в packs.lock.json.
  for (const id of builtin) {
    const p = resolveProfile(id);
    if (p.closure.length === 1)
      assert.equal(profilePin(p).digest, sha256(readFileSync(builtinDir + id + '.json')));
  }
  // contextPacks без repositoryId получают 'main', как давал contextPackSchema.
  const onBuiltin = resolveProfile('./profiles/on-builtin.json', repo);
  assert.equal(onBuiltin.contextPacks[0]?.repositoryId, 'main');
});

test('Adapter delegates to the installed harness resolver', () => {
  const leaf = resolveProfile('./profiles/leaf.json', repo, 'api');
  const direct = harnessResolveProfile('./profiles/leaf.json', {
    repository: repo,
    repositoryId: 'api',
    builtinRoot: builtinDir,
    includeLeafContent: true,
  });
  assert.equal(leaf.raw, readFileSync(repo + '/profiles/leaf.json', 'utf8'));
  assert.equal(leaf.raw, direct.leafContent);
  assert.equal(leaf.digest, direct.digest);
  assert.deepEqual(leaf.closure, direct.closure);
  assert.deepEqual(leaf.source, { repositoryId: 'api', path: 'profiles/leaf.json' });
  // Прежний код отдавал сырой ENOENT; отказ harness называет профиль.
  assert.throws(
    () => resolveProfile('./profiles/missing.json', repo),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'INVALID_INPUT' &&
      e.message === 'Профиль не найден: profiles/missing.json',
  );
  assert.throws(
    () => resolveProfile('no-such-builtin'),
    /Профиль не найден: no-such-builtin\.json/,
  );
});

test('Profiles with toolchain stay refused by the DevContour host rule', () => {
  for (const ref of ['./profiles/toolchain.json', './profiles/on-toolchain.json']) {
    // Harness такой профиль принимает — отказ даёт именно host-правило.
    assert.ok(harnessResolveProfile(ref, { repository: repo, builtinRoot: builtinDir }).toolchain);
    assert.throws(() => resolveProfile(ref, repo), /toolchain не поддерживается DevContour/);
  }
});

test('packs.ts keeps no copy of the resolver algorithm', () => {
  const source = readFileSync(new URL('../src/runner/packs.ts', import.meta.url), 'utf8');
  assert.match(source, /from 'devcontour-harness'/);
  assert.match(source, /resolveHarnessProfile\(ref, \{/);
  assert.match(source, /includeLeafContent: true/);
  for (const marker of [
    'lstatSync',
    'readFileSync',
    'realpathSync',
    'createHash',
    'closure.push',
    'visit(',
    'orderedGates',
    'safeFile',
    'manifest.extends',
    'Цикл наследования',
    'Итоговый профиль требует',
    'Конфликт частей профиля',
    'profileSchema',
  ])
    assert.ok(!source.includes(marker), 'packs.ts всё ещё содержит ' + marker);
});
