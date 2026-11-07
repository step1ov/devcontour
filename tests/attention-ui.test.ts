import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionActors,
  attentionCategories,
  type AttentionItem,
} from '../src/core/attention-model.ts';
import type { AttentionView } from '../src/application/attention.ts';
import {
  categoryLabel,
  freshItems,
  headlineOf,
  impactLine,
  nextFocusKey,
  openLabel,
  signatureOf,
  toastText,
  unreadCount,
  withOptimistic,
  SEEN_LIMIT,
} from '../src/web/attention-logic.ts';

// Правила интерфейса центра внимания без DOM: подписи, подпись ответа,
// уведомления, локальные отметки и фокус после исчезновения карточки.

const item = (over: Partial<AttentionItem> & { sourceKey: string }): AttentionItem => ({
  id: `${over.sourceKey}#${over.occurrenceId ?? 'o1'}`,
  occurrenceId: 'o1',
  sourceVersion: 'v1',
  source: 'input',
  category: 'question',
  actor: 'operator',
  title: 'Карточка ' + over.sourceKey,
  reason: 'Причина',
  impact: { tasks: 1, waiting: 0, boards: [], taskIds: [] },
  since: '2026-11-07T10:00:00.000Z',
  subject: { kind: 'task', id: 't', href: '/?view=boards&tab=list&task=t' },
  evidence: [],
  actions: [],
  state: { read: false, acknowledged: false, unread: true },
  ...over,
});

const view = (items: AttentionItem[], over: Partial<AttentionView> = {}): AttentionView => ({
  revision: 1,
  generatedAt: '2026-11-07T10:00:00.000Z',
  engineConnected: true,
  lead: { present: true, lastActivityAt: null },
  counts: {
    active: items.length,
    unread: items.filter((i) => i.actor === 'operator' && i.state.unread).length,
    byActor: {
      operator: { active: 0, unread: 0 },
      lead: { active: 0, unread: 0 },
    },
  },
  items,
  ...over,
});

test('A lead item never gets operator wording, for every category', () => {
  const operatorWords = ['Ваше решение', 'Вопрос к вам', 'Нужно ваше действие'];
  for (const category of attentionCategories)
    for (const actor of attentionActors) {
      const label = categoryLabel({ actor, category });
      if (actor === 'lead') {
        assert.match(label.text, /^Ведущий агент · /, category);
        assert.equal(label.variant, 'secondary');
        for (const word of operatorWords) assert.ok(!label.text.includes(word), label.text);
      } else assert.ok(!label.text.startsWith('Ведущий агент'), label.text);
    }
  assert.equal(categoryLabel({ actor: 'operator', category: 'decision' }).text, 'Ваше решение');
  assert.equal(categoryLabel({ actor: 'operator', category: 'question' }).text, 'Вопрос к вам');
  assert.equal(
    categoryLabel({ actor: 'lead', category: 'technical' }).text,
    'Ведущий агент · техническое',
  );
});

test('The blocking line counts tasks and waiting tasks, and is empty without tasks', () => {
  assert.equal(impactLine({ tasks: 0, waiting: 0, boards: [], taskIds: [] }), '');
  assert.equal(impactLine({ tasks: 1, waiting: 0, boards: [], taskIds: [] }), 'Держит задачу');
  assert.equal(
    impactLine({ tasks: 1, waiting: 100, boards: [], taskIds: [] }),
    'Держит 1 задачу; ждут результата: 100',
  );
  assert.equal(
    impactLine({ tasks: 3, waiting: 0, boards: [], taskIds: [] }),
    'Держит 3 задачи; ждут результата: 0',
  );
  assert.equal(
    impactLine({ tasks: 5, waiting: 2, boards: [], taskIds: [] }),
    'Держит 5 задач; ждут результата: 2',
  );
});

test('The open link is named by the subject; a preparation question opens the question', () => {
  const a = item({ sourceKey: 'a' });
  assert.equal(openLabel(a), 'Открыть задачу');
  assert.equal(
    openLabel({ source: 'prep-question', subject: { kind: 'change', id: 'c', href: '/' } }),
    'Открыть вопрос',
  );
  assert.equal(
    openLabel({ source: 'prep-stage', subject: { kind: 'change', id: 'c', href: '/' } }),
    'Открыть изменение',
  );
  assert.equal(
    openLabel({ source: 'input', subject: { kind: 'request', id: 'r', href: '/' } }),
    'Открыть вопрос',
  );
});

