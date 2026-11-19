import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, fixture, input } from './helpers.ts';
import { approvePreparation } from './preparation-fixture.ts';
import { Store } from '../src/core/store.ts';
import type { ProductChange } from '../src/core/preparation-model.ts';
import { Preparation } from '../src/core/preparation.ts';
import { authorOverview } from '../src/application/overview.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { queueStopOf } from '../src/application/queue-stop.ts';
import { AttentionService } from '../src/application/attention.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { etagged } from '../src/application/projection-cache.ts';

/**
 * Пути частого опроса панели читают замороженный снимок версии
 * (`Store.view`), а не разбирают документ заново: на большом состоянии один
 * разбор — сотни миллисекунд. Счётчик — разборы строки документа (и полного
 * чтения `read`, и снимка версии).
 *
 * Известное оставшееся полное чтение — сводка вопросов исполнителя
 * (`InputService.summaryContext`, источник `input` центра внимания): оно
 * считается отдельно (`known`) и не больше одного на расчёт центра.
 */
const KNOWN_READ = 'InputService.summaryContext';
function countParses() {
  const proto = Store.prototype as unknown as {
    parseDocument: (this: Store, text: string) => unknown;
    read: (this: Store) => ReturnType<Store['read']>;
  };
  const original = proto.parseDocument;
  const read = proto.read;
  let parses = 0;
  let reads = 0;
  let known = 0;
  let inKnown = false;
  proto.parseDocument = function (this: Store, text: string) {
    if (!inKnown) parses++;
    return original.call(this, text);
  };
  proto.read = function (this: Store) {
    if (!new Error().stack?.includes(KNOWN_READ)) {
      reads++;
      return read.call(this);
    }
    known++;
    inKnown = true;
    try {
      return read.call(this);
    } finally {
      inKnown = false;
    }
  };
  return {
    get parses() {
      return parses;
    },
    get reads() {
      return reads;
    },
    get known() {
      return known;
    },
    reset() {
      parses = reads = known = 0;
    },
    restore() {
      proto.parseDocument = original;
      proto.read = read;
    },
  };
}

/** Движок с доской, выполненной задачей и утверждённой подготовкой. */
function engineWithPreparation() {
  const f = fixture();
  const board = f.h.createBoard('Чат', '', 'main');
  const first = f.h.addTask(board.id, input('Первая задача'));
  f.h.addTask(board.id, input('Вторая задача', [first.id]));
  f.h.approve(board.id);
  complete(f.h, first.id);
  const changeId = approvePreparation(new Preparation(f.store));
  new Preparation(f.store).execute('preparation_question', {
    changeId,
    stage: 'product',
    add: [{ text: 'Нужна ли модерация ночью?', options: ['да', 'нет'] }],
  });
  return { ...f, changeId };
}

test('Read path: preparation, overview, lead jobs, queue stop and attention read the frozen view without a parse', async () => {
  const f = engineWithPreparation();
  const count = countParses();
  try {
    const view = f.store.view();
    count.reset();
    const status = Preparation.statusOf(view, undefined, { content: false });
    assert.equal(status.enabled, true);
    Preparation.statusOf(view, f.changeId);
    authorOverview(f.h, view);
    authorOverview(f.h);
    new LeadWorkflow(f.h).view(view);
    new LeadWorkflow(f.h).view();
    queueStopOf(f.h, view);
    queueStopOf(f.h);
    const service = new AttentionService(f.store, f.h, { root: f.root });
    const quick = await service.prerequisites();
    const attention = service.view({}, quick);
    assert.ok(attention.items.some((i) => i.source === 'prep-question'));
    assert.equal(count.reads, 0, 'no Store.read on the polled paths');
    assert.equal(count.parses, 0, 'the version snapshot is parsed once and shared');
    assert.ok(count.known <= 1, 'the writer-question summary reads once per attention view');
    // Снимок по-прежнему заморожен: проекции его не правят.
    assert.ok(Object.isFrozen(f.store.view().tasks));
  } finally {
    count.restore();
    f.cleanup();
  }
});

