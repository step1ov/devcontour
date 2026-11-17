import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ContractChange } from '../src/runner/contract-change.ts';
import { definitions, mappingCheck, mappingGaps } from '../src/runner/consolidation.ts';
import { consolidationStage } from './consolidation-fixture.ts';

/**
 * Ревью 3 (F49): строка таблицы — связь ID только из одних ID; ключ строки —
 * первая ячейка с ID; `→ reference` — только для определения, чей текст
 * остался; слияния и ссылки видны в операции.
 */

const table = (rows: string[]) =>
  '# S\n\n## Rules\n\n| ID | Rule | Source |\n|---|---|---|\n' + rows.join('\n') + '\n';
const keys = (text: string) => [...definitions(text).keys()].sort();

test('F49 R3-1: a rule row with a source or test column, or citing another rule, stays a definition', () => {
  assert.deepEqual(
    keys(table(['| REQ-5 | Refund in 30 days | DEC-040 |', '| REQ-6 | Card only | TC-01 |'])),
    ['REQ-5', 'REQ-6'],
  );
  assert.deepEqual(keys(table(['| REQ-5 | Refund in 30 days | DEC-040, DEC-041 |'])), ['REQ-5']);
  assert.deepEqual(keys(table(['| REQ-5 | Refund in 30 days | (DEC-040) |'])), ['REQ-5']);
  // Ячейка ссылается на правило в прозе или в таблице.
  assert.deepEqual(
    keys(
      '# S\n\nREQ-1. Totals positive.\n\n| ID | Rule |\n|---|---|\n| REQ-5 | Refund only after REQ-1 holds |\n',
    ),
    ['REQ-1', 'REQ-5'],
  );
  assert.deepEqual(
    keys(
      '# S\n\n| ID | Rule |\n|---|---|\n| REQ-4 | Totals positive |\n| REQ-5 | Refund only after REQ-4 holds |\n',
    ),
    ['REQ-4', 'REQ-5'],
  );
  // Чистая матрица — связь.
  assert.deepEqual(keys('# S\n\n| Test | Rule |\n|---|---|\n| TC-01 | REQ-1, REQ-2 |\n'), []);
  // HTML со вложенной разметкой.
  assert.deepEqual(keys('<ul><li><strong>REQ-1</strong>: totals</li></ul>\n'), ['REQ-1']);
});

test('F49 R3-1: deleting a rule row with a test column is a gap', () => {
  const old = table(['| REQ-5 | Refund in 30 days | DEC-040 |', '| REQ-6 | Card only | TC-01 |']);
  const next =
    '# S\n\n## Rules\n\n| ID | Rule | Source |\n|---|---|---|\n| REQ-5 | Refund in 30 days | DEC-040 |\n\nREQ-6 and TC-01 retained.\n';
  assert.deepEqual(mappingGaps(old, next, 'S → S\nRules, REQ-5 → Rules'), [
    'REQ-6 (в новом тексте не определено)',
  ]);
});

test('F49 R3-1: a prose decision journal is folded with "merged into" the rule it changed', () => {
  const old =
    '# S\n\n## Rules\n\nREQ-1. Totals are positive.\n\nREQ-2. Refunds within 30 days.\n\n## Amendments\n\n| Decision | Change |\n|---|---|\n| DEC-040 | REQ-1 changed to five |\n| DEC-041 | Added REQ-2 |\n';
  const next =
    '# S\n\n## Rules\n\nREQ-1. Totals are positive (DEC-040).\n\nREQ-2. Refunds within 30 days (DEC-041).\n';
  const base = 'Rules, REQ-1, REQ-2 → Rules\nAmendments → Rules (journal folded)';
  assert.deepEqual(keys(old), ['DEC-040', 'DEC-041', 'REQ-1', 'REQ-2']);
  assert.deepEqual(mappingGaps(old, next, base), [
    'DEC-040 (в новом тексте не определено)',
    'DEC-041 (в новом тексте не определено)',
  ]);
  // Строка журнала исчезла: «reference» её не снимает.
  assert.deepEqual(mappingGaps(old, next, base + '\nDEC-040, DEC-041 → reference'), [
    'DEC-040 (в новом тексте не определено)',
    'DEC-041 (в новом тексте не определено)',
  ]);
  const check = mappingCheck(
    old,
    next,
    base + '\nDEC-040 → merged into REQ-1\nDEC-041 → merged into REQ-2',
  );
  assert.deepEqual(check.gaps, []);
  assert.deepEqual(check.merged, [
    { id: 'DEC-040', into: 'REQ-1' },
    { id: 'DEC-041', into: 'REQ-2' },
  ]);
});

