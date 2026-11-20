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
 * Таймеры, созданные за время `during` и не снятые (не сработавшие) к его
 * концу: интервалы и тайм-ауты от секунды, в том числе с `unref` — их не
 * видит `process.getActiveResourcesInfo`, а простой сервера они тратят.
 */
function trackTimers() {
  const live = new Map<unknown, string>();
  const g = globalThis as unknown as Record<string, (...args: unknown[]) => unknown>;
  const original = {
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
  };
  g.setInterval = (fn: unknown, ms: unknown, ...rest: unknown[]) => {
    const handle = original.setInterval(fn, ms, ...rest);
    live.set(handle, `setInterval ${String(ms)}ms ${new Error().stack?.split('\n')[2]?.trim()}`);
    return handle;
  };
  g.setTimeout = (fn: unknown, ms: unknown, ...rest: unknown[]) => {
    if (typeof ms !== 'number' || ms < 1000) return original.setTimeout(fn, ms, ...rest);
    const handle: unknown = original.setTimeout(
      (...args: unknown[]) => {
        live.delete(handle);
        (fn as (...a: unknown[]) => void)(...args);
      },
      ms,
      ...rest,
    );
    live.set(handle, `setTimeout ${ms}ms ${new Error().stack?.split('\n')[2]?.trim()}`);
    return handle;
  };
  g.clearInterval = (handle: unknown) => {
    live.delete(handle);
    return original.clearInterval(handle);
  };
  g.clearTimeout = (handle: unknown) => {
    live.delete(handle);
    return original.clearTimeout(handle);
  };
  return {
    live: () => [...live.values()],
    restore: () => Object.assign(g, original),
  };
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
      // Клиент держит открытые keep-alive соединения — счётчик их видит.
      // Без него проверка «0 после закрытия» прошла бы и при утечке.
      const during = await metrics();
      assert.ok(during.http.connections >= 2, JSON.stringify(during.http));
      assert.equal(during.http.requests - before.http.requests, polls + 1);
      // Вкладка закрыта: соединения клиента рвутся.
      agent.destroy();
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(timers.live(), [], 'обработка запросов клиента оставила таймеры');
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