test('The signature ignores a heartbeat and sees versions, marks and lead presence', () => {
  const a = item({ sourceKey: 'a' });
  const base = signatureOf(view([a]));
  // Новое время ответа — то же содержимое.
  assert.equal(signatureOf(view([a], { generatedAt: '2026-11-07T11:00:00.000Z' })), base);
  assert.notEqual(signatureOf(view([{ ...a, sourceVersion: 'v2' }])), base);
  assert.notEqual(
    signatureOf(view([{ ...a, state: { read: true, acknowledged: false, unread: false } }])),
    base,
  );
  assert.notEqual(signatureOf(view([a], { lead: { present: false, lastActivityAt: null } })), base);
  // Факт без записи (зависание) меняет карточки при той же ревизии.
  assert.notEqual(signatureOf(view([a, item({ sourceKey: 'b' })])), base);
});

test('Notifications: none on first load, a version change, a lead item or a returning id', () => {
  const a = item({ sourceKey: 'a' });
  const first = freshItems(undefined, [a, item({ sourceKey: 'lead', actor: 'lead' })]);
  assert.deepEqual(first.fresh, []);
  // Тот же ответ ещё раз (heartbeat).
  const again = freshItems(first.seen, [a]);
  assert.deepEqual(again.fresh, []);
  // Существенное обновление того же появления — только снова непрочитано.
  assert.deepEqual(freshItems(again.seen, [{ ...a, sourceVersion: 'v2' }]).fresh, []);
  // Новое появление того же предмета и новая карточка оператора уведомляют.
  const b = item({ sourceKey: 'b' });
  const next = item({ sourceKey: 'a', occurrenceId: 'o2', id: 'a#o2' });
  const step = freshItems(again.seen, [next, b, item({ sourceKey: 'l2', actor: 'lead' })]);
  assert.deepEqual(
    step.fresh.map((i) => i.id),
    ['a#o2', 'b#o1'],
  );
  assert.equal(toastText(step.fresh), 'Новых действий: 2');
  assert.equal(toastText([b]), 'Нужно действие: Карточка b');
  // Решённая и вернувшаяся с тем же id карточка — та же.
  const gone = freshItems(step.seen, []);
  assert.deepEqual(freshItems(gone.seen, [b]).fresh, []);
  // Прочитанная в другой вкладке новая карточка не уведомляет.
  const read = item({
    sourceKey: 'c',
    state: { read: true, acknowledged: false, unread: false },
  });
  assert.deepEqual(freshItems(gone.seen, [read]).fresh, []);
});

test('The seen set is bounded and drops the oldest ids', () => {
  const many = Array.from({ length: SEEN_LIMIT + 5 }, (_, i) => item({ sourceKey: 'k' + i }));
  const seen = freshItems(undefined, many).seen;
  assert.equal(seen.size, SEEN_LIMIT);
  assert.ok(!seen.has('k0#o1'));
  assert.ok(seen.has(`k${SEEN_LIMIT + 4}#o1`));
});

test('Optimistic marks apply only to the version shown and lower the badge', () => {
  const a = item({ sourceKey: 'a' });
  const b = item({ sourceKey: 'b' });
  const v = view([a, b], {
    counts: {
      active: 250,
      unread: 230,
      byActor: { operator: { active: 0, unread: 0 }, lead: { active: 0, unread: 0 } },
    },
  });
  const marked = withOptimistic(
    v.items,
    new Map([['a#o1', { version: 'v1', read: true, ack: false }]]),
  );
  assert.equal(marked[0].state.unread, false);
  assert.equal(marked[0].state.acknowledged, false);
  assert.equal(marked[1].state.unread, true);
  // Карточки за пределом списка остаются в счёте сервера.
  assert.equal(unreadCount(v, marked), 229);
  // «Увидел» включает «прочитано».
  const acked = withOptimistic(
    v.items,
    new Map([['a#o1', { version: 'v1', read: true, ack: true }]]),
  );
  assert.deepEqual(acked[0].state, { read: true, acknowledged: true, unread: false });
  // Отметка старой версии не снимает новую.
  const newer = withOptimistic(
    [{ ...a, sourceVersion: 'v2' }],
    new Map([['a#o1', { version: 'v1', read: true, ack: true }]]),
  );
  assert.equal(newer[0].state.unread, true);
});

