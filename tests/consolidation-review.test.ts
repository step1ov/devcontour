import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  anchors,
  consolidationPlan,
  idTokens,
  mappingGaps,
  referencedAnchors,
  reviewConsolidation,
} from '../src/runner/consolidation.ts';
import { parseProposal } from '../src/runner/agent-control.ts';
import {
  AMENDED,
  CONSOLIDATED,
  consolidationStage,
  MAPPING,
  reviewers,
} from './consolidation-fixture.ts';

test('F20: deterministic helpers: id tokens, heading anchors and sibling references', () => {
  assert.deepEqual(
    idTokens(
      'REQ-2 and REQ-10, API-3; REQ-2 again; X-1, req-4, ТР-4, REQ-1.2 and REQ-1.3; UTF-8, SHA-256, ISO-8601; pre-REQ-9',
    ),
    ['API-3', 'REQ-1.2', 'REQ-1.3', 'REQ-10', 'REQ-2', 'req-4', 'ТР-4'].sort(),
  );
  const a = anchors(
    [
      '# Catalog',
      '## Prices & taxes',
      '## Prices & taxes',
      '## Правила {#rules}',
      '```',
      '## Not a heading',
      '```',
      '<a id="Legacy-Anchor"></a>',
    ].join('\n'),
  );
  assert.deepEqual(
    [...a].sort(),
    ['catalog', 'legacy-anchor', 'prices--taxes', 'prices--taxes-1', 'rules', 'правила'].sort(),
  );
  assert.deepEqual(
    referencedAnchors(
      'See [p](catalog.md#Prices), docs/contracts/catalog.md#listing and xcatalog.md#nope.',
      'docs/contracts/catalog.md',
    ).sort(),
    ['listing', 'prices'],
  );
});

test('F20: the consolidation review gets the old and new text, ids and sibling excerpts, and registers the redaction with consolidates', async () => {
  const s = await consolidationStage();
  try {
    await s.commitDoc(CONSOLIDATED);
    const head = s.sh('rev-parse', 'HEAD');
    const c = await reviewConsolidation(
      s.h,
      s.root,
      s.proposal,
      'codex',
      reviewers(s.calls, s.prompts),
      () => {},
      head,
    );
    assert.deepEqual(s.calls, ['contract consolidation']);
    const prompt = s.prompts[0];
    assert.match(prompt, /complete mapping from the old text to the new one/);
    assert.match(prompt, /resurrected pre-amendment wording/);
    assert.ok(prompt.includes('Amendment (stage 2)'), 'прежний текст в запросе');
    assert.ok(prompt.includes('REQ-3. Sorted by name.'), 'новый текст в запросе');
    assert.match(prompt, /"REQ-1",\s*"REQ-2",\s*"REQ-3"/);
    assert.ok(prompt.includes('catalog.md#prices'), 'выдержка соседа');
    // Выполнимость и проверяемость неизменных правил — не предмет ревью.
    assert.doesNotMatch(prompt, /Assess every obligation of the contract for feasibility/);
    assert.doesNotMatch(prompt, /Assess verifiability/);
    assert.equal(c.content, CONSOLIDATED);
    assert.equal(c.consolidates?.from, s.c1.id);
    assert.equal(c.consolidates?.review, c.approval?.artifact?.split('/').at(-1));
    assert.deepEqual(
      c.artifacts?.map((a) => a.blob),
      s.c1.artifacts?.map((a) => a.blob),
    );
  } finally {
    await s.remove();
  }
});

test('F20: a rejected consolidation review registers nothing', async () => {
  const s = await consolidationStage();
  try {
    await s.commitDoc(CONSOLIDATED);
    const before = s.store.read().contracts.length;
    await assert.rejects(
      reviewConsolidation(
        s.h,
        s.root,
        s.proposal,
        'codex',
        reviewers(s.calls, s.prompts, () => ({
          approved: false,
          summary: 'REQ-2 widened from 50 to 100 without the amendment context',
        })),
        () => {},
        s.sh('rev-parse', 'HEAD'),
      ),
      /Независимое ревью отклонено: REQ-2 widened/,
    );
    assert.equal(s.store.read().contracts.length, before);
  } finally {
    await s.remove();
  }
});

