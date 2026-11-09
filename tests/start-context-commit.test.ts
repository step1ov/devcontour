import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoPool, testDemo } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { updateBase } from '../src/runner/base-update.ts';

const demos = demoPool(testDemo);
after(() => demos.close());

function startParagraph() {
  const start = readFileSync(new URL('../START.md', import.meta.url), 'utf8');
  const paragraph = start
    .split('\n\n')
    .find((p) => p.includes('Правки инструкций и конфигурации выполняй как ведущий агент'));
  assert.ok(paragraph, 'абзац о правке инструкций и конфигурации');
  return paragraph;
}

test('START fast-forwards the working branch to devcontour/accepted before committing updated context', () => {
  const paragraph = startParagraph();
  const ff = paragraph.indexOf('merge --ff-only devcontour/accepted');
  const commit = paragraph.indexOf('закоммить правки');
  const lock = paragraph.indexOf('context-lock');
  assert.ok(ff >= 0, 'перемотка к принятой ветке названа командой');
  assert.ok(ff < commit && commit < lock, 'перемотка → коммит → context-lock');
});

// Порядок слов не доказывает, что процедура работает. Здесь документированная
// команда исполняется как есть на настоящем Git: принятая работа есть только в
// `devcontour/accepted`, команда из START перематывает рабочую ветку, коммит
// правки ложится поверх принятого, и перенос базы не сообщает `workingBehind`.
test('The documented START command brings accepted work into the working branch, so base-update reports nothing behind', async () => {
  const command = /`(git -C <REPO> merge --ff-only devcontour\/accepted)`/.exec(startParagraph());
  assert.ok(command, 'команда перемотки — отдельный фрагмент кода');
  const seed = await demos.acquire();
  const store = new Store(join(seed.root, 'state.sqlite'));
  const config = loadConfig(join(seed.root, 'config.json'));
  const h = new DevContour(store, config);
  const scheduler = new Scheduler(h, seed.root);
  try {
    assert.equal(config.targetBranch, 'devcontour/accepted');
    const repo = config.repository;
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const contains = (ancestor: string) => {
      try {
        git('merge-base', '--is-ancestor', ancestor, 'HEAD');
        return true;
      } catch {
        return false;
      }
    };
    // Принятая работа — коммиты задач demo в `devcontour/accepted`.
    await scheduler.init();
    h.pause(false);
    await scheduler.drain();
    await scheduler.stop();
    assert.ok(store.read().tasks.every((t) => t.status === 'done'));
    assert.equal(contains('devcontour/accepted'), false, 'принятой работы нет в рабочей ветке');
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');

    // Команда START — дословно, с подставленным путём репозитория.
    const [bin, ...args] = command[1].split(' ').map((a) => (a === '<REPO>' ? repo : a));
    assert.equal(bin, 'git');
    execFileSync(bin, args, { encoding: 'utf8' });
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), branch, 'рабочая ветка та же');
    assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'devcontour/accepted'));

    // Затем — коммит правки контекста и перенос базы.
    writeFileSync(join(repo, 'CONTEXT-NOTE.md'), 'Updated context for the next stage.\n');
    git('add', 'CONTEXT-NOTE.md');
    git(
      '-c',
      'user.name=DevContour fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Update context',
    );
    const head = git('rev-parse', 'HEAD');
    const moved = await updateBase(config, seed.root);
    assert.equal(moved.workingBehind, undefined, JSON.stringify(moved));
    assert.deepEqual(
      moved.updated.map((u) => ({ to: u.to, commits: u.commits, kind: u.kind })),
      [{ to: head, commits: 1, kind: 'fast-forward' }],
    );
    assert.equal(git('rev-parse', 'devcontour/accepted'), head);
  } finally {
    await scheduler.stop();
    store.close();
    seed.release();
  }
});

// Ревью плана часто возвращает задачу, которая меняет ожидания существующих
// тестов, не называя их: указание планирования называет это заранее.
test('Planning guidance asks to name existing tests whose expectations the task changes', () => {
  const start = readFileSync(new URL('../START.md', import.meta.url), 'utf8');
  assert.match(
    start,
    /меняет поведение, которое уже проверяют существующие тесты, назови эти тесты и их новое ожидание/,
  );
  const skill = readFileSync(new URL('../skills/devcontour/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /existing tests already check, name those tests and their new expectation/);
});
