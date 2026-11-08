import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { demoPool, testDemo } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { DEMO_ASSUME } from '../src/runner/adapters.ts';
import { quickResult } from '../src/runner/quick.ts';
import { panelRun, panelTask } from '../src/application/panel.ts';
import { assumptionLines } from '../src/application/assumptions.ts';
import type { DevContourState, Run } from '../src/core/model.ts';

// Решения исполнителя ниже порога вопросов (`assumptions` попытки) в
// проекциях панели: детали задачи (карточка) и результат быстрого изменения.
// Исполнитель — учебный runtime `demo` с маркером `[demo:assume]` (fixture,
// не модель); запись делает движок harness, как у настоящего writer.

const demos = demoPool(testDemo);
after(() => demos.close());

async function drained() {
  const seed = await demos.acquire();
  const store = new Store(join(seed.root, 'state.sqlite'));
  const h = new DevContour(store, loadConfig(join(seed.root, 'config.json')));
  const scheduler = new Scheduler(h, seed.root);
  await scheduler.init();
  const board = h.createBoard('Решения исполнителя', 'Задачи с допущениями и без.');
  const assuming = h.addTask(board.id, {
    title: 'Задача с допущениями',
    description: `Наблюдаемый результат, по пути к которому исполнитель решает сам ${DEMO_ASSUME}.`,
    role: 'qa',
    acceptance: ['Результат проходит независимую проверку.'],
  });
  const plain = h.addTask(board.id, {
    title: 'Задача без допущений',
    description: 'Наблюдаемый результат без развилок.',
    role: 'qa',
    acceptance: ['Результат проходит независимую проверку.'],
  });
  h.approve(board.id);
  h.pause(false);
  await scheduler.drain();
  return {
    h,
    store,
    assuming: assuming.id,
    plain: plain.id,
    async close() {
      await scheduler.stop();
      store.close();
      seed.release();
    },
  };
}

/** Привязка задач к быстрому изменению — только в копии состояния. */
function bound(state: DevContourState, taskIds: string[]) {
  const copy = structuredClone(state);
  for (const t of copy.tasks)
    if (taskIds.includes(t.id))
      t.preparation = {
        changeId: 'PC-assume',
        productDigest: 'a'.repeat(64),
        architectureDigest: 'b'.repeat(64),
        referencesDigest: 'c'.repeat(64),
      };
  return copy;
}

const expected = [
  {
    question: 'Demo fixture: где хранить артефакт задачи?',
    chosen: 'deliverables/<id>.json, как у остальных задач',
    rationale: 'Так его читает fixture-проверка verify.mjs',
    severity: 2,
    effectiveSeverity: 2,
    floors: [],
    affects: [],
  },
  {
    question: 'Demo fixture: нужен ли отступ в JSON?',
    chosen: 'Два пробела',
    rationale: 'Совпадает с форматированием репозитория',
    severity: 1,
    effectiveSeverity: 1,
    floors: [],
    affects: [],
  },
];

test('An accepted attempt carries the writer decisions into the task card and the quick result', async () => {
  const f = await drained();
  try {
    const state = f.store.read();
    for (const id of [f.assuming, f.plain])
      assert.equal(state.tasks.find((t) => t.id === id)?.status, 'done', id);
    // Движок записал решения принятой попытки с оценкой.
    const run = state.runs.filter((r) => r.taskId === f.assuming).at(-1)!;
    assert.equal(run.status, 'succeeded');
    assert.equal(run.assumptions?.length, 2);

    // Карточка задачи: попытка в деталях несёт список вопрос — выбор —
    // основание — серьёзность.
    const detail = panelTask(f.h, f.assuming, {});
    assert.deepEqual(detail.runs.items[0].assumptions, expected);
    assert.deepEqual(panelRun(f.h, run.id).assumptions, expected);
    // Попытка без решений — без поля: карточка не рисует пустой список.
    const plain = panelTask(f.h, f.plain, {});
    assert.equal('assumptions' in plain.runs.items[0], false);

    // Результат быстрого изменения: та же последняя попытка.
    const results = quickResult(bound(state, [f.assuming, f.plain]), 'PC-assume', []);
    const byTask = new Map(results.map((r) => [r.taskId, r]));
    assert.deepEqual(byTask.get(f.assuming)?.run?.assumptions, expected);
    assert.deepEqual(byTask.get(f.plain)?.run?.assumptions, []);
  } finally {
    await f.close();
  }
});

test('Writer decisions in projections are bounded: at most 20, long texts clipped, floors kept', () => {
  const long = 'x'.repeat(5000);
  const run = {
    assumptions: Array.from({ length: 25 }, (_, i) => ({
      question: i === 0 ? long : `Вопрос ${i}`,
      chosen: 'Выбор',
      rationale: 'Основание',
      severity: 3,
      affects: ['contract' as const],
      effectiveSeverity: 9,
      floors: ['declared' as const],
    })),
  } satisfies Pick<Run, 'assumptions'>;
  const lines = assumptionLines(run);
  assert.equal(lines.length, 20);
  assert.ok(lines[0].question.length < long.length);
  assert.ok(lines[0].question.endsWith('…'));
  assert.equal(lines[1].question, 'Вопрос 1');
  assert.deepEqual(
    {
      s: lines[1].severity,
      e: lines[1].effectiveSeverity,
      f: lines[1].floors,
      a: lines[1].affects,
    },
    { s: 3, e: 9, f: ['declared'], a: ['contract'] },
  );
  assert.deepEqual(assumptionLines({}), []);
});

test('A fork at or above the pinned question threshold is the question that stopped the attempt, not a decision taken without stopping', () => {
  const fork = (question: string, effectiveSeverity: number) => ({
    question,
    chosen: 'Выбор',
    rationale: 'Основание',
    severity: effectiveSeverity,
    affects: [],
    effectiveSeverity,
    floors: [],
  });
  const stopped = {
    status: 'failed',
    failureKind: 'needs-input',
    inputPolicy: { threshold: 7, criticalPaths: [] },
    assumptions: [fork('Какая модель данных?', 8), fork('Отступ в JSON?', 2), fork('Порог', 7)],
  } satisfies Pick<Run, 'status' | 'failureKind' | 'inputPolicy' | 'assumptions'>;
  assert.deepEqual(
    assumptionLines(stopped).map((a) => a.question),
    ['Отступ в JSON?'],
  );
  // Результат быстрого изменения берёт последнюю попытку — здесь остановленную.
  const state = {
    tasks: [{ id: 'T-q', title: 'Задача', status: 'failed', repositoryId: 'app' }],
    runs: [{ ...stopped, id: 'R-q', taskId: 'T-q', evidence: [] }],
    boards: [],
    changeSets: [],
  } as unknown as DevContourState;
  const [result] = quickResult(bound(state, ['T-q']), 'PC-assume', []);
  assert.deepEqual(
    result.run?.assumptions.map((a) => a.question),
    ['Отступ в JSON?'],
  );
  // Попытка прежней версии без закреплённой политики: порога нет, видны все.
  assert.equal(assumptionLines({ assumptions: stopped.assumptions }).length, 3);
});
