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
import { assumptionQuestion, evaluateInput, type InputQuestion } from 'devcontour-harness';

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

/** Вопрос, который движок делает из развилки завершённой попытки. */
function engineQuestion(assumptions: ReturnType<typeof fork>[]): InputQuestion {
  const { decision } = evaluateInput(
    { completed: true, inputRequest: null, assumptions },
    { threshold: 7, criticalPaths: [] },
    [],
  );
  assert.equal(decision.kind, 'stop');
  assert.ok(decision.kind === 'stop' && decision.fromAssumption);
  return decision.question.question;
}

test('A fork at or above the pinned question threshold is the question that stopped the attempt, not a decision taken without stopping', () => {
  // Вопросом стала самая серьёзная развилка (8): запрос попытки — она, и
  // блок решений её не показывает; вторая не ниже порога (7) видна с
  // пометкой «не решено», а не пропадает.
  assert.deepEqual(
    assumptionLines(stopped, engineQuestion(stopped.assumptions)).map((a) => [
      a.question,
      a.unresolved ?? false,
    ]),
    [
      ['Отступ в JSON?', false],
      ['Порог', true],
    ],
  );
  // Две развилки выше порога (9 и 8): вопрос — 9, а 8 видна нерешённой.
  const two = {
    ...stopped,
    assumptions: [fork('Восьмая', 8), fork('Девятая', 9), fork('Мелочь', 1)],
  };
  assert.deepEqual(
    assumptionLines(two, engineQuestion(two.assumptions)).map((a) => [
      a.question,
      a.unresolved ?? false,
    ]),
    [
      ['Восьмая', true],
      ['Мелочь', false],
    ],
  );
  // Равная действующая серьёзность: движок берёт развилку с большей
  // самооценкой, затем первую (здесь «Вторая»); скрыта та, что стала запросом.
  const tie = {
    ...stopped,
    assumptions: [
      { ...fork('Первая', 10), severity: 3 },
      { ...fork('Вторая', 10), severity: 6 },
      { ...fork('Третья', 10), severity: 6 },
    ],
  };
  assert.deepEqual(
    assumptionLines(tie, assumptionQuestion(tie.assumptions[1])).map((a) => a.question),
    ['Первая', 'Третья'],
  );
  // Результат быстрого изменения берёт последнюю попытку — здесь остановленную
  // — и вопрос её запроса.
  const state = {
    tasks: [{ id: 'T-q', title: 'Задача', status: 'failed', repositoryId: 'app' }],
    runs: [{ ...stopped, id: 'R-q', taskId: 'T-q', evidence: [] }],
    boards: [],
    changeSets: [],
  } as unknown as DevContourState;
  const questions = new Map([['R-q', engineQuestion(stopped.assumptions)]]);
  const [result] = quickResult(bound(state, ['T-q']), 'PC-assume', [], questions);
  assert.deepEqual(
    result.run?.assumptions.map((a) => a.question),
    ['Отступ в JSON?', 'Порог'],
  );
  // Попытка прежней версии без закреплённой политики: порога нет, видны все.
  assert.equal(assumptionLines({ assumptions: stopped.assumptions }).length, 3);
});

test('When the writer asked its own question, a severe fork is only recorded: it stays visible as unresolved, nothing is hidden', () => {
  // Исполнитель не завершил работу и спросил о версии API (8); развилка о
  // модели данных серьёзнее (9), но движок делает вопросом запрос, а
  // развилку только записывает.
  const assumptions = [fork('Какая модель данных?', 9), fork('Отступ в JSON?', 2)];
  const request: InputQuestion = {
    question: 'Какую версию API поддерживать?',
    options: [
      { id: 'v1', label: 'v1', consequence: null },
      { id: 'v2', label: 'v2', consequence: null },
    ],
    recommended: 'v2',
    severity: 8,
    rationale: 'Клиенты на обеих версиях',
    affects: [],
  };
  const { decision } = evaluateInput(
    { completed: false, inputRequest: request, assumptions },
    { threshold: 7, criticalPaths: [] },
    [],
  );
  assert.ok(decision.kind === 'stop' && !decision.fromAssumption);
  assert.equal(decision.kind === 'stop' && decision.question.question.question, request.question);
  const run = { ...stopped, assumptions };
  assert.deepEqual(
    assumptionLines(run, request).map((a) => [a.question, a.unresolved ?? false]),
    [
      ['Какая модель данных?', true],
      ['Отступ в JSON?', false],
    ],
  );
  // Без известного запроса — тоже ничего не скрыто.
  assert.equal(assumptionLines(run).length, 2);
  // Тот же текст вопроса, но другой выбор — не та развилка.
  const lookalike = assumptionQuestion({ ...assumptions[0], chosen: 'Другое' });
  assert.equal(assumptionLines(run, lookalike).length, 2);
  assert.equal(assumptionLines(run, assumptionQuestion(assumptions[0])).length, 1);
});

test('Forks of an attempt that did not stop by question carry no unresolved mark', () => {
  // Незавершённая попытка без вопроса (или с вопросом ниже порога): движок
  // развилки не оценивал, пометка «не решено» относится только к
  // остановленной вопросом.
  for (const failureKind of ['unfinished', undefined] as const) {
    const run = { ...stopped, failureKind };
    const lines = assumptionLines(run);
    assert.equal(lines.length, 3);
    assert.ok(
      lines.every((a) => !('unresolved' in a)),
      String(failureKind),
    );
  }
});
