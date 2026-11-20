/**
 * F95: закрытая вкладка панели не оставляет серверу работы. Опрос главной
 * (главная, центр внимания, сводки, подготовка, обзор, продукт) идёт по
 * keep-alive соединениям; после закрытия клиента у сервера нет ни его
 * соединений, ни таймеров, созданных обработкой его запросов, а кэши
 * проекций панели не больше своего предела. `GET /api/metrics` называет
 * соединения, счёт запросов, области кэшей и ресурсы цикла событий.
 *
 * Каждый случай называет поломку, которую ловит.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { createHook } from 'node:async_hooks';
import { setInterval as timersInterval } from 'node:timers';
import { fixture } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

type Metrics = {
  http: { connections: number; requests: number; projections: number };
  resources: Record<string, number>;
};

/** GET через агент клиента; тело читается целиком. */
function get(agent: Agent | false, url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Таймеры, созданные за время отслеживания и ещё живые: любой `Timeout`
 * процесса — глобальный или из `node:timers`, с `unref` или без, интервал
 * или цепочка коротких тайм-аутов (у цепочки всегда жив следующий). Их не
 * видит `process.getActiveResourcesInfo` (таймеры с `unref`), а простой
 * сервера они тратят.
 */
function trackTimers() {
  const live = new Map<number, string>();
  const hook = createHook({
    init(id, type) {
      if (type !== 'Timeout') return;
      const stack = new Error().stack?.split('\n').slice(5, 12).join(' | ') ?? '';
      // Кэш заголовка Date модуля http Node: одноразовый тайм-аут на секунду
      // после ответа, не работа сервера.
      if (!stack.includes('utcDate')) live.set(id, stack);
    },
    destroy(id) {
      live.delete(id);
    },
  });
  hook.enable();
  return { live: () => [...live.values()], restore: () => hook.disable() };
}

test('F95: после закрытия клиента панели у сервера нет его соединений и таймеров, кэши проекций в пределе', async () => {
  const f = fixture();
  const scheduler = new Scheduler(f.h, f.root);
  const app = await serve(f.h, scheduler, { port: 0 });
  // Такт очереди не участвует: таймеры за время опроса — только от запросов
  // клиента (цикл ведущего без заданий таймеров не ставит).
  await scheduler.stop();
  const metrics = async () => {
    const response = await get(false, app.url + '/api/metrics');
    assert.equal(response.status, 200);
    return JSON.parse(response.body) as Metrics;
  };
  try {
    const before = await metrics();
    // Соединение самого запроса счётчиков — единственное.
    assert.equal(before.http.connections, 1);
    // Отслеживание видит и то, что проверка «ресурсы как до клиента» не
    // видит: интервал из `node:timers` с `unref` и цепочку коротких
    // тайм-аутов. Без этого контроля пустой список ничего бы не доказывал.
    {
      const probe = trackTimers();
      const leak = timersInterval(() => {}, 5000).unref();
      let chain: NodeJS.Timeout | undefined;
      const again = () => (chain = setTimeout(again, 20).unref());
      again();
      await new Promise((r) => setTimeout(r, 70));
      // Само ожидание снимается следующим оборотом: живы ровно интервал и
      // текущее звено цепочки — каждый виден отдельно.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const seen = probe.live();
      assert.equal(seen.length, 2, `контроль утечки: ${seen.join('; ')}`);
      assert.ok(
        seen.some((t) => t.includes('setInterval')),
        seen.join('; '),
      );
      assert.ok(
        seen.some((t) => t.includes('again')),
        seen.join('; '),
      );
      clearInterval(leak);
      clearTimeout(chain);
      probe.restore();
    }
    const timers = trackTimers();
    const agent = new Agent({ keepAlive: true, maxSockets: 2 });
    let polls = 0;
    try {
      const paths = [
        '/',
        '/api/home',
        '/api/attention',
        '/api/summary',
        '/api/questions/summary',
        '/api/preparation',
        '/api/overview',
        '/api/product',
        '/api/state',
      ];
      for (let round = 0; round < 3; round++)
        for (const path of paths) {
          const response = await get(agent, app.url + path);
          // Опрос, отвеченный ошибкой, ничего бы не вычислял и не кэшировал.
          assert.equal(response.status, 200, `${path}: ${response.body.slice(0, 300)}`);
          polls++;
        }
      // Областей больше предела кэша: вытеснение держит его размер.
      for (let i = 0; i < 12; i++) {
        const response = await get(agent, `${app.url}/api/attention?component=probe${i}`);
        assert.equal(response.status, 200, response.body.slice(0, 300));
        polls++;
      }
      assert.ok(app.projections.attentions.computations >= 12, 'каждая область посчитана');
      assert.ok(
        app.projections.attentions.entryCount <= 8,
        `центр внимания хранит ${app.projections.attentions.entryCount} областей`,
      );
      // Клиент держит открытые keep-alive соединения — счётчик их видит.
      // Без него проверка «0 после закрытия» прошла бы и при утечке.
      const during = await metrics();
      assert.ok(during.http.connections >= 2, JSON.stringify(during.http));
      assert.equal(during.http.requests - before.http.requests, polls + 1);
      // Вкладка закрыта: соединения клиента рвутся.
      agent.destroy();
      await new Promise((r) => setTimeout(r, 200));
      // `destroy` сработавшего тайм-аута (и этого ожидания) приходит после
      // его вызова — следующим оборотом цикла.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(
        timers.live(),
        [],
        'обработка запросов клиента оставила таймеры: ' + timers.live().join(' ;; '),
      );
    } finally {
      timers.restore();
      agent.destroy();
    }
    const after = await metrics();
    assert.equal(after.http.connections, 1, 'соединения клиента закрыты');
    assert.deepEqual(after.resources, before.resources, 'ресурсы цикла событий — как до клиента');
    // Кэши проекций: не больше областей, чем видов ответа (предел — size кэша).
    const limit = Object.values(app.projections).length * 8;
    assert.ok(after.http.projections > 0, 'опрос заполнил кэши — иначе предел ничего не значит');
    assert.ok(after.http.projections <= limit, `${after.http.projections} > ${limit}`);
  } finally {
    await app.close();
    f.cleanup();
  }
});
