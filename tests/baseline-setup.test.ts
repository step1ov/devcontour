// Характеристика host-поведения подготовки проекта (setupProject и CLI setup).
// Фиксирует наблюдаемые исходы, которые должны сохраниться, когда файловая
// часть подготовки (план файлов, проверка назначений и предков, create-only
// запись, продолжение) будет выполняться общей операцией harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { setupProject } from '../src/runner/setup.ts';
import { loadConfig } from '../src/runner/config.ts';
import { chooseWorkspaceMode } from '../src/runner/workspace-mode.ts';
import { command, git } from '../src/runner/process.ts';

async function temp(prefix = 'devcontour-baseline-setup-') {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function product(root?: string) {
  const dir = root ?? (await temp());
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'docs/spec.md'), '# Каталог\nПоиск товаров в настоящей базе.');
  return dir;
}

/** Полное дерево: тип, байты (SHA-256) обычных файлов, цели symlink. */
async function tree(root: string, replace?: [string, string]) {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      const rel = relative(root, path);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) out[rel] = 'symlink:' + (await readlink(path));
      else if (stat.isDirectory()) {
        out[rel + '/'] = 'dir';
        await walk(path);
      } else {
        let text = await readFile(path, 'utf8');
        if (replace) text = text.split(replace[0]).join(replace[1]);
        out[rel] = createHash('sha256').update(text).digest('hex');
      }
    }
  };
  await walk(root);
  return out;
}

type SetupOutput = { status: string; data: string; workspace?: string; created: string[] };

const rel = (root: string, paths: string[]) => paths.map((p) => relative(root, p));

