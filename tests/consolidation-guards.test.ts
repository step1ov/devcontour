import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definitions, mappingGaps, reviewConsolidation } from '../src/runner/consolidation.ts';
import { ruleTokens, textChecks } from '../src/core/contract-text.ts';
import { CONSOLIDATED, consolidationStage, reviewers } from './consolidation-fixture.ts';

/**
 * Защиты сверки отображения консолидации (F49, ревью): ссылки сохраняют
 * смысл, разметки правил, границы ID, правило остаётся определённым,
 * пустые заголовки по месту, одна строка на весь документ.
 */

test('F49 #1: the reviewer must keep the meaning of ids and references, and map a reference that states a rule like a rule', async () => {
  const s = await consolidationStage();
  try {
    await s.commitDoc(CONSOLIDATED);
    await reviewConsolidation(
      s.h,
      s.root,
      s.proposal,
      'codex',
      reviewers(s.calls, s.prompts),
      () => {},
      s.sh('rev-parse', 'HEAD'),
    );
    const prompt = s.prompts[0];
    assert.ok(
      prompt.includes('every token in "ids" and in "references" keeps its meaning'),
      'смысл ids и references',
    );
    assert.ok(
      prompt.includes(
        'A token in "references" that actually states a rule in the old text is a rule: map it like a rule',
      ),
      'ссылка, которая задаёт правило',
    );
    assert.ok(prompt.includes('"old id → merged into <id>"'), 'синтаксис слияния');
  } finally {
    await s.remove();
  }
});

test('F49 #2: definitions() recognises the common rule layouts and keeps plain mentions as references', () => {
  const defines = (text: string, ...ids: string[]) =>
    assert.deepEqual([...definitions(text).keys()].sort(), [...ids].sort(), JSON.stringify(text));
  defines('- REQ-1, REQ-2: totals are positive.\n', 'REQ-1', 'REQ-2');
  defines('- REQ-3 and REQ-4 — refunds in 30 days.\n', 'REQ-3', 'REQ-4');
  defines('| Area | Rule |\n|---|---|\n| Orders | REQ-1: total is positive |\n', 'REQ-1');
  defines('| ID | Rule |\n|---|---|\n| REQ-17 | totals |\n', 'REQ-17');
  defines('- [ ] REQ-22: totals\n- [x] REQ-23: refunds\n', 'REQ-22', 'REQ-23');
  defines('1. **REQ-15** Totals positive\n', 'REQ-15');
  defines('(REQ-10) Totals positive.\n\n[REQ-11] Refunds.\n', 'REQ-10', 'REQ-11');
  defines('## Rule REQ-6: totals\n\nPositive.\n', 'REQ-6');
  defines('Totals first. Also REQ-8. the totals are positive.\n', 'REQ-8');
  defines('<ul>\n<li>REQ-16: totals</li>\n</ul>\n', 'REQ-16');
  defines('Orders must satisfy **REQ-7**: totals positive.\n', 'REQ-7');
  // Упоминания — ссылки.
  defines('### REQ-1. Totals (DEC-3)\n\nAs in REQ-2, see TC-1 (REQ-4).\n', 'REQ-1');
  defines('> - REQ-5 changed: five loans.\n');
  defines('| `tests/x.test.ts` | REQ-5 (TC-01), REQ-6 |\n');
});

test('F49 #4: rule tokens end at a word boundary: suffixed ids and CVE numbers stay distinct; lowercase hyphen chains are not ids', () => {
  assert.deepEqual(ruleTokens('REQ-3a REQ-3b CVE-2024-1234 REQ-12x, REQ-12.'), [
    'CVE-2024-1234',
    'REQ-12',
    'REQ-12x',
    'REQ-3a',
    'REQ-3b',
  ]);
  assert.deepEqual(ruleTokens('vue-router-4 and ord-ret-01 and pre-REQ-9'), []);
  const old = '# S\n\nREQ-3a. Refund in 30 days.\n\nREQ-3b. Refund to card.\n';
  const next = '# S\n\nREQ-3a. Refund in 30 days.\n';
  assert.deepEqual(textChecks(old, next, 'x.md', [], ruleTokens).lost, ['REQ-3b']);
});

