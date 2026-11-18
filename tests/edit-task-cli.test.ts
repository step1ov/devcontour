// CLI edit-task --file: поля, которых нет в файле, правка сохраняет — в том
// числе обязательные поля постановки (role, title, description, acceptance);
// ошибка проверки файла называет поле по-русски, а не сырой ошибкой zod (F65).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, input } from './helpers.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { command, git } from '../src/runner/process.ts';
import { cliCommand } from './cli-command.ts';

test('edit-task --file без role и других обязательных полей сохраняет их из текущей задачи (F65)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-edit-task-')));
  const repo = join(root, 'repo'),
    data = join(root, 'data');
  try {
    await mkdir(repo);
    await mkdir(data);
    await git(repo, 'init', '-b', 'main');
    await writeFile(join(repo, 'README.md'), 'Edit fixture');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'fixture');
    const c = config({ repository: repo });
    await writeFile(join(data, 'config.json'), JSON.stringify(c));
    let h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    const board = h.createBoard('Edit board', '', 'main');
    const contract = h.contract('Edit API', 'v1', undefined, undefined, 'docs/contracts/edit.md');
    const base = h.addTask(board.id, input('Base task')).id;
    const id = h.addTask(board.id, {
      ...input('Original title', [base]),
      role: 'frontend',
      contracts: [contract.id],
    }).id;
    const before = h.store.read().tasks.find((t) => t.id === id)!;
    h.store.close();
    const cli = (file: string) =>
      command([...cliCommand(), 'edit-task', '--task', id, '--file', file, '--data', data], root);
    // Только новое название: роль, описание и приёмка остаются прежними.
    const titleOnly = join(root, 'title.json');
    await writeFile(titleOnly, JSON.stringify({ title: 'Edited title of the task' }));
    const edited = await cli(titleOnly);
    assert.equal(edited.code, 0, edited.stderr);
    h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    const after = h.store.read().tasks.find((t) => t.id === id)!;
    h.store.close();
    assert.equal(after.title, 'Edited title of the task');
    assert.equal(after.role, 'frontend');
    assert.equal(after.description, before.description);
    assert.deepEqual(after.acceptance, before.acceptance);
    // Поля со значением по умолчанию тоже не сбрасываются частичным файлом.
    assert.deepEqual(after.dependsOn, [base]);
    assert.deepEqual(after.contracts, [contract.id]);
    assert.equal(after.repositoryId, before.repositoryId);
    assert.equal(after.scope, before.scope);
    // Очистить поле можно только явным значением.
    const clear = join(root, 'clear.json');
    await writeFile(clear, JSON.stringify({ dependsOn: [] }));
    const cleared = await cli(clear);
    assert.equal(cleared.code, 0, cleared.stderr);
    h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    const emptied = h.store.read().tasks.find((t) => t.id === id)!;
    h.store.close();
    assert.deepEqual(emptied.dependsOn, []);
    assert.deepEqual(emptied.contracts, [contract.id]);
    // Неверное значение поля — понятный отказ с именем поля, а не сырой zod.
    const bad = join(root, 'bad.json');
    await writeFile(bad, JSON.stringify({ title: 'x' }));
    const refused = await cli(bad);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /Файл задачи не прошёл проверку/);
    assert.match(refused.stderr, /title: меньше допустимого \(не меньше 3 знаков\)/);
    assert.doesNotMatch(refused.stderr, /"code":|ZodError/);
  } finally {
    if (root.startsWith(await realpath(tmpdir())) && root.includes('devcontour-edit-task-'))
      await rm(root, { recursive: true, force: true });
  }
});
