import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionService } from '../src/application/attention.ts';
import { quickFactsCache } from '../src/application/quick-view.ts';
import { architecture, product } from './preparation-fixture.ts';
import { byKey, preparationFixture } from './attention-fixture.ts';

// D04-A: для каждого источника — появление, повтор без дубликата,
// существенное обновление, устранение и повторное появление. Отметки
// «прочитано» по появлению проверяет attention-marks.test.ts.

const at = (now: number) => ({ now: () => now });

test('S1 вопрос ведущего: появление, повтор, ответ снимает, переспрос — новое появление', async () => {
  const f = preparationFixture();
  try {
    const now = Date.now();
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Кто модерирует чат ночью?', options: ['Бот', 'Дежурный'] }],
    });
    const q = f.store.read().preparation!.changes[0].questions[0];
    const key = `prep:q:${f.changeId}:${q.id}`;
    const first = await new AttentionService(f.store, undefined, at(now)).active();
    const item = byKey(first.items, key)!;
    assert.equal(item.actor, 'operator');
    assert.equal(item.category, 'question');
    assert.equal(item.occurrenceId, q.id);
    assert.ok(item.actions.some((a) => a.id === 'answer'));
    // Повтор и ход времени: тот же id и версия, без дубликата.
    const again = await new AttentionService(f.store, undefined, at(now + 60_000)).active();
    assert.deepEqual(
      again.items.filter((i) => i.sourceKey === key).map((i) => [i.id, i.sourceVersion]),
      [[item.id, item.sourceVersion]],
    );
    // Вопрос неизменяем: существенного обновления у источника нет.
    f.p.answer({ changeId: f.changeId, questionId: q.id, text: 'Дежурный модератор' });
    const answered = await new AttentionService(f.store, undefined).active();
    assert.equal(byKey(answered.items, key), undefined);
    // Переспрос — новый вопрос, новый предмет и появление.
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Кто модерирует чат в выходные?' }],
    });
    const q2 = f.store.read().preparation!.changes[0].questions[1];
    const reask = await new AttentionService(f.store, undefined).active();
    assert.equal(byKey(reask.items, `prep:q:${f.changeId}:${q2.id}`)!.occurrenceId, q2.id);
  } finally {
    f.cleanup();
  }
});