test('F49 #3: a rule must stay defined where its line points, unless the line says it was merged into a defined id', () => {
  const old =
    '# Orders\n\n## Totals\n\nREQ-1. Total is positive.\n\nREQ-2. Refunds allowed within 30 days.\n\n## Shipping\n\nREQ-3. Ships in 2 days.\n';
  const demoted =
    '# Orders\n\n## Totals\n\nREQ-1. Total is positive. REQ-2, REQ-3 apply.\n\n## Shipping\n\nShips in 5 days.\n';
  assert.deepEqual(
    mappingGaps(old, demoted, 'Totals, REQ-1, REQ-2 → Totals\nREQ-3 → Totals\nShipping → Shipping'),
    ['REQ-2 (в новом тексте не определено)', 'REQ-3 (в новом тексте не определено)'],
  );
  // Слияние называется явно и указывает на определённый ID.
  const o2 = '# S\n\n## REQ-1. Prices\n\nPrices include VAT.\n\n## REQ-2. Discounts\n\nMax 10%.\n';
  const n2 = '# S\n\n## REQ-1. Prices\n\nPrices include VAT. Discounts per REQ-2 up to 10%.\n';
  assert.deepEqual(mappingGaps(o2, n2, 'REQ-1 → REQ-1\nREQ-2 → REQ-1'), [
    'REQ-2 (в новом тексте не определено)',
    '«REQ-2. Discounts»',
  ]);
  assert.deepEqual(mappingGaps(o2, n2, 'REQ-1 → REQ-1\nREQ-2 → merged into REQ-1'), []);
  assert.deepEqual(mappingGaps(o2, n2, 'REQ-1 → REQ-1\nREQ-2 → слито в REQ-1'), []);
  assert.deepEqual(mappingGaps(o2, n2, 'REQ-1 → REQ-1\nREQ-2 → merged into TC-9'), [
    'REQ-2 (в новом тексте не определено)',
    '«REQ-2. Discounts»',
  ]);
  // Двойное определение: строка указывает на раздел, где осталось упоминание.
  const o3 = '# S\n\n## A\n\nREQ-1. Old rule text.\n\n## B\n\nREQ-1. Replacement rule.\n';
  const n3 = '# S\n\n## A\n\nREQ-1. Old rule text.\n\n## B\n\nsee REQ-1\n';
  assert.deepEqual(mappingGaps(o3, n3, 'A → A\nB, REQ-1 → B'), ['REQ-1']);
});

test('F49 #6: the empty-heading exemption is per occurrence, not per heading text', () => {
  const old = '# S\n\n## A\n\n### Notes\n\n## B\n\nb text\n\n### Notes\n\nRefunds forbidden.\n';
  const next = '# S\n\n## A\n\n### Notes\n\n## B\n\nb text\n';
  assert.deepEqual(mappingGaps(old, next, 'A → A\nB → B'), ['«Notes»']);
});

test('F49 #7: one line that names every rule of the document is not a mapping', () => {
  const old = '# Spec\n\nREQ-1. A.\n\nREQ-2. B.\n\nREQ-3. C.\n\nREQ-4. D long text here.\n';
  const next = '# Spec\n\nREQ-1. A.\n\nREQ-2. B.\n\nREQ-3. C.\n\nREQ-4. D.\n';
  assert.deepEqual(mappingGaps(old, next, 'Spec, REQ-1, REQ-2, REQ-3, REQ-4 → Spec'), [
    'REQ-1',
    'REQ-2',
    'REQ-3',
    'REQ-4',
    '«Spec»',
  ]);
  assert.deepEqual(mappingGaps(old, next, 'Spec, REQ-1, REQ-2 → Spec\nREQ-3, REQ-4 → Spec'), []);
});
