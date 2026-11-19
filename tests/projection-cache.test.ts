import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { ProjectionCache, etagged, etaggedBody } from '../src/application/projection-cache.ts';
import { markLeadActivity } from '../src/runner/lead-activity.ts';
import { LEAD_QUIET_MS } from '../src/runner/quick.ts';
import { setTimeout as sleep } from 'node:timers/promises';

test('Кэш проекции: та же версия — без пересчёта; новая версия, другие объекты процесса и срок — пересчёт', () => {
  let now = 1_000;
  const cache = new ProjectionCache<string>({ maxAgeMs: 100, size: 2, now: () => now });
  const config = {};
  let n = 0;
  const get = (scope: string, stamp: string, deps: unknown[] = [config], until?: number) =>
    cache.get(scope, stamp, deps, () => ({ value: `${scope}:${stamp}:${++n}`, until }));
  assert.equal(get('a', '1'), 'a:1:1');
  assert.equal(get('a', '1'), 'a:1:1', 'повтор той же версии — из кэша');
  assert.equal(cache.computations, 1);
  assert.equal(get('a', '2'), 'a:2:2', 'новая ревизия данных');
  assert.equal(get('a', '2', [{}]), 'a:2:3', 'другая конфигурация (по тождеству)');
  now += 100;
  assert.equal(get('a', '2', [{}]), 'a:2:4', 'предел возраста');
  // Срок проекции (lease) короче предела.
  assert.equal(get('b', '2', [config], now + 10), 'b:2:5');
  now += 5;
  assert.equal(get('b', '2'), 'b:2:5');
  now += 5;
  assert.equal(get('b', '2'), 'b:2:6', 'срок проекции истёк');
  // Областей не больше `size`: давно не читанная вытесняется.
  const small = new ProjectionCache<number>({ maxAgeMs: 60_000, size: 2 });
  const read = (scope: string) => small.get(scope, '1', [], () => ({ value: small.computations }));
  read('a');
  read('b');
  read('a');
  assert.equal(small.computations, 2, 'a и b в кэше');
  read('c');
  read('a');
  assert.equal(small.computations, 3, 'a читалась недавно и осталась');
  read('b');
  assert.equal(small.computations, 4, 'b вытеснена');
});

test('Кэш проекции: minAgeMs — молодое значение переживает новую ревизию, но не смену deps и не срок', () => {
  let now = 0;
  const cache = new ProjectionCache<string>({ maxAgeMs: 100, minAgeMs: 30, now: () => now });
  const deps = [{}];
  let n = 0;
  const get = (stamp: string, d: unknown[] = deps, until?: number) =>
    cache.get('a', stamp, d, () => ({ value: `${stamp}:${++n}`, until }));
  assert.equal(get('1'), '1:1');
  now = 29;
  assert.equal(get('2'), '1:1', 'новая ревизия моложе minAgeMs — прежнее значение');
  now = 30;
  assert.equal(get('2'), '2:2', 'возраст minAgeMs — пересчёт');
  now = 40;
  assert.equal(get('3', [{}]), '3:3', 'смена deps — пересчёт сразу');
  const fresh = [{}];
  assert.equal(get('4', fresh, 45), '4:4');
  now = 45;
  assert.equal(get('5', fresh), '5:5', 'срок until — пересчёт и моложе minAgeMs');
  // Без minAgeMs новая ревизия пересчитывается всегда.
  const plain = new ProjectionCache<number>({ maxAgeMs: 100, now: () => now });
  plain.get('a', '1', [], () => ({ value: 1 }));
  plain.get('a', '2', [], () => ({ value: 2 }));
  assert.equal(plain.computations, 2);
});

test('Кэш проекции: одновременные запросы ждут одно вычисление, отказ не остаётся в кэше', async () => {
  const cache = new ProjectionCache<Promise<number>>({ maxAgeMs: 60_000 });
  let n = 0;
  let fail = true;
  const get = () =>
    cache.get('a', '1', [], () => ({
      value: (async () => {
        await Promise.resolve();
        n++;
        if (fail) throw new Error('сбой');
        return n;
      })(),
    }));
  const [x, y] = [get(), get()];
  assert.equal(x, y, 'одно обещание на двоих');
  await assert.rejects(x, /сбой/);
  fail = false;
  assert.equal(await get(), 2, 'после отказа — новое вычисление');
  assert.equal(await get(), 2);
});

test('Метка ответа: то же содержимое после пересчёта сохраняет метку, поле момента чтения не в счёт', () => {
  const first = etagged({ a: 1, generatedAt: 't1' }, undefined, ['generatedAt']);
  assert.deepEqual(JSON.parse(first.body), { etag: first.etag, generatedAt: 't1', a: 1 });
  const same = etagged({ a: 1, generatedAt: 't2' }, first, ['generatedAt']);
  assert.equal(same.etag, first.etag);
  assert.equal((JSON.parse(same.body) as { generatedAt: string }).generatedAt, 't2');
  const changed = etagged({ a: 2, generatedAt: 't3' }, same, ['generatedAt']);
  assert.notEqual(changed.etag, first.etag);
  assert.deepEqual(JSON.parse(etaggedBody(changed, changed.etag)), {
    unchanged: true,
    etag: changed.etag,
  });
  assert.equal(etaggedBody(changed, first.etag), changed.body);
  const empty = etagged({}, undefined);
  assert.deepEqual(JSON.parse(empty.body), { etag: empty.etag });
});