test('S2 ответ без решения ведущего: снятое решение — новое появление', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Нужна ли история сообщений?' }],
    });
    const q = f.store.read().preparation!.changes[0].questions[0];
    const key = `prep:qa:${f.changeId}:${q.id}`;
    const none = await new AttentionService(f.store, undefined).active();
    assert.equal(byKey(none.items, key), undefined);
    f.p.answer({ changeId: f.changeId, questionId: q.id, text: 'Да, за 30 дней' });
    const pending = byKey((await new AttentionService(f.store, undefined).active()).items, key)!;
    assert.equal(pending.actor, 'lead');
    assert.equal(pending.category, 'technical');
    assert.match(pending.occurrenceId, /^a:/);
    f.p.execute('preparation_resolve', {
      changeId: f.changeId,
      statement: 'История хранится 30 дней',
      rationale: 'Ответ оператора',
      questionId: q.id,
    });
    assert.equal(
      byKey((await new AttentionService(f.store, undefined).active()).items, key),
      undefined,
    );
    const record = f.store.read().preparation!.changes[0].decisions[0];
    f.p.execute('preparation_resolve', {
      changeId: f.changeId,
      withdraw: [{ id: record.id, reason: 'Пересмотрено' }],
    });
    const again = byKey((await new AttentionService(f.store, undefined).active()).items, key)!;
    assert.match(again.occurrenceId, /^w:/);
    assert.notEqual(again.occurrenceId, pending.occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('S3/S4 согласование этапа: редакция, доработка, новая редакция, прежняя постановка', async () => {
  const f = preparationFixture();
  try {
    const submit = (stage: 'product' | 'architecture') => {
      const view = f.p.status(f.changeId);
      if (!view.enabled) throw new Error('preparation');
      f.p.execute('preparation_submit', {
        changeId: f.changeId,
        stage,
        expectedDigest: view.current![stage]!.digest,
      });
      return view.current![stage]!.digest;
    };
    const items = async () => (await new AttentionService(f.store, undefined).active()).items;
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: null,
      reason: 'Первая постановка',
      content: product,
    });
    const digest1 = submit('product');
    const stageKey = `prep:stage:${f.changeId}:product`;
    const review = byKey(await items(), stageKey)!;
    assert.equal(review.actor, 'operator');
    assert.equal(review.category, 'decision');
    assert.equal(review.occurrenceId, 'r1');
    assert.deepEqual(
      review.actions.filter((a) => a.kind === 'domain').map((a) => a.id),
      ['approve', 'request-changes'],
    );
    // Доработка: карточка оператора уходит, появляется карточка ведущего.
    f.p.decide({
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: digest1,
      decision: 'request-changes',
      comment: 'Добавьте ночную модерацию',
    });
    const after = await items();
    assert.equal(byKey(after, stageKey), undefined);
    const rework = byKey(after, `prep:rework:${f.changeId}:product`)!;
    assert.equal(rework.actor, 'lead');
    assert.equal(rework.occurrenceId, 'r1');
    // Новая редакция снимает доработку и даёт новое появление согласования.
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: digest1,
      reason: 'Добавлена ночная модерация',
      content: { ...product, problem: product.problem + ' Ночью модерирует дежурный.' },
    });
    const digest2 = submit('product');
    const second = await items();
    assert.equal(byKey(second, `prep:rework:${f.changeId}:product`), undefined);
    assert.equal(byKey(second, stageKey)!.occurrenceId, 'r2');
    f.p.decide({
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: digest2,
      decision: 'approve',
      comment: 'Хорошо',
    });
    assert.equal(byKey(await items(), stageKey), undefined);
    // Архитектура на ревью, затем новая редакция продукта утверждена: прежняя
    // архитектура относится к прежней постановке — версия меняется, кнопки нет.
    f.p.execute('preparation_architecture', {
      changeId: f.changeId,
      expectedDigest: null,
      reason: 'Стек',
      content: architecture,
    });
    submit('architecture');
    const arch = byKey(await items(), `prep:stage:${f.changeId}:architecture`)!;
    assert.equal(arch.actor, 'operator');
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: digest2,
      reason: 'Уточнение',
      content: { ...product, problem: product.problem + ' Уточнено.' },
    });
    const digest3 = submit('product');
    f.p.decide({
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: digest3,
      decision: 'approve',
      comment: 'Ок',
    });
    const stale = byKey(await items(), `prep:stage:${f.changeId}:architecture`)!;
    assert.equal(stale.id, arch.id, 'та же редакция — то же появление');
    assert.notEqual(stale.sourceVersion, arch.sourceVersion);
    assert.equal(stale.actor, 'lead');
    assert.deepEqual(
      stale.actions.map((a) => a.kind),
      ['navigate'],
    );
  } finally {
    f.cleanup();
  }
});

test('S5 быстрый маршрут: подключение стоит, Git исправлен — карточки нет; тот же HEAD — то же появление (ограничение)', async () => {
  const f = preparationFixture();
  const repository = mkdtempSync(join(tmpdir(), 'devcontour-attention-repo-'));
  const workspace = mkdtempSync(join(tmpdir(), 'devcontour-attention-ws-'));
  try {
    writeFileSync(join(repository, 'package.json'), '{"name":"app","private":true}\n');
    writeFileSync(join(repository, 'package-lock.json'), '{"name":"app","lockfileVersion":3}\n');
    f.p.execute('preparation_quick', {
      requestKey: 'attention-quick-1',
      title: 'Быстрая правка',
      repository,
      brief: 'Исправить сложение отрицательных чисел',
      criterion: 'add(-2, -3) возвращает -5',
    });
    const changeId = f.store.read().preparation!.activeChangeId!;
    const key = `quick:${changeId}:connection`;
    // Без кэша: каждое чтение видит текущий Git.
    const service = () =>
      new AttentionService(f.store, undefined, {
        root: workspace,
        cachedFacts: quickFactsCache(0),
      });
    const blocked = byKey((await service().active()).items, key)!;
    assert.equal(blocked.actor, 'operator');
    assert.equal(blocked.category, 'access');
    assert.match(blocked.reason, /Git|git/);
    const repeat = byKey((await service().active()).items, key)!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [blocked.id, blocked.sourceVersion]);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'A',
          GIT_AUTHOR_EMAIL: 'a@example.test',
          GIT_COMMITTER_NAME: 'A',
          GIT_COMMITTER_EMAIL: 'a@example.test',
        },
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'init');
    assert.equal(byKey((await service().active()).items, key), undefined);
    // Ограничение источника без журнала: та же причина при том же HEAD (здесь
    // — без HEAD вовсе) возвращает прежнее появление. Новое поручение — новое.
    rmSync(join(repository, '.git'), { recursive: true, force: true });
    const back = byKey((await service().active()).items, key)!;
    assert.equal(back.occurrenceId, blocked.occurrenceId);
  } finally {
    f.cleanup();
    rmSync(repository, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
