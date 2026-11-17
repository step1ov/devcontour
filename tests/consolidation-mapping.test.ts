import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewContract } from '../src/runner/agent-control.ts';
import {
  consolidationPlan,
  definitions,
  idTokens,
  mappingGaps,
  reviewConsolidation,
} from '../src/runner/consolidation.ts';
import { parseProposal } from '../src/runner/agent-control.ts';
import { consolidationStage, reviewers } from './consolidation-fixture.ts';

/**
 * Большой контракт (F49): 40 правил в заголовках, правила-пункты раздела
 * данных, ссылки на решения (DEC-…), сценарии тестов (TC-…) и правила
 * соседнего документа (BK-…), журнал поправок и цитаты прежнего текста.
 * Около 150 ID-токенов разных видов; ревьюер группирует ID по строкам.
 */
const RULES = 40;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const rule = (i: number) => `LN-${pad(i)}`;
const tests = (i: number) => [`TC-${pad(2 * i - 1, 3)}`, `TC-${pad(2 * i, 3)}`];
const decision = (i: number) => `DEC-${pad(100 + (i % 12), 3)}`;

function document(consolidated: boolean) {
  const out = [
    '# Library loans: borrowing and returns',
    '',
    'Behaviour of the loan service after stage 2. Basis — DEC-040 (replaces',
    'DEC-002 and DEC-011).' +
      (consolidated ? '' : ' These are target rules, not a change journal.'),
    '',
  ];
  if (!consolidated)
    out.push(
      '> **Amendment history (stage 2, DEC-040).**',
      '> - LN-01 changed: a member holds at most five loans.',
      '> - LN-02, LN-03 changed: the due date counts from the pickup.',
      `> - Added: LN-21…LN-${RULES} (renewals, holds and fines).`,
      '',
    );
  out.push(
    '## 1. Purpose and scope',
    '',
    'Titles and authors come from BK-07 (`books.md`); the loan service does not',
    'edit the catalogue (DEC-003).',
    '',
    '## 2. Data',
    '',
    'A loan row holds the copy, the member and the due date (DEC-005, INV-04).',
    '',
    '- RET-01: a returned copy is free at once.',
    '- RET-02: a lost copy stays on the member until it is paid.',
    '',
    '### 2.1 Repository',
    '',
    '`startLoan`, `renew`, `finishLoan` write in one transaction (DEC-004, NFR-07).',
    '',
    '## 3. Rules',
    '',
  );
  for (let i = 1; i <= RULES; i++) {
    out.push(`### ${rule(i)}. Rule number ${i} (${decision(i)})`, '');
    out.push(`- The loan obeys condition ${i}${i % 2 ? '' : `, after ${rule(i - 1)}`}.`);
    if (!consolidated && i % 3 === 0)
      out.push(`  Previous wording: «condition ${i} applied only to new members».`);
    out.push(`- A refusal names condition ${i}.`, '');
    out.push(`Tests: ${tests(i).join(', ')}${consolidated ? '' : ' (new tests)'}.`, '');
  }
  out.push(
    '## 4. Tests',
    '',
    '| File | Rules |',
    '|---|---|',
    `| \`tests/loans.test.ts\` | LN-01…LN-${RULES} (TC-001…TC-${pad(2 * RULES, 3)}) |`,
    `| \`tests/repository.test.ts\` | section 2.1 (NFR-07) |`,
    '',
    '## 5. Known differences from earlier amendments',
    '',
    '1. **Renewal limit.**' +
      (consolidated ? '' : ' Previous text: «two renewals».') +
      ' A loan renews three times (DEC-104).',
    '2. **Fines.** A fine is counted per day late (DEC-105).',
    '',
  );
  return out.join('\n');
}
const OLD = document(false);
const NEW = document(true);

/** Отображение, как его пишет ревьюер: ID группами, разделы — по-разному. */
function mapping() {
  const out = [
    'The consolidation keeps the meaning: only the amendment history and previous wordings are gone.',
    'Mapping (old → new):',
    '- Library loans: borrowing and returns, DEC-040, DEC-002, DEC-011 → Library loans: borrowing and returns (same words)',
    '- Amendment history block → removed as history; every change already stands in its rule below',
    '- §1 «Purpose and scope», BK-07, DEC-003 → §1 (verbatim)',
    '- «2. Data», RET-01, RET-02, DEC-005, INV-04 → «2. Data» (verbatim)',
    '- §2.1, DEC-004, NFR-07 → «2.1 Repository»',
  ];
  for (let i = 1; i <= RULES; i++)
    out.push(
      `- ${rule(i)}, ${decision(i)}, ${tests(i).join(', ')} → ${rule(i)} (${i % 3 ? 'verbatim' : 'previous wording removed'})`,
    );
  out.push(
    `- «4. Tests», TC-001…TC-${pad(2 * RULES, 3)}, NFR-07 → «4. Tests» ("new tests" marks removed)`,
    '- 5. Known differences, items 1–2 (DEC-104, DEC-105) → «5. Known differences» (quotes of the previous text removed)',
    '- TC-001 → LN-01; TC-003 → LN-02; RET-01 → 2. Data',
  );
  return out.join('\n');
}