test('F60: опрос обзора, центра внимания, сводки и подготовки — одна проекция на версию данных; перемена даёт новый ответ', async () => {
  const f = fixture();
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const get = async (path: string) => {
      const response = await fetch(app.url + path);
      assert.equal(response.status, 200, path);
      return (await response.json()) as Record<string, unknown> & { etag: string };
    };
    const { overviews, attentions, summaries, preparations } = app.projections;
    const revision = f.store.revision();

    // Обзор: повтор — из кэша, с меткой — «без изменений».
    const overview = await get('/api/overview');
    assert.equal(typeof overview.etag, 'string');
    assert.deepEqual(await get('/api/overview'), overview);
    assert.deepEqual(await get('/api/overview?etag=' + overview.etag), {
      unchanged: true,
      etag: overview.etag,
    });
    assert.equal(overviews.computations, 1);

    // Центр внимания и подготовка — так же.
    const attention = await get('/api/attention');
    assert.deepEqual(await get('/api/attention?etag=' + attention.etag), {
      unchanged: true,
      etag: attention.etag,
    });
    await get('/api/attention');
    assert.equal(attentions.computations, 1);
    // Экран этапа (F88): метка, «без изменений» с ней, метка — не часть области.
    const preparation = await get('/api/preparation');
    assert.equal(typeof preparation.etag, 'string');
    assert.deepEqual(await get('/api/preparation'), preparation);
    assert.deepEqual(await get('/api/preparation?etag=' + preparation.etag), {
      unchanged: true,
      etag: preparation.etag,
    });
    assert.equal(preparations.computations, 1);

    // Сводка: вторая вкладка без номера получает посчитанный ответ.
    const summary = await get('/api/summary');
    assert.deepEqual(await get('/api/summary'), summary);
    assert.equal(summaries.computations, 1);
    assert.equal(f.store.revision(), revision, 'простаивающий сервер не пишет');

    // Запись без перемены обзора: пересчёт, но метка прежняя.
    f.store.atomic(() => f.store.saveLocal('f60-test', undefined, 'k', { at: 1 }));
    assert.deepEqual(await get('/api/overview?etag=' + overview.etag), {
      unchanged: true,
      etag: overview.etag,
    });
    assert.equal(overviews.computations, 2);

    // Запись без перемены экрана этапа: пересчёт, метка прежняя.
    assert.deepEqual(await get('/api/preparation?etag=' + preparation.etag), {
      unchanged: true,
      etag: preparation.etag,
    });
    assert.equal(preparations.computations, 2);

    // Настоящая перемена — новый ответ и новая метка.
    f.h.createBoard('Новое изменение', '', 'main');
    f.h.addTask(f.store.read().boards[0].id, input());
    const fresh = await get('/api/overview?etag=' + overview.etag);
    assert.notEqual(fresh.etag, overview.etag);
    assert.ok((fresh.changes as { title: string }[]).some((c) => c.title === 'Новое изменение'));
    const next = await get('/api/summary?revision=' + String(summary.revision));
    assert.equal(next.unchanged, undefined);
    assert.equal((next.boards as unknown[]).length, 1);
    assert.equal(summaries.computations, 2);

    // Отметка присутствия ведущего — файл вне базы: тоже новая версия.
    const before = await get('/api/attention');
    assert.equal((before.lead as { present: boolean }).present, false);
    markLeadActivity(f.store, 'agent', 'test');
    const lead = await get('/api/attention?etag=' + before.etag);
    assert.notEqual(lead.etag, before.etag);
    assert.equal((lead.lead as { present: boolean }).present, true);

    // Присутствие кончается без записи: срок ответа — конец присутствия.
    markLeadActivity(f.store, 'agent', 'test', new Date(Date.now() - LEAD_QUIET_MS + 2_000));
    const fading = await get('/api/attention');
    assert.equal((fading.lead as { present: boolean }).present, true);
    const computed = attentions.computations;
    await sleep(2_500);
    const gone = await get('/api/attention?etag=' + fading.etag);
    assert.equal(attentions.computations, computed + 1, 'срок присутствия истёк — пересчёт');
    assert.equal((gone.lead as { present: boolean }).present, false);

    // Сбой проекции журнала — состояние процесса: сводка с прежним номером
    // отвечает полностью и называет его.
    const plain = await get('/api/summary');
    f.store.projectionError = 'Error: журнал не записан';
    const failed = await get('/api/summary?revision=' + String(plain.revision));
    assert.equal(failed.unchanged, undefined);
    assert.match(String(failed.journalError), /журнал не записан/);
    assert.deepEqual(await get('/api/summary?revision=' + String(failed.revision)), {
      revision: failed.revision,
      unchanged: true,
    });
  } finally {
    await app.close();
    f.cleanup();
  }
});
