import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTENTION_LIMITS } from '../src/core/attention-model.ts';
import { BUDGET_RAISE_RU, budgetCardReason, budgetHint, budgetNotes } from '../src/core/usage.ts';

// Причины — в формате движка (budgetStatus): «Бюджет <область> <состояние>:
// …; израсходовано: …», область — total, group <id> или work <id>. Карточка центра внимания обрезается по пределу
// причины, и команда действия должна уцелеть.
const spent = (unknown: number, uncovered = 0) =>
  `израсходовано: сообщено $439.8600, оценено $12.3456, неизвестных вызовов ${unknown}, время 123456 с` +
  (uncovered ? `, попыток без учёта вызовов ${uncovered}` : '');
const limit = ATTENTION_LIMITS.reason;
const card = (reason: string) => budgetCardReason(reason, limit);

const cases: [string, string, RegExp][] = [
  [
    'total исчерпан, длинная подробность расхода',
    `Бюджет total исчерпан: предел $120; ${spent(222, 3)}`,
    /devcontour config-apply --keys budgets\./,
  ],
  [
    'total не определён: неизвестна стоимость',
    `Бюджет total не определён: у 3 вызовов неизвестна стоимость; ${spent(3)}`,
    /onUnknown: "continue".*devcontour config-apply --keys budgets,prices/,
  ],
  [
    'total не определён: все три вида неизвестного',
    `Бюджет total не определён: у 3 вызовов неизвестна стоимость, у 2 вызовов неизвестно время, у 1 попыток вызовы не записаны; ${spent(3, 1)}`,
    /onUnknown: "continue".*devcontour config-apply --keys budgets,prices/,
  ],
  [
    'группа не определена',
    `Бюджет group B-5e5e5e5e-0d1e-4c4a-9a51-2f7d3c1b9e10 не определён: у 3 вызовов неизвестна стоимость; ${spent(3)}`,
    /onUnknown: "continue".*devcontour config-apply --keys budgets,prices/,
  ],
];

for (const [name, reason, command] of cases)
  test(`карточка бюджета: ${name} — команда действия умещается в предел`, () => {
    // Прежняя склейка «причина. подсказка» в предел не умещается: без
    // выбора текста обрезка срезала бы команду.
    assert.ok(`${reason}. ${budgetHint(reason)}`.length > limit, 'случай проверяет обрезку');
    const text = card(reason);
    assert.ok(text.length <= limit, `${text.length}: ${text}`);
    assert.match(text, command);
    // Неопределённому бюджету не советуют поднять предел.
    if (/не определён/.test(reason)) assert.doesNotMatch(text, /Поднимите предел/);
  });

test('карточка бюджета: причина, которая умещается, идёт целиком: действие, затем пометки', () => {
  const reason =
    'Бюджет work T-1 исчерпан: предел $1; израсходовано: сообщено $1.0000, оценено $0.0000, неизвестных вызовов 0, время 1 с';
  const text = card(reason);
  // Тот же вид, что у сокращённых вариантов: действие впереди пометок,
  // точка в конце.
  assert.equal(text, `${reason}. ${BUDGET_RAISE_RU}. Суммы — оценка по тарифам API, не списание.`);
});

test('карточка бюджета: при очень длинной области действие идёт впереди причины', () => {
  const id = `T-${'x'.repeat(120)}`;
  const reason = `Бюджет group ${id} не определён: у 3 вызовов неизвестна стоимость, у 2 вызовов неизвестно время, у 1 попыток вызовы не записаны; ${spent(3, 1)}`;
  const short = reason.split('; израсходовано')[0];
  const compact =
    'Предел это не снимет: задайте onUnknown: "continue" в budgets и примените: devcontour config-apply --keys budgets,prices';
  // Даже короткое действие после причины в предел не умещается.
  assert.ok(`${short}. ${compact}.`.length > limit, 'случай проверяет последний вариант');
  const text = card(reason);
  assert.equal(text, `${compact}. ${short}.`);
  // Обрезка по пределу заденет причину, а не команду.
  assert.match(text.slice(0, limit), /devcontour config-apply --keys budgets,prices\./);
});

test('пометка «Суммы — оценка» — только у денежного предела', () => {
  const time = `Бюджет времени total исчерпан: предел 3600 с; ${spent(0)}`;
  assert.deepEqual(budgetNotes(time), [
    'Бюджет total (workspace в budgets) — за всё время workspace.',
  ]);
  assert.doesNotMatch(card(time), /Суммы/);
  assert.deepEqual(budgetNotes(`Бюджет work T-1 исчерпан: предел $5; ${spent(0)}`), [
    'Суммы — оценка по тарифам API, не списание.',
  ]);
});

test('пометка «Суммы — оценка» у неопределённого денежного бюджета', () => {
  const note = 'Суммы — оценка по тарифам API, не списание.';
  // Неизвестную стоимость движок называет только при пределе в долларах.
  const cost = `Бюджет work T-1 не определён: у 3 вызовов неизвестна стоимость; ${spent(3)}`;
  assert.deepEqual(budgetNotes(cost), [note]);
  assert.match(budgetHint(cost), /^Суммы — оценка по тарифам API, не списание\. Стоимость/);
  // Без неизвестной стоимости денежный предел выдаёт только сам предел.
  const runs = `Бюджет work T-1 не определён: у 1 попыток вызовы не записаны; ${spent(0, 1)}`;
  assert.deepEqual(budgetNotes(runs), []);
  assert.deepEqual(budgetNotes(runs, { usd: 5 }), [note]);
  // Без обрезки — весь первый вариант с пометкой в конце.
  assert.match(budgetCardReason(runs, 1000, { usd: 5 }), /не списание\.$/);
  // Предел времени — без пометки о суммах.
  const time = `Бюджет work T-1 не определён: у 2 вызовов неизвестно время; ${spent(0)}`;
  assert.deepEqual(budgetNotes(time, {}), []);
});