test('F49: the rules a contract defines are found by structure; ADR, test and sibling ids are references', () => {
  assert.ok(idTokens(OLD).length >= 140, `${idTokens(OLD).length} ID-токенов`);
  const defined = [...definitions(OLD).keys()].sort();
  assert.deepEqual(defined, [
    ...Array.from({ length: RULES }, (_, i) => rule(i + 1)),
    'RET-01',
    'RET-02',
  ]);
  // Метка заголовка сильнее упоминания: LN-01 определён заголовком.
  assert.equal(definitions(OLD).get('LN-01'), 3);
  assert.equal(definitions(OLD).get('RET-01'), 2);
  // Метка правила в тексте (`REQ-3. Text`) — тоже определение.
  assert.ok(definitions('Amendment (stage 3): REQ-3. Sorted by name.\n').has('REQ-3'));
  // Начало блока без разделителя («LN-01 changed») — не определение.
  assert.equal(definitions('> - LN-01 changed: five loans.\n').has('LN-01'), false);
});

test('F49: grouped mapping lines pass when the target holds every id; references kept verbatim need no line', () => {
  assert.deepEqual(mappingGaps(OLD, NEW, mapping()), []);
});

test('F49: a group whose target does not hold an id, two headings on one line and a dropped reference are still gaps', () => {
  // Раздел LN-05 не содержит LN-06: не отображены ни правило, ни его раздел.
  const merged = mapping().replace(
    `- ${rule(6)}, ${decision(6)}, ${tests(6).join(', ')} → ${rule(6)}`,
    `- ${rule(5)}, ${rule(6)} → ${rule(5)}`,
  );
  assert.deepEqual(mappingGaps(OLD, NEW, merged), [rule(6), '«LN-06. Rule number 6 (DEC-106)»']);
  // Два прежних заголовка в одной строке.
  const bulk = mapping()
    .replace('- «2. Data», RET-01, RET-02, DEC-005, INV-04 → «2. Data» (verbatim)', '')
    .replace('- §2.1, DEC-004, NFR-07 → «2.1 Repository»', '- «2. Data», §2.1 → «2. Data»');
  assert.deepEqual(mappingGaps(OLD, NEW, bulk), ['RET-02', '«2. Data»', '«2.1 Repository»']);
  // Ссылка пропала из нового текста — пропуск, даже без строки отображения.
  assert.deepEqual(mappingGaps(OLD, NEW.replace('BK-07', 'the catalogue'), mapping()), ['BK-07']);
});

test('F49: the controller returns every gap, not the first 30, and records an approved but incomplete review as incomplete-mapping', async () => {
  const s = await consolidationStage();
  try {
    // Действующая редакция — большой документ с поправками.
    await s.commitDoc(OLD);
    await reviewContract(s.h, s.root, s.proposal, 'codex', reviewers(s.calls, s.prompts));
    await s.commitDoc(NEW);
    const head = s.sh('rev-parse', 'HEAD');
    const plan = await consolidationPlan(s.h, parseProposal(s.proposal), head);
    assert.equal(plan.ids.length, RULES + 2);
    assert.ok(plan.references.includes('DEC-040') && plan.references.includes('TC-080'));
    // Одобрение смысла с итогом без отображения.
    const before = s.store.read().contracts.length;
    const lazy = reviewers(s.calls, s.prompts, () => ({
      approved: true,
      summary: 'Meaning kept.',
    }));
    const error = await reviewConsolidation(s.h, s.root, s.proposal, 'codex', lazy, () => {}, head)
      .then(() => undefined)
      .catch((e: Error) => e);
    const attempt = s.store.read().contractAttempts!.at(-1)!;
    assert.equal(attempt.outcome, 'incomplete-mapping');
    assert.equal(attempt.approved, false);
    // 42 правила и 46 заголовков (пустой «3. Rules» остался в тексте — не нужен).
    assert.equal(attempt.gaps?.length, RULES + 2 + 46);
    assert.ok(
      attempt.gaps.includes(rule(RULES)) &&
        attempt.gaps.includes('«5. Known differences from earlier amendments»'),
    );
    assert.ok(!attempt.gaps.includes('«3. Rules»'));
    assert.match(error?.message ?? '', /ревью одобрило смысл, но итог не называет 88 пропусков/);
    for (const gap of attempt.gaps) assert.ok(error!.message.includes(gap), gap);
    assert.equal(s.store.read().contracts.length, before, 'ничего не зарегистрировано');
    // Следующий раунд получает весь список и проходит с группами.
    const c = await reviewConsolidation(
      s.h,
      s.root,
      s.proposal,
      'codex',
      reviewers(s.calls, s.prompts, () => ({ approved: true, summary: mapping() })),
      () => {},
      head,
    );
    assert.match(s.prompts.at(-1)!, /"gaps":\s*\[/);
    assert.ok(s.prompts.at(-1)!.includes(`"${rule(RULES)}"`));
    assert.equal(c.content, NEW);
    assert.ok(c.consolidates?.from);
  } finally {
    await s.remove();
  }
});
