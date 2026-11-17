import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definitions, mappingGaps, reviewConsolidation } from '../src/runner/consolidation.ts';
import { consolidationStage, reviewers } from './consolidation-fixture.ts';

/**
 * Журналы и матрицы в консолидации (F49, ревью 2–3): строка таблицы из одних
 * ID правил не определяет; запись журнала сворачивается слиянием в правило,
 * которое она меняла; слияние пишется в начале правой части и видно в
 * попытке; строка со всеми правилами — обычная строка.
 */

const RULES = '# S\n\n## Rules\n\nREQ-1. Totals are positive.\n\nREQ-2. Refunds within 30 days.\n';

test('F49 R1: dropping a test matrix of ids alone needs no line for its ids', () => {
  const old =
    RULES +
    '\n## Traceability\n\n| Test | Rule |\n|---|---|\n| TC-01 | REQ-1 |\n| TC-02 | REQ-2 |\n';
  const next =
    '# S\n\n## Rules\n\nREQ-1. Totals are positive (TC-01).\n\nREQ-2. Refunds within 30 days (TC-02).\n';
  assert.deepEqual([...definitions(old).keys()].sort(), ['REQ-1', 'REQ-2']);
  assert.deepEqual(
    mappingGaps(
      old,
      next,
      'Rules, REQ-1, REQ-2 → Rules\nTraceability → Rules (tests cited inline)',
    ),
    [],
  );
});

test('F49 R1: a real rule row is still a definition and cannot become a mention', () => {
  const old =
    '# S\n\n## Rules\n\n| ID | Rule |\n|---|---|\n| REQ-17 | Totals are positive (DEC-040). |\n| REQ-18 | Refunds within 30 days. |\n';
  const next =
    '# S\n\n## Rules\n\n| ID | Rule |\n|---|---|\n| REQ-17 | Totals are positive (DEC-040). |\n\nRefunds as agreed (REQ-18).\n';
  assert.deepEqual([...definitions(old).keys()].sort(), ['REQ-17', 'REQ-18']);
  assert.deepEqual(mappingGaps(old, next, 'Rules, REQ-17, REQ-18 → Rules'), [
    'REQ-18 (в новом тексте не определено)',
  ]);
  // HTML-ячейка — тоже запись строки.
  assert.deepEqual(
    [...definitions('<table><tr><td>REQ-19</td><td>Totals.</td></tr></table>\n').keys()],
    ['REQ-19'],
  );
});

test('F49 R1: a dropped decision list is folded with "merged into"; "→ reference" does not clear it', () => {
  const old = RULES + '\n## Decisions\n\n- DEC-004, DEC-005: chosen storage.\n';
  const next =
    '# S\n\n## Rules\n\nREQ-1. Totals are positive.\n\nREQ-2. Refunds within 30 days (DEC-004, DEC-005).\n';
  const base = 'Rules, REQ-1, REQ-2 → Rules\nDecisions → Rules (decisions cited inline)';
  const gone = ['DEC-004 (в новом тексте не определено)', 'DEC-005 (в новом тексте не определено)'];
  assert.deepEqual(mappingGaps(old, next, base), gone);
  // Запись исчезла: ссылкой её не снять.
  assert.deepEqual(mappingGaps(old, next, base + '\nDEC-004, DEC-005 → reference'), gone);
  assert.deepEqual(mappingGaps(old, next, base + '\nDEC-004, DEC-005 → merged into REQ-2'), []);
  assert.deepEqual(mappingGaps(old, next, base + '\nDEC-004, DEC-005 → слито в REQ-2'), []);
});

test('F49 R2: the merge phrase counts only at the start of the right side', () => {
  const old =
    '# S\n\n## Prices\n\nREQ-1. Prices include VAT.\n\n## Refunds\n\nREQ-2. Refunds within 30 days.\n';
  const next = '# S\n\n## Prices\n\nREQ-1. Prices include VAT; refunds within 30 days (REQ-2).\n';
  assert.deepEqual(
    mappingGaps(
      old,
      next,
      'Prices, REQ-1 → Prices\nRefunds, REQ-2 → Prices (kept, not merged into REQ-1)',
    ),
    ['REQ-2 (в новом тексте не определено)'],
  );
  assert.deepEqual(
    mappingGaps(
      old,
      next,
      'Prices, REQ-1 → Prices\nRefunds, REQ-2 → merged into REQ-1 (duplicate)',
    ),
    [],
  );
});

test('F49 R2: merged and reference ids are recorded in the attempt', async () => {
  const s = await consolidationStage();
  try {
    // REQ-3 слит в REQ-2: остаётся упоминанием в его разделе.
    const next =
      '# Catalog\n\n## Prices\n\nREQ-1. Price is a number.\n\n## Listing\n\nREQ-2. At most 100 items, by name (REQ-3).\n';
    await s.commitDoc(next);
    const mapping =
      'Prices: REQ-1 → Prices: REQ-1\nListing: REQ-2 → REQ-2\nREQ-3 → merged into REQ-2 (sorting folded into the listing rule)';
    await reviewConsolidation(
      s.h,
      s.root,
      s.proposal,
      'codex',
      reviewers(s.calls, s.prompts, () => ({ approved: true, summary: mapping })),
      () => {},
      s.sh('rev-parse', 'HEAD'),
    );
    const attempt = s.store.read().contractAttempts!.at(-1)!;
    assert.equal(attempt.approved, true);
    assert.deepEqual(attempt.merged, [{ id: 'REQ-3', into: 'REQ-2' }]);
    assert.match(s.prompts[0], /"id → reference"/);
  } finally {
    await s.remove();
  }
});

test('F49 R3: one line for a small document counts when its target defines every rule', () => {
  const old = '# Prices\n\nREQ-1. Prices include VAT.\n\nREQ-2. Discounts at most 10%.\n';
  const next = '# Prices\n\nREQ-1. Prices include VAT.\n\nREQ-2. Discounts up to 10%.\n';
  assert.deepEqual(mappingGaps(old, next, 'Prices, REQ-1, REQ-2 → Prices'), []);
  // Правило, ставшее упоминанием, — пропуск и в такой строке.
  assert.deepEqual(
    mappingGaps(
      old,
      '# Prices\n\nREQ-1. Prices include VAT, discounts per REQ-2.\n',
      'Prices, REQ-1, REQ-2 → Prices',
    ),
    ['REQ-2 (в новом тексте не определено)'],
  );
});