test('Read path: the view-based projections equal the copy-based ones, old rows without journal lists included', () => {
  const f = engineWithPreparation();
  try {
    const same = () => {
      for (const id of [undefined, f.changeId])
        for (const content of [true, false])
          assert.equal(
            JSON.stringify(Preparation.statusOf(f.store.view(), id, { content })),
            JSON.stringify(new Preparation(f.store).status(id, { content })),
          );
      assert.equal(
        JSON.stringify(authorOverview(f.h, f.store.view())),
        JSON.stringify(authorOverview(f.h, f.store.read())),
      );
      assert.equal(
        JSON.stringify(new LeadWorkflow(f.h).view(f.store.view())),
        JSON.stringify(new LeadWorkflow(f.h).view(f.store.read())),
      );
      assert.equal(
        JSON.stringify(queueStopOf(f.h, f.store.view())),
        JSON.stringify(queueStopOf(f.h, f.store.read())),
      );
    };
    same();
    // Строка прежней версии: у изменения нет списков журнала. Вид по снимку
    // не правит замороженный объект и совпадает с видом по копии.
    f.store.change('test.old-row', (s) => {
      const c: Partial<ProductChange> = s.preparation!.changes[0];
      delete c.activity;
      delete c.decisions;
      delete c.concept;
    });
    assert.equal(f.store.view().preparation!.changes[0].concept, undefined);
    same();
    assert.equal(f.store.view().preparation!.changes[0].concept, undefined, 'snapshot untouched');
  } finally {
    f.cleanup();
  }
});

test('Read path: /api/preparation, /api/overview and /api/attention of one revision cost one parse; bodies are unchanged', async () => {
  const f = engineWithPreparation();
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  const count = countParses();
  try {
    const text = async (path: string) => {
      const response = await fetch(app.url + path);
      assert.equal(response.status, 200, path);
      return response.text();
    };
    // Новая ревизия: прежний снимок недействителен.
    f.store.atomic(() => f.store.saveLocal('read-path', undefined, 'k', { at: 1 }));
    f.h.createBoard('Ещё доска', '', 'main');
    count.reset();
    const preparation = await text('/api/preparation');
    const overview = await text('/api/overview');
    await text('/api/attention');
    assert.equal(count.reads, 0, 'no Store.read');
    assert.ok(count.parses <= 1, `one parse per revision, got ${count.parses}`);
    assert.ok(count.known <= 1);

    // Тело подготовки — вид по копии документа с полями движка.
    const parsed = JSON.parse(preparation) as Record<string, unknown>;
    const { enabled, ...rest } = new Preparation(f.store).status();
    assert.equal(enabled, true);
    assert.equal(
      JSON.stringify(Object.fromEntries(Object.keys(rest).map((k) => [k, parsed[k]]))),
      JSON.stringify(rest),
    );
    // Тело обзора — обзор по копии документа с той же меткой.
    const { etag } = JSON.parse(overview) as { etag: string };
    const legacy = etagged({ ...authorOverview(f.h, f.store.read()) }, undefined);
    assert.equal(overview, legacy.body.replace(legacy.etag, etag));
  } finally {
    count.restore();
    await app.close();
    f.cleanup();
  }
});

test('Read path: the product map is computed at most once per 30 s, across revisions', async () => {
  const f = engineWithPreparation();
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const get = async () => {
      const response = await fetch(app.url + '/api/product');
      assert.equal(response.status, 200);
      return response.text();
    };
    const first = await get();
    f.store.atomic(() => f.store.saveLocal('read-path', undefined, 'k', { at: 2 }));
    const count = countParses();
    try {
      assert.equal(await get(), first);
      assert.equal(await get(), first);
      assert.equal(count.parses, 0, 'a repeated product read parses nothing');
    } finally {
      count.restore();
    }
    assert.equal(app.projections.products.computations, 1);
    // Другая область (релиз) — свой расчёт.
    await fetch(app.url + '/api/product?release=none');
    assert.equal(app.projections.products.computations, 2);
  } finally {
    await app.close();
    f.cleanup();
  }
});