test('F49 R3-2: "→ reference" is refused for heading labels and for a definition whose text is gone', () => {
  const o2 = '# S\n\n## Refunds\n\nREQ-2. Refunds within 30 days.\n\n## Other\n\nSee REQ-2.\n';
  const n2 = '# S\n\n## Refunds\n\nNone.\n\n## Other\n\nSee REQ-2.\n';
  assert.deepEqual(mappingGaps(o2, n2, 'Refunds → Refunds\nOther → Other\nREQ-2 → reference'), [
    'REQ-2 (в новом тексте не определено)',
  ]);
  const o3 =
    '# S\n\n## REQ-2. Refunds\n\nWithin 30 days.\n\n## Other\n\nSee REQ-2 within 30 days.\n';
  const n3 = '# S\n\n## Other\n\nSee REQ-2 within 30 days. Refunds.\n';
  assert.deepEqual(
    mappingGaps(o3, n3, 'Other → Other\nREQ-2 → reference\nREQ-2. Refunds → Other'),
    ['REQ-2 (в новом тексте не определено)', '«REQ-2. Refunds»'],
  );
  // Текст записи остался, сменилась только разметка: ссылка допустима.
  const o4 = '# S\n\n## Decisions\n\n- DEC-004, DEC-005: chosen storage.\n';
  const n4 = '# S\n\n## Decisions\n\nChosen storage (DEC-004, DEC-005).\n';
  const ok = mappingCheck(o4, n4, 'Decisions → Decisions\nDEC-004, DEC-005 → reference');
  assert.deepEqual(ok.gaps, []);
  assert.deepEqual(ok.demoted, ['DEC-004', 'DEC-005']);
});

test('F49 R3-2: the contract-change operation view lists merged and reference ids', async () => {
  const s = await consolidationStage();
  try {
    await s.commitDoc(
      '# Catalog\n\n## Prices\n\nREQ-1. Price is a number.\n\n## Listing\n\nREQ-2. At most 100 items, by name (REQ-3).\n',
    );
    const mapping =
      'Prices: REQ-1 → Prices: REQ-1\nListing: REQ-2 → REQ-2\nREQ-3 → merged into REQ-2 (sorting folded)';
    const changes = s.changes((_, subject) =>
      subject === 'contract consolidation' ? { approved: true, summary: mapping } : undefined,
    );
    const op = (
      (await changes.start(s.proposal, 'codex', [], 'consolidate')) as { operation: ContractChange }
    ).operation;
    const done = await changes.advance(op.id);
    assert.equal(done.status, 'completed', done.error);
    assert.deepEqual(
      done.mapping?.map((m) => ({ merged: m.merged, demoted: m.demoted })),
      [{ merged: [{ id: 'REQ-3', into: 'REQ-2' }], demoted: undefined }],
    );
    assert.ok(done.mapping?.[0].review);
  } finally {
    await s.remove();
  }
});

test('F49 R4-1: a short entry text found elsewhere is not the entry', () => {
  const o1 = '# S\n\n## Rules\n\nREQ-1. Payments by card.\n\nREQ-9. Optional.\n';
  const n1 =
    '# S\n\n## Rules\n\nREQ-1. Payments by card; the receipt is optional. Card data per REQ-9.\n';
  assert.deepEqual(mappingGaps(o1, n1, 'Rules, REQ-1 → Rules\nREQ-9 → reference'), [
    'REQ-9 (в новом тексте не определено)',
  ]);
});

test('F49 R4-1: part of a word is not the entry text ("yes" in "eyes")', () => {
  const o2 = '# S\n\nREQ-1. Payments.\n\nREQ-2. Yes.\n';
  const n2 = '# S\n\nREQ-1. Payments; eyes only (REQ-2).\n';
  assert.deepEqual(mappingGaps(o2, n2, 'S, REQ-1 → S\nREQ-2 → reference'), [
    'REQ-2 (в новом тексте не определено)',
  ]);
});

test('F49 R4-1: removing REQ-1 does not cut REQ-12 when comparing entry text', () => {
  const o3 =
    '# S\n\nREQ-1. Payments.\n\n## Decisions\n\n- DEC-004: storage per REQ-12 rules apply to every refund.\n';
  const n3 =
    '# S\n\nREQ-1. Payments.\n\n## Decisions\n\nStorage per REQ-12 rules apply to every refund (DEC-004).\n';
  assert.deepEqual(
    mappingGaps(o3, n3, 'S, REQ-1 → S\nDecisions → Decisions\nDEC-004 → reference'),
    [],
  );
});
