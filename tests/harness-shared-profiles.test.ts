import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveProfile as harnessResolveProfile } from 'devcontour-harness';
import { HarnessError } from 'devcontour-harness/contracts';
import { resolveProfile, profilePin } from '../src/runner/packs.ts';
import { projectConfig, setupProject } from '../src/runner/setup.ts';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

type Refusal = { ref: string; refused: boolean; message?: string };
const refusals = JSON.parse(readFileSync(fixtures + 'expected-refusals.json', 'utf8')) as Refusal[];

test('Form of DevContour profiles is kept: what the previous resolver refused is refused, what it accepted is accepted', () => {
  // Отказы прежнего резолвера (снято на 59e5000): JUnit вне репозитория и по
  // абсолютному пути, env DEVCONTOUR_*, toolchain (строгий верхний уровень
  // схемы продукта). Тексты отказов — тексты harness (K10).
  assert.deepEqual(
    refusals.map((r) => [r.ref, r.refused]),
    [
      ['./profiles/junit-outside.json', true],
      ['./profiles/junit-absolute.json', true],
      ['./profiles/devcontour-env.json', true],
      ['./profiles/toolchain.json', true],
      ['./profiles/on-toolchain.json', true],
    ],
  );
  for (const { ref } of refusals) assert.throws(() => resolveProfile(ref, repo), ref);
  assert.throws(
    () => resolveProfile('./profiles/devcontour-env.json', repo),
    /environment\.values\.DEVCONTOUR_DATA/,
  );
  for (const ref of ['./profiles/toolchain.json', './profiles/on-toolchain.json']) {
    // Без схемы продукта harness такой профиль принимает — отказ даёт форма DevContour.
    assert.ok(harnessResolveProfile(ref, { repository: repo, builtinRoot: builtinDir }).toolchain);
    assert.throws(() => resolveProfile(ref, repo), /Unrecognized key: "toolchain"/);
  }
  // Форма продукта, которую строгая схема harness отвергла бы: runtime demo и
  // reviewVendor у ролей, лишние ключи вложенных объектов, contextPacks с
  // revision/digest, env HARNESS_*, ID шага длиннее 80 знаков.
  for (const ref of ['./profiles/host-form.json', './profiles/on-host-form.json']) {
    assert.throws(
      () => harnessResolveProfile(ref, { repository: repo, builtinRoot: builtinDir }),
      ref,
    );
    const p = resolveProfile(ref, repo);
    const before = expected.find((e) => e.ref === ref)!;
    assert.equal(JSON.stringify(p), JSON.stringify(before.profile), ref);
  }
  const form = resolveProfile('./profiles/on-host-form.json', repo);
  assert.deepEqual(form.roles.mobile, {
    runtime: 'codex',
    reviewVendor: 'different-vendor',
  });
  assert.equal(form.contextPacks[0].repositoryId, 'main');
  assert.equal(form.contextPacks[0].revision, '0123456789abcdef0123456789abcdef01234567');
  assert.deepEqual(form.environment?.inherit, ['HARNESS_HOME']);
  assert.ok(form.prepare[0].id.length > 80);
});

test('packs.ts keeps no copy of the resolver algorithm', () => {
  const source = readFileSync(new URL('../src/runner/packs.ts', import.meta.url), 'utf8');
  assert.match(source, /from 'devcontour-harness'/);
  assert.match(source, /resolveHarnessProfile\(ref, \{/);
  assert.match(source, /includeLeafContent: true/);
  // Схема файла — форма продукта, её разбирает resolver harness.
  assert.match(source, /layerSchema: profileSchema/);
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
    'toolchain не поддерживается',
  ])
    assert.ok(!source.includes(marker), 'packs.ts всё ещё содержит ' + marker);
});

// DC-F003 / contract-map §34: путь отчёта JUnit с концом строки — намеренное
// отличие (тот же принцип, что §31 у путей draft). Прежний резолвер его
// принимал; resolver harness отклоняет текстом K10 до любой записи setup.
// Прочие отказы пути (выход вверх, абсолютный, обратная косая, glob) — как прежде.
test('DC-F003: путь JUnit с концом строки, вверх, абсолютный, с обратной косой или glob — отказ; setup ничего не пишет', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-junit-path-')));
  try {
    const paths: [string, RegExp][] = [
      ['test\nreport.xml', /Путь JUnit gate tests/],
      ['test\rreport.xml', /Путь JUnit gate tests/],
      ['test report.xml', /Путь JUnit gate tests/],
      ['test report.xml', /Путь JUnit gate tests/],
      ['../out.xml', /Путь JUnit gate tests/],
      ['/abs/out.xml', /Путь JUnit gate tests/],
      ['a\\b.xml', /Путь JUnit gate tests/],
      ['reports/*.xml', /Путь JUnit gate tests/],
    ];
    for (const [index, [path, refusal]] of paths.entries()) {
      const repo = join(root, 'p' + index);
      await mkdir(join(repo, 'profiles'), { recursive: true });
      await mkdir(join(repo, 'docs'));
      await writeFile(join(repo, 'docs/spec.md'), '# Каталог\nПоиск.');
      // Вход DC-F003 (codex-work/junit-newline/profile.json) с разными путями.
      await writeFile(
        join(repo, 'profiles/junit.json'),
        JSON.stringify({
          id: 'junit-path',
          version: '1.0.0',
          gates: [
            {
              id: 'tests',
              kind: 'test',
              command: ['node', '-e', '0'],
              report: { type: 'junit', path },
            },
          ],
        }),
      );
      assert.throws(
        () => resolveProfile('./profiles/junit.json', repo),
        refusal,
        JSON.stringify(path),
      );
      const before = (await readdir(repo, { recursive: true })).sort();
      await assert.rejects(
        setupProject({ repository: repo, profile: './profiles/junit.json' }),
        refusal,
        JSON.stringify(path),
      );
      assert.deepEqual(
        (await readdir(repo, { recursive: true })).sort(),
        before,
        'setup ничего не записал',
      );
    }
    // Обычный относительный путь тем же профилем по-прежнему принимается.
    const ok = join(root, 'ok');
    await mkdir(join(ok, 'profiles'), { recursive: true });
    await writeFile(
      join(ok, 'profiles/junit.json'),
      JSON.stringify({
        id: 'junit-path',
        version: '1.0.0',
        gates: [
          {
            id: 'tests',
            kind: 'test',
            command: ['node', '-e', '0'],
            report: { type: 'junit', path: 'reports/junit.xml' },
          },
        ],
      }),
    );
    assert.equal(
      resolveProfile('./profiles/junit.json', ok).gates[0].report?.path,
      'reports/junit.xml',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