test('Baseline setup: only docs/spec.md, no Git — host files and config, no .git and no state.sqlite', async () => {
  const root = await product();
  try {
    const result = await setupProject({ repository: root, profile: 'react-vite-admin' });
    assert.deepEqual(Object.keys(result).sort(), [
      'approvalMode',
      'brief',
      'created',
      'data',
      'next',
      'preserved',
      'profile',
      'repository',
      'status',
      'workspace',
    ]);
    assert.equal(result.status, 'needs-agent-bootstrap');
    assert.equal(result.repository, root);
    assert.equal(result.brief, join(root, 'docs/spec.md'));
    assert.equal(result.workspace, undefined);
    assert.equal(result.data, join(root, '.devcontour-local'));
    assert.equal(result.profile, 'react-vite-admin');
    assert.equal(result.approvalMode, 'agent');
    assert.deepEqual(result.preserved, []);
    assert.equal(result.next.length, 5);
    const created = rel(root, result.created);
    // Конфигурация публикуется последней: прерванная запись продолжается без
    // неполной политики. Перед ней — lock и снимок профиля.
    assert.deepEqual(created.slice(-3), [
      '.devcontour-local/packs.lock.json',
      '.devcontour-local/profiles/react-vite-admin.json',
      '.devcontour-local/config.json',
    ]);
    for (const path of [
      'AGENTS.md',
      'CLAUDE.md',
      '.gitignore',
      'contracts/README.md',
      'design/README.md',
      'memory/README.md',
      'docs/devcontour-start.md',
      '.agents/roles/backend.md',
      '.agents/context/workflow.md',
    ])
      assert.ok(created.includes(path), path);
    assert.equal(new Set(created).size, created.length, 'каждый файл создан один раз');
    // Ничего вне продукта и вне каталога данных хоста.
    assert.ok(result.created.every((p) => p.startsWith(root + '/')));
    assert.equal(
      await readFile(join(root, '.gitignore'), 'utf8'),
      '.devcontour-local/\n.reports/\nnode_modules/\ndist/\n.venv/\n__pycache__/\n.pytest_cache/\n.ruff_cache/\n.expo/\n.env*\n!.env.example\n',
    );
    const lock = JSON.parse(await readFile(join(result.data, 'packs.lock.json'), 'utf8')) as {
      version: number;
      packs: unknown[];
    };
    assert.equal(lock.version, 1);
    assert.equal(lock.packs.length, 1);
    const config = loadConfig(join(result.data, 'config.json'));
    assert.equal(config.repository, root);
    assert.equal(config.mode, 'local');
    assert.equal(config.approvalMode, 'agent');
    assert.equal(config.workspaceRoot, undefined);
    assert.equal(config.reviewer.runtime, 'codex');
    for (const p of ['AGENTS.md', '.agents/', 'devcontour.config.json', 'package.json'])
      assert.ok(config.protectedPaths.includes(p), p);
    const tree0 = await tree(root);
    assert.equal(tree0['.git/'], undefined);
    assert.equal(tree0['.devcontour-local/state.sqlite'], undefined);
    assert.deepEqual(
      Object.keys(tree0)
        .filter((p) => p.startsWith('.devcontour-local/') && !p.endsWith('/'))
        .sort(),
      [
        '.devcontour-local/config.json',
        '.devcontour-local/packs.lock.json',
        '.devcontour-local/profiles/react-vite-admin.json',
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Baseline setup: repeat keeps user files, overrides and profile byte-for-byte with created=[]', async () => {
  const root = await product();
  try {
    await writeFile(join(root, 'AGENTS.md'), 'Existing team rules');
    await writeFile(join(root, 'CLAUDE.md'), 'Own Claude rules\n');
    await writeFile(join(root, '.gitignore'), 'existing-ignore\n');
    const first = await setupProject({
      repository: root,
      profile: 'go-api',
      approvalMode: 'operator',
    });
    assert.deepEqual(rel(root, first.preserved).sort(), ['.gitignore', 'AGENTS.md', 'CLAUDE.md']);
    const configFile = join(first.data, 'config.json');
    const config = loadConfig(configFile);
    config.concurrency = 1;
    config.runTimeoutMs = 1_234_567;
    await writeFile(configFile, JSON.stringify(config));
    const before = await tree(root);
    const repeated = await setupProject({ repository: root, profile: 'go-api' });
    assert.deepEqual(repeated.created, []);
    assert.equal(repeated.approvalMode, 'operator');
    assert.deepEqual([...repeated.preserved].sort(), [...first.created, ...first.preserved].sort());
    assert.deepEqual(await tree(root), before, 'повтор не меняет ни одного байта');
    const after = loadConfig(configFile);
    assert.equal(after.concurrency, 1);
    assert.equal(after.runTimeoutMs, 1_234_567);
    assert.equal(after.approvalMode, 'operator');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Baseline setup: each unsafe destination or input is refused before any planned write', async () => {
  const outside = await product();
  const outsideFile = join(outside, 'target.md');
  await writeFile(outsideFile, 'outside');
  const cases: {
    name: string;
    arrange: (root: string) => Promise<void>;
    options?: (root: string) => Partial<Parameters<typeof setupProject>[0]>;
    error: RegExp;
    /** Отказ файловой части подготовки: код общей операции harness. */
    code?: 'PATH_CONFLICT';
  }[] = [
    {
      name: 'symlink ancestor of a destination',
      code: 'PATH_CONFLICT',
      arrange: (root) => symlink(outside, join(root, '.agents')),
      error: /^Setup не пишет через symlink: .*\.agents$/,
    },
    {
      name: 'symlink as the destination file',
      code: 'PATH_CONFLICT',
      arrange: (root) => symlink(outsideFile, join(root, 'AGENTS.md')),
      error: /^Setup не пишет через symlink: .*AGENTS\.md$/,
    },
    {
      name: 'regular file as a destination ancestor',
      code: 'PATH_CONFLICT',
      arrange: (root) => writeFile(join(root, 'contracts'), 'not a directory'),
      // До D1 наружу выходил сырой ENOTDIR из lstat. Общая проверка назначения
      // называет сам предок-файл — намеренное отличие (PATH_CONFLICT).
      error: /^Родитель не является каталогом: .*contracts$/,
    },
    {
      name: 'directory at a file destination',
      code: 'PATH_CONFLICT',
      arrange: (root) => mkdir(join(root, 'AGENTS.md')),
      error: /^Ожидался обычный файл: .*AGENTS\.md$/,
    },
    {
      name: 'brief outside docs',
      arrange: async () => {},
      options: () => ({ brief: join(outside, 'docs/spec.md') }),
      error: /^ТЗ должно быть Markdown-файлом внутри docs продукта$/,
    },
    {
      name: 'brief that is not Markdown',
      arrange: (root) => writeFile(join(root, 'docs/spec.txt'), 'text'),
      options: () => ({ brief: 'docs/spec.txt' }),
      error: /^ТЗ должно быть Markdown-файлом внутри docs продукта$/,
    },
    {
      name: 'empty brief',
      arrange: (root) => writeFile(join(root, 'docs/spec.md'), '  \n'),
      error: /^ТЗ пустое$/,
    },
    {
      name: 'docs is a symlink out of the product',
      arrange: async (root) => {
        await rm(join(root, 'docs'), { recursive: true });
        await symlink(join(outside, 'docs'), join(root, 'docs'));
      },
      error: /^docs должен быть внутри продукта$/,
    },
    {
      name: 'workspace and data together',
      arrange: async () => {},
      options: (root) => ({ workspace: join(root, '..', 'ws'), data: join(root, 'd') }),
      error: /^Используйте workspace или data, не оба$/,
    },
    {
      name: 'relative workspace',
      arrange: async () => {},
      options: () => ({ workspace: 'relative-ws' }),
      error: /^workspace требует абсолютный путь$/,
    },
    {
      name: 'changed packs.lock.json without config',
      arrange: async (root) => {
        await mkdir(join(root, '.devcontour-local'));
        await writeFile(
          join(root, '.devcontour-local/packs.lock.json'),
          '{"version":1,"packs":[]}',
        );
      },
      error: /^Существующий packs\.lock\.json не соответствует выбранному профилю$/,
    },
    {
      name: 'changed stored profile',
      arrange: async (root) => {
        await mkdir(join(root, '.devcontour-local/profiles'), { recursive: true });
        await writeFile(join(root, '.devcontour-local/profiles/go-api.json'), '{}');
      },
      error: /^Сохранённый профиль изменён; требуется явная сверка версии$/,
    },
  ];
  try {
    for (const c of cases) {
      const root = await product();
      try {
        await c.arrange(root);
        const before = await tree(root);
        const outsideBefore = await tree(outside);
        await assert.rejects(
          setupProject({ repository: root, profile: 'go-api', ...c.options?.(root) }),
          (error: Error & { code?: string }) => {
            // Якорь — текст сообщения (его выводит CLI), а не имя класса ошибки.
            assert.match(error.message, c.error, c.name);
            assert.equal(error.code, c.code, c.name + ': код отказа');
            return true;
          },
        );
        assert.deepEqual(await tree(root), before, c.name + ': продукт не изменён');
        assert.deepEqual(await tree(outside), outsideBefore, c.name + ': чужой каталог не изменён');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('Baseline setup: existing config of another profile, product or approval mode is refused unchanged', async () => {
  const root = await product();
  try {
    await setupProject({ repository: root, profile: 'go-api', approvalMode: 'operator' });
    const before = await tree(root);
    await assert.rejects(
      setupProject({ repository: root, profile: 'next-product' }),
      /^Error: Существующая конфигурация относится к другому продукту или профилю$/,
    );
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api', approvalMode: 'agent' }),
      /^Error: Setup не меняет установленный режим согласования; измените его явно$/,
    );
    assert.deepEqual(await tree(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Baseline setup: child of another Git repository and the DevContour checkout itself are refused', async () => {
  const root = await product();
  try {
    await git(root, 'init', '-b', 'main');
    const child = await product(join(root, 'child'));
    const before = await tree(root);
    await assert.rejects(
      setupProject({ repository: child, profile: 'go-api' }),
      /^Error: Продукт находится внутри другого Git-репозитория; выберите его корень$/,
    );
    assert.deepEqual(await tree(root), before);
    await assert.rejects(
      setupProject({ repository: resolve('.'), profile: 'go-api' }),
      /^Error: Укажите отдельный каталог продукта, а не исходники DevContour$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Baseline setup: a write failure mid-way leaves no config, and a repeat completes to the normal result', async () => {
  // Одинаковое имя каталога: config.name берётся из basename продукта.
  const clean = await product(join(await temp(), 'shop'));
  const broken = await product(join(await temp(), 'shop'));
  try {
    const reference = await setupProject({ repository: clean, profile: 'go-api' });
    // Сбой записи после части create-only файлов: каталог docs недоступен для
    // записи, файлы до него уже созданы.
    await writeFile(join(broken, 'AGENTS.md'), 'User rules');
    await chmod(join(broken, 'docs'), 0o555);
    try {
      await assert.rejects(setupProject({ repository: broken, profile: 'go-api' }), /EACCES/);
    } finally {
      await chmod(join(broken, 'docs'), 0o755);
    }
    const partial = await tree(broken);
    assert.ok(partial['.agents/'], 'часть файлов уже создана');
    assert.equal(partial['.devcontour-local/config.json'], undefined, 'готовность не объявлена');
    // Пользователь успел поправить созданный файл: продолжение его не трогает.
    await writeFile(join(broken, 'CLAUDE.md'), 'edited after interruption');
    const resumed = await setupProject({ repository: broken, profile: 'go-api' });
    assert.equal(resumed.status, 'needs-agent-bootstrap');
    assert.deepEqual(
      rel(broken, resumed.created),
      rel(clean, reference.created).filter((p) => !(p in partial)),
      'дописано ровно недостающее, в прежнем порядке',
    );
    assert.equal(await readFile(join(broken, 'AGENTS.md'), 'utf8'), 'User rules');
    assert.equal(await readFile(join(broken, 'CLAUDE.md'), 'utf8'), 'edited after interruption');
    const expected = await tree(clean);
    const actual = await tree(broken, [broken, clean]);
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      delete expected[path];
      delete actual[path];
    }
    assert.deepEqual(actual, expected, 'итог совпадает с обычным успешным setup');
  } finally {
    await chmod(join(broken, 'docs'), 0o755).catch(() => {});
    await rm(resolve(clean, '..'), { recursive: true, force: true });
    await rm(resolve(broken, '..'), { recursive: true, force: true });
  }
});

test('Baseline setup: separate workspace gives component storage, embedded gives central, wrong roots are refused', async () => {
  const root = await temp();
  try {
    const repo = await product(join(root, 'shop'));
    const workspace = join(root, 'workspace');
    await assert.rejects(
      setupProject({ repository: repo, profile: 'go-api', workspace: join(repo, 'ws') }),
      /^Error: Separate workspace должен находиться вне репозитория продукта$/,
    );
    const separate = await setupProject({ repository: repo, profile: 'go-api', workspace });
    assert.equal(separate.workspace, workspace);
    assert.equal(separate.data, join(workspace, '.devcontour-local'));
    assert.equal(
      await readFile(join(workspace, '.gitignore'), 'utf8'),
      '.devcontour-local/\n.env*\n!.env.example\n',
    );
    const c = loadConfig(join(separate.data, 'config.json'));
    assert.equal(c.workspaceMode, 'separate');
    assert.equal(c.storage, 'component');
    assert.equal(c.workspaceRoot, workspace);
    assert.deepEqual(
      c.repositories.map((r) => [r.id, r.path]),
      [['main', repo]],
    );
    const saved = await readFile(join(separate.data, 'config.json'), 'utf8');
    const again = await setupProject({ repository: repo, profile: 'go-api', workspace });
    assert.deepEqual(again.created, []);
    assert.equal(await readFile(join(separate.data, 'config.json'), 'utf8'), saved);

    const single = await product(join(root, 'single'));
    chooseWorkspaceMode(single, 'embedded');
    const other = await product(join(root, 'other'));
    await assert.rejects(
      setupProject({ repository: other, profile: 'go-api', workspace: single }),
      /^Error: Embedded workspace должен совпадать с корнем репозитория$/,
    );
    const embedded = await setupProject({
      repository: single,
      profile: 'go-api',
      workspace: single,
    });
    const e = loadConfig(join(embedded.data, 'config.json'));
    assert.equal(embedded.data, join(single, '.devcontour-local'));
    assert.equal(e.workspaceMode, 'embedded');
    assert.equal(e.storage, 'central');
    assert.deepEqual(
      e.repositories.map((r) => r.path),
      [single],
    );
    const eSaved = await readFile(join(embedded.data, 'config.json'), 'utf8');
    assert.deepEqual(
      (await setupProject({ repository: single, profile: 'go-api', workspace: single })).created,
      [],
    );
    assert.equal(await readFile(join(embedded.data, 'config.json'), 'utf8'), eSaved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Baseline CLI setup: --workspace without an approved product process is refused before any file', async () => {
  const root = await temp();
  try {
    const repo = await product(join(root, 'shop'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const before = await tree(root);
    const result = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'setup',
        '--workspace',
        workspace,
        '--repository',
        repo,
        '--profile',
        'go-api',
      ],
      resolve('.'),
    );
    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /Сначала запустите start --workspace и согласуйте продукт, архитектуру и стек в панели/,
    );
    assert.deepEqual(await tree(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Baseline CLI setup: legacy --data keeps its data root and JSON envelope', async () => {
  const root = await product();
  try {
    const data = join(root, 'legacy-data');
    const result = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'setup',
        '--repository',
        root,
        '--profile',
        'go-api',
        '--data',
        data,
      ],
      resolve('.'),
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as SetupOutput;
    assert.equal(output.status, 'needs-agent-bootstrap');
    assert.equal(output.data, data);
    assert.equal(output.workspace, undefined);
    assert.equal(output.created.at(-1), join(data, 'config.json'));
    assert.equal(loadConfig(join(data, 'config.json')).repository, root);
    await unlink(join(data, 'config.json'));
    const resumed = JSON.parse(
      (
        await command(
          [
            process.execPath,
            '--import',
            'tsx',
            'src/cli.ts',
            'setup',
            '--repository',
            root,
            '--profile',
            'go-api',
            '--data',
            data,
          ],
          resolve('.'),
        )
      ).stdout,
    ) as SetupOutput;
    assert.deepEqual(resumed.created, [join(data, 'config.json')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
