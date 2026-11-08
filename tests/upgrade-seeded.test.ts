import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEEDED_KINDS, seededProblems } from '../scripts/upgrade-seeded.mjs';

// Id записей нового вида, которые P3 проверки обновления хранит в манифесте
// и сверяет с повторным чтением (scripts/upgrade-check.mjs).
const seeded = {
  quick: ['PC-0f5a3c1e-9d2b-4c7a-8e6f-1a2b3c4d5e6f'],
  discussion: ['DM-6d1b2c3a-4e5f-4a7b-8c9d-0e1f2a3b4c5d'],
  attention: ['discussion:cr:DM-6d1b2c3a-4e5f-4a7b-8c9d-0e1f2a3b4c5d'],
  input: ['IR-0123456789abcdef01234567'],
};

test('P3 seeded: все виды с id своего формата и те же id при повторном чтении — сверка проходит', () => {
  assert.deepEqual([...SEEDED_KINDS], ['quick', 'discussion', 'attention', 'input']);
  assert.deepEqual(seededProblems(seeded), []);
  assert.deepEqual(seededProblems(seeded, structuredClone(seeded)), []);
});

test('P3 seeded: вид без записей, id чужого формата и повтор названы', () => {
  for (const kind of SEEDED_KINDS) {
    const rest = Object.fromEntries(Object.entries(seeded).filter(([k]) => k !== kind));
    assert.deepEqual(seededProblems(rest), [`${kind}: нет записей`], kind);
    assert.deepEqual(seededProblems({ ...seeded, [kind]: [] }), [`${kind}: нет записей`], kind);
  }
  assert.deepEqual(seededProblems({ ...seeded, input: ['IR-1'] }), [
    'input: id неверного вида "IR-1"',
  ]);
  assert.deepEqual(seededProblems({ ...seeded, quick: 'PC-x' }), ['quick: нет записей']);
  assert.deepEqual(
    seededProblems({ ...seeded, discussion: [seeded.discussion[0], seeded.discussion[0]] }),
    ['discussion: повтор id'],
  );
  assert.deepEqual(seededProblems({ ...seeded, extra: ['x'] }), ['неизвестные виды: extra']);
  // Шаг after прежнего формата (без id по видам) не проходит.
  assert.deepEqual(seededProblems(undefined), ['after: нет id записей нового вида']);
});

test('P3 seeded: повторное чтение без записи или с подменённой называет id', () => {
  const other = 'DM-ffffffff-ffff-4fff-8fff-ffffffffffff';
  assert.deepEqual(seededProblems(seeded, { ...seeded, discussion: [other] }), [
    `discussion: при повторном чтении нет ${seeded.discussion[0]}`,
    `discussion: при повторном чтении лишние ${other}`,
  ]);
  assert.deepEqual(seededProblems(seeded, { ...seeded, attention: [] }), [
    `attention: при повторном чтении нет ${seeded.attention[0]}`,
  ]);
  assert.deepEqual(seededProblems(seeded, null), ['reread: нет id записей нового вида']);
});
