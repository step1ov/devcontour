import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { demoPool } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { validateWorkflow } from '../src/core/workflow.ts';
import { technicalReviewer } from '../src/harness/policy.ts';
import { doctor } from '../src/runner/doctor.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { contractEvals, evalReviewer } from '../src/runner/contract-evals.ts';
import { engineeringEvals } from '../src/runner/engineering-evals.ts';
import { input } from './helpers.ts';
import { configSchema } from '../src/core/model.ts';

/**
 * Один вендор в конфигурации DevContour: исполнитель и ревьюер claude проходят
 * полный цикл только по явному правилу вендора; без него — отказ до вызова
 * модели. Модель здесь — управляемый demo-агент под именем claude.
 */
const demos = demoPool(setupDemo);
after(() => demos.close());

async function sameVendor(rule: 'same-vendor-allowed' | undefined) {
  const seed = await demos.acquire();
  const root = seed.root;
  const file = join(root, 'config.json');
  const loaded = loadConfig(file);
  // Конфигурация живого режима — файлом, как у пользователя: процесс работает
  // только с применённой конфигурацией из источника.
  const raw = {
    ...(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>),
    mode: 'local',
    packs: [],
    reviewer: { runtime: 'claude' },
    roles: Object.fromEntries(
      Object.entries(loaded.roles).map(([id, r]) => [id, { ...r, runtime: 'claude' }]),
    ),
    ...(rule ? { review: { code: { vendor: rule } } } : {}),
  };
  writeFileSync(file, JSON.stringify(raw, null, 2));
  const calls: AgentRequest[] = [];
  const claude = {
    name: 'claude' as const,
    async execute(r: AgentRequest) {
      calls.push(r);
      return adapters.demo.execute(r);
    },
  };
  let store: Store | undefined;
  let scheduler: Scheduler | undefined;
  return {
    root,
    file,
    calls,
    open() {
      const c = loadConfig(file);
      store = new Store(join(root, 'state.sqlite'));
      const h = new DevContour(store, c);
      scheduler = new Scheduler(h, root, { ...adapters, claude });
      return { c, h, store, scheduler };
    },
    async cleanup() {
      await scheduler?.stop();
      store?.close();
      seed.release();
    },
  };
}

function oneTask(h: DevContour) {
  const board = h.createBoard('Один вендор', 'Ревью тем же вендором');
  const t = h.addTask(board.id, {
    title: 'Сохранить результат проверки',
    description: 'Учебный артефакт для цикла с ревьюером того же вендора.',
    role: 'qa',
    acceptance: ['Артефакт существует и проходит проверку.'],
  });
  return { board, t };
}

test('Роль claude → ревьюер claude с same-vendor-allowed проходит полный цикл; назначение видно в doctor и ревью плана', async () => {
  const f = await sameVendor('same-vendor-allowed');
  try {
    const o = f.open();
    await o.scheduler.init();
    const { board, t } = oneTask(o.h);
    o.h.approve(board.id);
    o.h.pause(false);
    await o.scheduler.drain();
    const done = o.store.read().tasks.find((x) => x.id === t.id)!;
    assert.equal(done.status, 'done', done.failure);
    assert.ok(done.resultSha);
    const run = o.store.read().runs.find((r) => r.taskId === t.id && r.status === 'succeeded')!;
    assert.equal(run.runtime, 'claude');
    assert.equal(run.reviewer, 'claude');
    // Исполнитель и ревьюер — отдельные вызовы одного вендора.
    const own = f.calls.filter((r) => r.task.id === t.id);
    assert.ok(own.some((r) => !r.review) && own.some((r) => r.review), 'writer и reviewer вызваны');
    // Ревью плана выбирается тем же правилом harness: без своего ревьюера —
    // другой вендор, правило кода на план не распространяется.
    assert.deepEqual(technicalReviewer(o.c, 'plan', 'claude'), {
      runtime: 'codex',
      sameVendor: false,
    });
    const plan = (vendor?: 'same-vendor-allowed') => ({
      ...o.c,
      review: {
        ...o.c.review,
        plan: { reviewer: { runtime: 'claude' as const }, ...(vendor ? { vendor } : {}) },
      },
    });
    assert.deepEqual(technicalReviewer(plan('same-vendor-allowed'), 'plan', 'claude'), {
      runtime: 'claude',
      sameVendor: true,
    });
    assert.equal(technicalReviewer(plan(), 'plan', 'claude'), undefined, 'без разрешения — отказ');
    // Работа ведущего показывает ревьюера плана по тому же правилу.
    const next = o.h.createBoard('Следующий этап', '');
    o.h.addTask(next.id, { ...input('Ещё артефакт'), role: 'qa' });
    new LeadWorkflow(o.h).start({ kind: 'board', id: next.id, authorRuntime: 'claude' });
    assert.deepEqual(new LeadWorkflow(o.h).view().find((w) => w.id === next.id)?.reviewer, {
      runtime: 'codex',
      sameVendor: false,
    });
    const report = await doctor(o.c, f.root);
    const role = report.checks.find((x) => x.id === 'role:main:qa')!;
    assert.equal(role.status, 'passed');
    assert.match(
      role.detail,
      /writer claude → reviewer claude; правило вендора: same-vendor-allowed \(ревью тем же вендором\)/,
    );
  } finally {
    await f.cleanup();
  }
});

test('Без разрешения тот же вендор — понятный отказ до вызова модели', async () => {
  const f = await sameVendor(undefined);
  try {
    // Конфигурация не загружается и процесс не открывается: до выдачи и до
    // вызова модели, с названным способом разрешить тот же вендор.
    assert.throws(() => loadConfig(f.file), /другого вендора.*same-vendor-allowed/);
    const raw = configSchema.parse(JSON.parse(readFileSync(f.file, 'utf8')));
    assert.throws(() => validateWorkflow(raw), /same-vendor-allowed/);
    const report = await doctor(raw, f.root);
    assert.equal(report.ready, false);
    const role = report.checks.find((x) => x.id === 'role:main:qa')!;
    assert.equal(role.status, 'blocked');
    assert.match(role.detail, /правило вендора: different-vendor \(ревью тем же вендором\)/);
    assert.equal(f.calls.length, 0, 'модель не вызвана');
  } finally {
    await f.cleanup();
  }
});

test('Ревьюер оценок — явно названный или другого вендора; тот же вендор только явно', async () => {
  await assert.rejects(contractEvals({ reviewerRuntime: 'claude' }), /explicit live runtime/);
  await assert.rejects(engineeringEvals({ reviewerRuntime: 'claude' }), /explicit live runtime/);
  assert.equal(evalReviewer('codex'), 'claude');
  assert.equal(evalReviewer('claude'), 'codex');
  assert.equal(evalReviewer('claude', 'claude'), 'claude');
});
