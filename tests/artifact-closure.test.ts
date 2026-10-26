import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  artifactClosure,
  moduleSpecifiers,
  unguardedDependencies,
} from '../src/runner/artifact-closure.ts';
import { git } from '../src/runner/process.ts';

/** Репозиторий с закоммиченными файлами; корень — из mkdtemp. */
async function repo(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-closure-')));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await git(root, 'init', '-q', '-b', 'main');
  return root;
}
async function commit(root: string) {
  await git(root, 'add', '-A');
  await git(root, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}
const paths = (deps: { path: string }[]) => deps.map((d) => d.path).sort();

test('specifiers come from module syntax only, not from comments, strings, templates or regex literals', () => {
  const source = `
    // import './commented.ts';
    /* require('./block.ts') */
    import def, { a } from './static.ts';
    import type { T } from "./types.ts";
    import './side-effect.mjs';
    export * from './reexport.js';
    export { b } from './named.ts';
    import golden from '../data/golden.json' with { type: 'json' };
    const lazy = await import('./lazy.ts');
    const plain = await import(\`./template.ts\`);
    const computed = await import(\`./\${name}.ts\`);
    const cjs = require('./legacy.cjs');
    const url = new URL('../data/cases.json', import.meta.url);
    const resolved = import.meta.resolve('./resolved.ts');
    const text = "import x from './in-string.ts'";
    const tpl = \`require('./in-template.ts') \${ { from: 'x' }.from } import('./after.ts')\`;
    const re = /'(import)/g; import('./after-regex.ts'); // '
    const ok = x / 2 / 3; import('./after-division.ts');
    obj.require('./member.ts');
    import pkg from 'zod';
    import { readFile } from 'node:fs/promises';
  `;
  assert.deepEqual(
    moduleSpecifiers(source).map((s) => `${s.kind}:${s.specifier}`),
    [
      'static:./static.ts',
      'static:./types.ts',
      'static:./side-effect.mjs',
      'static:./reexport.js',
      'static:./named.ts',
      'static:../data/golden.json',
      'dynamic:./lazy.ts',
      'dynamic:./template.ts',
      'require:./legacy.cjs',
      'url:../data/cases.json',
      'resolve:./resolved.ts',
      'dynamic:./after-regex.ts',
      'dynamic:./after-division.ts',
      'static:zod',
      'static:node:fs/promises',
    ],
  );
});

test('the closure follows local imports transitively through cycles, index files, extensions and JSON, and ignores packages', async () => {
  const root = await repo({
    'tests/accept.test.ts': [
      "import { check } from './helpers.js';", // .js → .ts, как в TypeScript ESM
      "import { lib } from '../lib';", // каталог → lib/index.ts
      "import golden from '../data/golden.json' with { type: 'json' };",
      "import { z } from 'zod';",
      "const cases = new URL('../data/cases.json', import.meta.url);",
      "const { legacy } = require('./legacy.cjs');",
      "const m = await import('./more.mjs');",
      // Реализация, которую задача ещё создаст.
      "import { planned } from '../src/planned.ts';",
    ].join('\n'),
    'tests/helpers.ts':
      "import { back } from './accept.test.ts';\nimport { deep } from './deep';\n",
    'tests/deep.ts': 'export const deep = 1;\n',
    'tests/legacy.cjs': "module.exports = require('./shared.json');\n",
    'tests/shared.json': '{}\n',
    'tests/more.mjs': "export * from '../src/engine.ts';\n",
    'lib/index.ts': 'export const lib = 1;\n',
    'data/golden.json': '{"a":1}\n',
    'data/cases.json': '[]\n',
    'src/engine.ts': "import { internal } from './internal.ts';\n",
    'src/internal.ts': 'export const internal = 1;\n',
  });
  try {
    const head = await commit(root);
    const all = await artifactClosure(root, head, ['tests/accept.test.ts']);
    assert.deepEqual(paths(all), [
      'data/cases.json',
      'data/golden.json',
      'lib/index.ts',
      'src/engine.ts',
      'src/internal.ts',
      'src/planned.ts',
      'tests/accept.test.ts', // цикл helpers → accept: сам корень тоже зависимость
      'tests/deep.ts',
      'tests/helpers.ts',
      'tests/legacy.cjs',
      'tests/more.mjs',
      'tests/shared.json',
    ]);
    // Реализация под тестом не обходится: её импорты — работа исполнителя.
    const scoped = await artifactClosure(root, head, ['tests/accept.test.ts'], ['src/']);
    assert.ok(!paths(scoped).some((p) => p.startsWith('src/')));
    // Закреплённые и защищённые не называются; прочие — да.
    const unguarded = await unguardedDependencies(
      { path: root, protectedPaths: ['data/'] },
      head,
      ['tests/accept.test.ts', 'tests/helpers.ts'],
      ['src/'],
    );
    assert.deepEqual(paths(unguarded), [
      'lib/index.ts',
      'tests/deep.ts',
      'tests/legacy.cjs',
      'tests/more.mjs',
      'tests/shared.json',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the closure reads the committed revision: a missing dependency is reported, an uncommitted one is not followed', async () => {
  const root = await repo({
    'accept.mjs': "import './helper.mjs';\nimport './absent.mjs';\n",
    'helper.mjs': '',
  });
  try {
    const head = await commit(root);
    // Рабочее дерево — не ревизия закрепления.
    await writeFile(join(root, 'helper.mjs'), "import './later.mjs';\n");
    await writeFile(join(root, 'later.mjs'), '');
    const deps = await artifactClosure(root, head, ['accept.mjs']);
    assert.deepEqual(deps, [
      { path: 'helper.mjs', from: 'accept.mjs', specifier: './helper.mjs' },
      { path: 'absent.mjs', from: 'accept.mjs', specifier: './absent.mjs', missing: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dependency outside the repository, a symlinked one and an overflow are refused, not skipped', async () => {
  const root = await repo({
    'escape.mjs': "import '../outside.mjs';\n",
    'absolute.mjs': "import '/etc/hosts';\n",
    'linked.mjs': "import './link.mjs';\n",
    'target.mjs': '',
    'many.mjs': "import './a.mjs';\nimport './b.mjs';\n",
    'a.mjs': '',
    'b.mjs': '',
  });
  try {
    await symlink('target.mjs', join(root, 'link.mjs'));
    const head = await commit(root);
    await assert.rejects(
      artifactClosure(root, head, ['escape.mjs']),
      /вне репозитория: \.\.\/outside/,
    );
    await assert.rejects(
      artifactClosure(root, head, ['absolute.mjs']),
      /вне репозитория: \/etc\/hosts/,
    );
    await assert.rejects(artifactClosure(root, head, ['linked.mjs']), /symlink: link\.mjs/);
    await assert.rejects(
      artifactClosure(root, head, ['many.mjs'], [], { maxFiles: 1, maxBytes: 1 << 20 }),
      /больше предела 1 файлов/,
    );
    await assert.rejects(
      artifactClosure(root, head, ['many.mjs'], [], { maxFiles: 10, maxBytes: 4 }),
      /больше предела 4 байт/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