test('Focus after a card disappears goes to the next card, then the previous one', () => {
  assert.equal(nextFocusKey(['a', 'b', 'c'], ['a', 'c'], 'b'), 'c');
  assert.equal(nextFocusKey(['a', 'b', 'c'], ['a', 'b'], 'c'), 'b');
  assert.equal(nextFocusKey(['a'], [], 'a'), undefined);
  // Следующая тоже исчезла — ближайшая оставшаяся.
  assert.equal(nextFocusKey(['a', 'b', 'c', 'd'], ['a', 'd'], 'b'), 'd');
});

test('The overview headline keeps the old priority and never calls a lead item the author’s decision', () => {
  const o = { headline: 'Исполнители работают над задачами: 1.', counts: { tasks: 3 } };
  const op = (category: AttentionItem['category'], source: AttentionItem['source'] = 'input') => ({
    actor: 'operator' as const,
    category,
    source,
  });
  const lead = { actor: 'lead' as const, category: 'technical' as const, source: 'work' as const };
  assert.equal(headlineOf(o, []), o.headline);
  assert.match(
    headlineOf(o, [op('decision', 'changeset'), op('access', 'queue')]),
    /нужен внешний доступ или бюджет/,
  );
  assert.match(headlineOf(o, [op('budget', 'budget')]), /нужен внешний доступ или бюджет/);
  assert.match(headlineOf(o, [lead, op('decision', 'changeset')]), /по готовому изменению/);
  assert.equal(headlineOf(o, [op('question')]), 'Нужно ваше решение.');
  // Можно попробовать — важнее техники ведущего.
  assert.equal(headlineOf({ ...o, tryNow: {} }, [lead]), o.headline);
  assert.match(headlineOf(o, [lead]), /разбирает ведущий агент/);
  assert.doesNotMatch(headlineOf(o, [lead]), /ваше решение/i);
  // Пока задач нет, говорит сводка.
  const empty = { headline: 'Разработка ещё не началась: задач пока нет.', counts: { tasks: 0 } };
  assert.equal(headlineOf(empty, [op('question', 'prep-question')]), empty.headline);
});

test('A draft names the version shown when its form opened, and outlives its card', async () => {
  const { emptyDraft, pinStale, orphanDrafts, draftKey } =
    await import('../src/web/attention-drafts.ts');
  const a = item({ sourceKey: 'prep:stage:C:product', occurrenceId: 'r3', id: 'x#r3' });
  const draft = {
    ...emptyDraft(),
    open: 'request-changes',
    text: 'Поправьте сценарий r3',
    pin: { occurrenceId: 'r3', sourceVersion: 'v1', title: a.title, reason: a.reason },
  };
  assert.equal(draftKey(a), 'prep:stage:C:product#r3');
  assert.equal(pinStale(draft, a), false);
  // Опрос принёс новую версию того же появления — форма не отправляется молча.
  assert.equal(pinStale(draft, { ...a, sourceVersion: 'v2' }), true);
  // Новое появление того же предмета — тоже не та версия.
  assert.equal(pinStale(draft, { ...a, occurrenceId: 'r4' }), true);
  assert.equal(pinStale({ ...draft, open: null }, { ...a, sourceVersion: 'v2' }), false);
  // Появление исчезло — черновик с текстом показывается отдельно; пустой — нет.
  const all = new Map([
    ['prep:stage:C:product#r3', draft],
    ['input:IR-1#IR-1', { ...emptyDraft(), open: 'answer', text: '  ' }],
  ]);
  assert.deepEqual(
    orphanDrafts(all, [{ id: 'prep:stage:C:product#r4' }]).map(([k]) => k),
    ['prep:stage:C:product#r3'],
  );
  assert.deepEqual(orphanDrafts(all, [{ id: 'prep:stage:C:product#r3' }]), []);
});
