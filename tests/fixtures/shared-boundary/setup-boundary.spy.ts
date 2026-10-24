// Наблюдение границы общей операции подготовки (запускается из
// tests/harness-shared-setup.test.ts с --experimental-test-module-mocks).
// Шпион оборачивает настоящие функции установленного пакета: обычный setup
// проходит через них, а подменённый ответ или отказ общей операции показывает,
// что хост использует именно её ответ и не уходит в собственный алгоритм.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as real from 'devcontour-harness';
import type { FileIntent, FilePlan } from 'devcontour-harness';

type Mode = {
  plan?: (plan: FilePlan) => FilePlan;
  applyError?: Error;
  listError?: Error;
  checkError?: Error;
};
let mode: Mode = {};
const calls = {
  plan: [] as { files: FileIntent[]; root?: string }[],
  apply: [] as { plan: FilePlan; files: FileIntent[]; result?: unknown }[],
  list: [] as string[],
  check: [] as string[],
};
const reset = (next: Mode = {}) => {
  mode = next;
  for (const list of Object.values(calls)) list.length = 0;
};

mock.module('devcontour-harness', {
  namedExports: {
    ...real,
    planFileWrites: async (input: { files: FileIntent[]; root?: string }) => {
      calls.plan.push(input);
      const plan = await real.planFileWrites(input);
      return mode.plan ? mode.plan(plan) : plan;
    },
    applyFileWrites: async (plan: FilePlan, files: FileIntent[]) => {
      const call: (typeof calls.apply)[number] = { plan, files };
      calls.apply.push(call);
      if (mode.applyError) throw mode.applyError;
      call.result = await real.applyFileWrites(plan, files);
      return call.result;
    },
    listRegularFiles: async (dir: string) => {
      calls.list.push(dir);
      if (mode.listError) throw mode.listError;
      return real.listRegularFiles(dir);
    },
    checkDestination: async (path: string, options?: { root?: string }) => {
      calls.check.push(path);
      if (mode.checkError) throw mode.checkError;
      return real.checkDestination(path, options);
    },
  },
});
const { setupProject } = await import('../../../src/runner/setup.ts');

async function product() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-setup-spy-')));
  await mkdir(join(dir, 'docs'));
  await writeFile(join(dir, 'docs/spec.md'), '# Каталог\nПоиск товаров.');
  return dir;
}
async function tree(root: string) {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      if ((await lstat(path)).isDirectory()) {
        out[relative(root, path) + '/'] = 'dir';
        await walk(path);
      } else
        out[relative(root, path)] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
    }
  };
  await walk(root);
  return out;
}

test('setupProject строит намерения, отдаёт план и применение общей операции и возвращает её ответ', async () => {
  const root = await product();
  try {
    reset();
    const result = await setupProject({ repository: root, profile: 'go-api' });
    assert.equal(calls.list.length, 1, 'шаблоны перечисляет общая операция');
    assert.match(calls.list[0], /templates\/project\/?$/);
    assert.equal(calls.plan.length, 1);
    const [{ files, root: planRoot }] = calls.plan;
    assert.equal(planRoot, undefined, 'хост пишет и вне продукта: без root');
    assert.equal(
      files.at(-1)?.path,
      join(root, '.devcontour-local/config.json'),
      'config последним',
    );
    const profile = files.filter((f) => f.onExisting === 'require-identical');
    assert.deepEqual(
      profile.map((f) => f.path),
      [join(root, '.devcontour-local/profiles/go-api.json')],
    );
    assert.equal(calls.apply.length, 1);
    assert.equal(calls.apply[0].files, files, 'применяются те же намерения');
    const applied = calls.apply[0].result as { created: string[]; preserved: string[] };
    assert.equal(result.created, applied.created, 'created — ответ общей операции');
    assert.equal(result.preserved, applied.preserved);
    assert.equal(result.created.length, files.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Конфликт из ответа плана отказывает прежним текстом хоста до применения', async () => {
  const root = await product();
  try {
    // Настоящий план чистый; подменённый ответ называет конфликт, которого
    // собственная проверка хоста не нашла бы: значит, решает ответ harness.
    reset({
      plan: (plan) => ({
        ...plan,
        conflicts: 1,
        entries: plan.entries.map((e, i) =>
          i === 0
            ? { ...e, action: 'conflict', conflict: 'symlink', conflictPath: '/spy/link' }
            : e,
        ),
      }),
    });
    const before = await tree(root);
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api' }),
      (error: Error & { code?: string; issues?: unknown }) => {
        assert.equal(error.message, 'Setup не пишет через symlink: /spy/link');
        assert.equal(error.code, 'PATH_CONFLICT');
        assert.deepEqual(error.issues, [{ path: ['/spy/link'], message: 'symlink' }]);
        return true;
      },
    );
    assert.equal(calls.apply.length, 0, 'применение не вызывается');
    assert.deepEqual(await tree(root), before, 'ничего не записано');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('content-differs плана — отказ сверки профиля, но после проверок конфигурации хоста', async () => {
  const root = await product();
  try {
    const differs = (plan: FilePlan): FilePlan => ({
      ...plan,
      conflicts: 1,
      entries: plan.entries.map((e) =>
        e.path.endsWith('/profiles/go-api.json')
          ? { ...e, action: 'conflict', conflict: 'content-differs' }
          : e,
      ),
    });
    reset({ plan: differs });
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api' }),
      /^Error: Сохранённый профиль изменён; требуется явная сверка версии$/,
    );
    assert.equal(calls.apply.length, 0);
    // Чужой lock проверяется раньше конфликта профиля (прежний порядок отказов).
    await mkdir(join(root, '.devcontour-local'));
    await writeFile(join(root, '.devcontour-local/packs.lock.json'), '{"version":1,"packs":[]}');
    reset({ plan: differs });
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api' }),
      /packs\.lock\.json не соответствует выбранному профилю/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Отказ общей операции доходит до вызывающего как есть, без локального продолжения', async () => {
  const root = await product();
  try {
    const before = await tree(root);
    const applyError = new real.HarnessError('PATH_CONFLICT', 'spy: назначение изменилось');
    reset({ applyError });
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api' }),
      (e) => e === applyError,
    );
    assert.deepEqual(await tree(root), before, 'хост сам ничего не дописал');

    const listError = new real.HarnessError('INVALID_INPUT', 'spy: шаблон');
    reset({ listError });
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api' }),
      (e) => e === listError,
    );
    assert.equal(calls.plan.length, 0);
    assert.deepEqual(await tree(root), before);

    const checkError = new real.HarnessError('PATH_CONFLICT', 'spy: workspace');
    reset({ checkError });
    const workspace = join(root, '..', relative(join(root, '..'), root) + '-ws');
    await assert.rejects(
      setupProject({ repository: root, profile: 'go-api', workspace }),
      (e) => e === checkError,
    );
    assert.deepEqual(calls.check, [workspace]);
    assert.equal(calls.plan.length, 0);
    assert.deepEqual(await tree(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
