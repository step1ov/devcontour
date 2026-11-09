// Ревью интеграции видит только изменения своей задачи: две доски делят
// очередь, задача одной доски интегрируется первой и двигает рабочую ветку,
// и ревью интеграции задачи другой доски не получает её уже принятых файлов.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { demoPool, testDemo } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { adapters } from '../src/runner/adapters.ts';
import { git } from '../src/runner/process.ts';

const demos = demoPool(testDemo);
after(() => demos.close());

/** Файлы диффа ревью и SHA из запроса ревьюера. */
function reviewInput(prompt: string) {
  const commit = /Review commit: ([0-9a-f]{40}) \((candidate|integration)\)\./.exec(prompt);
  const base = /Base commit: ([0-9a-f]{40})\./.exec(prompt);
  const at = prompt.indexOf('Exact diff to review:\n');
  assert.ok(commit && base && at >= 0, 'запрос ревью называет base, SHA и дифф');
  const files = [...prompt.slice(at).matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
  return { phase: commit[2], sha: commit[1], base: base[1], files };
}

test('Ревью интеграции задачи второй доски получает только её дифф, а не уже принятую работу первой доски', async () => {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const reviews: { taskId: string; phase: string; sha: string; base: string; files: string[] }[] =
    [];
  const scheduler = new Scheduler(h, root, {
    ...adapters,
    demo: {
      ...adapters.demo,
      execute: async (request) => {
        if (request.review)
          reviews.push({ taskId: request.task.id, ...reviewInput(request.prompt) });
        return adapters.demo.execute(request);
      },
    },
  });
  try {
    await scheduler.init();
    // Вторая доска рядом с открытой доской demo: их готовые задачи при
    // concurrency 2 начинают с одной базы, и одна интегрируется поверх уже
    // принятой другой.
    const second = h.createBoard('Вторая доска', 'Независимая работа в той же очереди.');
    const other = h.addTask(second.id, {
      title: 'Независимый артефакт',
      description: 'Учебный артефакт второй доски.',
      role: 'architect',
      acceptance: ['Артефакт существует и проходит проверку.'],
    });
    h.approve(second.id);
    const state = store.read();
    const roots = [
      state.tasks.find((t) => t.status === 'ready' && t.id !== other.id)!.id,
      other.id,
    ];
    assert.equal(roots.length, 2, 'две доски с готовой задачей');
    h.pause(false);
    await scheduler.drain();
    const done = store.read();
    const runs = done.runs.filter((r) => roots.includes(r.taskId) && r.status === 'succeeded');
    assert.equal(runs.length, 2, JSON.stringify(done.runs.map((r) => [r.taskId, r.status])));
    // Обе задачи начинали с одной базы: вторая интегрировалась на сдвинутую ветку.
    assert.equal(runs[0].baseSha, runs[1].baseSha, 'общая база попыток');
    const target = (r: (typeof runs)[number]) =>
      git(config.repository, 'rev-parse', `${r.integrationSha}^1`);
    const moved = [];
    for (const r of runs) if ((await target(r)) !== r.baseSha) moved.push(r);
    assert.equal(moved.length, 1, 'одна из задач интегрировалась поверх принятой другой');
    const late = moved[0];
    const early = runs.find((r) => r !== late)!;
    const review = reviews.find((r) => r.taskId === late.taskId && r.phase === 'integration');
    assert.ok(review, 'ревью интеграции поздней задачи вызвано');
    assert.equal(review.sha, late.integrationSha);
    // База ревью — рабочая ветка, на которую слита задача (уже с работой
    // первой доски), а не устаревшая база начала попытки.
    assert.equal(review.base, await target(late));
    await git(config.repository, 'merge-base', '--is-ancestor', early.integrationSha!, review.base);
    assert.deepEqual(review.files, [`deliverables/${late.taskId}.json`]);
    assert.ok(
      !review.files.includes(`deliverables/${early.taskId}.json`),
      'файл другой доски в диффе ревью интеграции',
    );
    // Ревью кандидата по-прежнему — от базы попытки.
    const candidate = reviews.find((r) => r.taskId === late.taskId && r.phase === 'candidate');
    assert.equal(candidate?.base, late.baseSha);
    assert.deepEqual(candidate?.files, [`deliverables/${late.taskId}.json`]);
  } finally {
    await scheduler.stop();
    store.close();
    seed.release();
  }
});