test('F20: pre-checks refuse before any model call: no current redaction, changed artifacts or checks, a longer text, a dropped id, a removed sibling anchor, another title', async () => {
  const s = await consolidationStage();
  try {
    const plan = async (proposal: object) =>
      consolidationPlan(s.h, parseProposal(proposal), s.sh('rev-parse', 'HEAD'));
    // Нет редакции этого документа.
    await s.commitDoc('# New\n\nREQ-9.\n', 'docs/contracts/new.md');
    await assert.rejects(
      plan({ title: 'New', file: 'docs/contracts/new.md' }),
      /нет зарегистрированной редакции/,
    );
    // Тот же текст.
    await assert.rejects(plan(s.proposal), /совпадает с действующей редакцией/);
    // Изменён закреплённый артефакт.
    await s.commitDoc(CONSOLIDATED);
    await writeFile(join(s.repo, 'schema.json'), '{"price":"string"}\n');
    s.sh('commit', '-qam', 'schema');
    await assert.rejects(plan(s.proposal), /меняет artifacts действующей редакции/);
    await writeFile(join(s.repo, 'schema.json'), '{"price":"number"}\n');
    s.sh('commit', '-qam', 'schema back');
    // Объявлена реализация под тестом, которой не было.
    await assert.rejects(
      plan({ ...s.proposal, underTest: ['src/catalog.ts'] }),
      /меняет underTest/,
    );
    // Другое название.
    await assert.rejects(plan({ ...s.proposal, title: 'Catalog' }), /сохраняет название/);
    // Текст не короче.
    await s.commitDoc(CONSOLIDATED + 'x'.repeat(400));
    await assert.rejects(plan(s.proposal), /сокращает документ/);
    // Пропал ID-токен.
    await s.commitDoc(CONSOLIDATED.replace('REQ-3. ', ''));
    await assert.rejects(plan(s.proposal), /нет REQ-3/);
    // Пропал раздел, на который ссылается соседний контракт.
    await s.commitDoc(CONSOLIDATED.replace('## Prices', '## Pricing'));
    await assert.rejects(plan(s.proposal), /orders\.md: #prices/);
    // Корректная консолидация проходит.
    await s.commitDoc(CONSOLIDATED);
    const ok = await plan(s.proposal);
    assert.equal(ok.current.id, s.c1.id);
    assert.deepEqual(ok.ids, ['REQ-1', 'REQ-2', 'REQ-3']);
    assert.equal(s.calls.length, 0, 'модель не вызывалась');
  } finally {
    await s.remove();
  }
});

test('F20 M2: a summary without the full mapping counts as a rejected round; the next round is a new call and passes with the mapping', async () => {
  const s = await consolidationStage();
  try {
    await s.commitDoc(CONSOLIDATED);
    const head = s.sh('rev-parse', 'HEAD');
    const lazy = reviewers(s.calls, s.prompts, () => ({ approved: true, summary: 'ok' }));
    await assert.rejects(
      reviewConsolidation(s.h, s.root, s.proposal, 'codex', lazy, () => {}, head),
      /Неполное отображение старого текста в новый: итог ревью не называет REQ-1, REQ-2, REQ-3, «Catalog», «Prices», «Listing»/,
    );
    assert.equal(s.store.read().contracts.length, 2, 'ничего не зарегистрировано');
    const attempt = s.store.read().contractAttempts!.at(-1)!;
    assert.equal(attempt.approved, false);
    assert.equal(attempt.findings.at(-1)?.rule, 'consolidation');
    // Неполный, но не пустой итог.
    const partial = reviewers(s.calls, s.prompts, () => ({
      approved: true,
      summary: MAPPING.split('\n').slice(0, 3).join('\n'),
    }));
    await assert.rejects(
      reviewConsolidation(s.h, s.root, s.proposal, 'codex', partial, () => {}, head),
      /не называет REQ-3$|не называет REQ-3\./,
    );
    // Следующий раунд — новый вызов модели (не прежнее одобрение) и видит пропуски.
    const c = await reviewConsolidation(
      s.h,
      s.root,
      s.proposal,
      'codex',
      reviewers(s.calls, s.prompts),
      () => {},
      head,
    );
    assert.equal(s.calls.length, 3);
    assert.match(s.prompts.at(-1)!, /incompleteMapping/);
    assert.equal(c.consolidates?.from, s.c1.id);
  } finally {
    await s.remove();
  }
});

test('F20 R2-M2: the mapping needs "old → new" lines pointing into the new text; an echo of ids and headings or a substring hit is not a mapping', () => {
  assert.deepEqual(mappingGaps(AMENDED, CONSOLIDATED, MAPPING), []);
  assert.deepEqual(mappingGaps(AMENDED, CONSOLIDATED, MAPPING.replaceAll('→', '->')), []);
  // Перечисление без стрелок.
  assert.deepEqual(
    mappingGaps(
      AMENDED,
      CONSOLIDATED,
      'Covered: REQ-1, REQ-2, REQ-3; sections: Catalog, Prices, Listing. All good.',
    ),
    ['REQ-1', 'REQ-2', 'REQ-3', '«Catalog»', '«Prices»', '«Listing»'],
  );
  // Стрелка в никуда: правая часть не называет ничего из нового текста.
  assert.deepEqual(
    mappingGaps(
      AMENDED,
      CONSOLIDATED,
      MAPPING.replace('→ Prices: REQ-1, price is a number', '→ Pricing rules'),
    ),
    ['REQ-1', '«Prices»'],
  );
  // Часть слова не считается заголовком.
  assert.deepEqual(
    mappingGaps(
      AMENDED,
      CONSOLIDATED,
      MAPPING.replace('Prices: REQ-1 (stage 2 amendment)', 'Pricesheet: REQ-1'),
    ),
    ['«Prices»'],
  );
});
