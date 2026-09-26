// Стенд пределов хранения (A13): как растут размер состояния, время записи,
// ответы панели и время восстановления на корпусе 100/1 000/10 000 задач с
// историей попыток и evidence.
//
// Корпус строится так: одна доска проходит настоящие доменные переходы
// (провал, повтор, приёмка с evidence), затем её состояние тиражируется с
// новыми идентификаторами. Собирать 10 000 задач доменными вызовами нельзя —
// каждая запись переписывает всё состояние, и сама сборка стала бы тем
// квадратичным процессом, который стенд измеряет.
//
// Запуск: node --import tsx scripts/storage-bench.ts [--sizes 100,1000] [--out file.json]
// Результаты зависят от хоста и его загрузки: они записываются вместе с ними.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem, platform, release } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { configSchema, type DevContourState } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { serve } from '../src/server/http.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { authorOverview } from '../src/application/overview.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sizes = (option('--sizes') ?? '100,1000,10000').split(',').map(Number);
const out = option('--out');

const config = () =>
  configSchema.parse({
    version: 1,
    name: 'Storage bench',
    repository: '/tmp',
    mode: 'demo',
    concurrency: 2,
    roles: { backend: { runtime: 'demo' }, qa: { runtime: 'demo' } },
    reviewer: { runtime: 'demo' },
    gates: [
      {
        id: 'test',
        kind: 'test',
        command: ['node', 'verify.mjs'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
  });

const BOARD = 10;

/** Одна доска из BOARD задач: цепочка зависимостей, у каждой — провал и приёмка. */
function template(h: DevContour) {
  const board = h.createBoard('Доска корпуса');
  let previous: string | undefined;
  for (let i = 0; i < BOARD; i++) {
    const t = h.addTask(board.id, {
      title: `Задача ${i}: наблюдаемый результат с критериями`,
      description:
        'Пользователь выполняет сценарий и видит ожидаемый результат; ошибки объяснены. '.repeat(3),
      role: 'qa',
      dependsOn: previous ? [previous] : [],
      acceptance: [
        'Сценарий проходит на чистой базе',
        'Ошибка ввода объяснена пользователю',
        'Проверка называет свой testcase',
      ],
    });
    previous = t.id;
  }
  h.approve(board.id);
  h.pause(false);
  for (let i = 0; i < BOARD; i++) {
    for (const outcome of ['failed', 'passed'] as const) {
      const run = h.claim('bench')!;
      h.phase(run.id, run.token, 'integrating', {
        baseSha: 'a'.repeat(40),
        candidateSha: 'b'.repeat(40),
        integrationSha: 'c'.repeat(40),
      });
      h.store.change('bench.timings', (s) => {
        const r = s.runs.find((x) => x.id === run.id)!;
        const at = new Date().toISOString();
        r.timings = [
          'implementation',
          'candidate-test:install',
          'candidate-test:unit',
          'candidate-review',
          'integration-wait',
          'integration-test:unit',
          'integration-review',
        ].map((stage) => ({
          id: randomUUID(),
          stage,
          startedAt: at,
          finishedAt: at,
          outcome: 'passed',
        }));
        r.context = [1, 2].map((n) => ({
          id: `pack-${n}`,
          version: '1',
          repositoryId: 'main',
          revision: 'd'.repeat(40),
          digest: 'e'.repeat(64),
        }));
      });
      for (const phase of ['candidate', 'integration'] as const)
        for (const kind of ['test', 'review'] as const)
          h.evidence(run.id, run.token, {
            kind,
            phase,
            sha: phase === 'candidate' ? 'b'.repeat(40) : 'c'.repeat(40),
            gate: kind === 'test' ? 'test' : 'independent-review',
            passed: true,
            command: ['node', 'verify.mjs'],
            exitCode: 0,
            log: `/data/artifacts/${run.id}/${phase}/${kind}.log`,
            digest: 'f'.repeat(64),
            summary: 'Проверка прошла: 42 testcases, 0 failed, 1 skipped',
            tests:
              kind === 'test'
                ? Array.from({ length: 12 }, (_, n) => ({
                    id: `suite > сценарий ${n}`,
                    status: 'passed' as const,
                  }))
                : undefined,
          });
      if (outcome === 'failed') {
        h.fail(
          run.id,
          run.token,
          'Независимое ревью отклонило результат: критерий 2 не проверен',
          false,
          'review',
        );
        h.retry(run.taskId);
        h.pause(false);
      } else h.finish(run.id, run.token, 'c'.repeat(40));
    }
  }
  return h.store.read();
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Копии шаблона с новыми идентификаторами: связи внутри копии сохраняются. */
function replicate(base: DevContourState, copies: number): DevContourState {
  const boards = JSON.stringify(base.boards);
  const tasks = JSON.stringify(base.tasks);
  const runs = JSON.stringify(base.runs);
  const state: DevContourState = { ...base, boards: [], tasks: [], runs: [] };
  for (let c = 0; c < copies; c++) {
    const ids = new Map<string, string>();
    const remap = (text: string) =>
      text.replace(UUID, (id) => {
        if (!ids.has(id)) ids.set(id, randomUUID());
        return ids.get(id)!;
      });
    state.boards.push(...JSON.parse(remap(boards)));
    state.tasks.push(...JSON.parse(remap(tasks)));
    state.runs.push(...JSON.parse(remap(runs)));
  }
  return state;
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: samples.length,
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    max: +sorted.at(-1)!.toFixed(2),
  };
}
const time = <T>(action: () => T) => {
  const start = performance.now();
  const value = action();
  return { ms: performance.now() - start, value };
};
const timeAsync = async <T>(action: () => Promise<T>) => {
  const start = performance.now();
  const value = await action();
  return { ms: performance.now() - start, value };
};

async function measure(size: number, base: DevContourState, eventsPerTask: number) {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-storage-bench-'));
  try {
    const path = join(root, 'state.sqlite');
    let store = new Store(path);
    let h = new DevContour(store, config());
    const corpus = replicate(base, Math.ceil(size / BOARD));
    // Одна активная попытка: её heartbeat — самая частая запись в работе.
    const active = corpus.runs.at(-1)!;
    const build = time(() =>
      store.change('bench.corpus', (s) => {
        Object.assign(s, corpus);
        const t = s.tasks.find((x) => x.id === active.taskId)!;
        active.status = 'active';
        active.leaseUntil = Date.now() + 3_600_000;
        active.finishedAt = undefined;
        t.status = 'running';
        t.activeRunId = active.id;
        return {};
      }),
    );
    // История событий: реальная работа пишет десятки событий на задачу.
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    const insert = db.prepare('INSERT INTO main.events(at,type,data) VALUES(?,?,?)');
    const payload = JSON.stringify({
      runId: randomUUID(),
      phase: 'verifying',
      detail: 'x'.repeat(200),
    });
    db.exec('BEGIN');
    for (let i = 0; i < size * eventsPerTask; i++)
      insert.run(new Date().toISOString(), 'run.phase', payload);
    db.exec('COMMIT');

    const stateBytes = Buffer.byteLength(JSON.stringify(store.read()));
    const reads = Array.from({ length: 15 }, () => time(() => store.read()).ms);
    const heartbeats = Array.from(
      { length: 15 },
      () => time(() => h.heartbeat(active.id, active.token)).ms,
    );
    const writes = Array.from(
      { length: 15 },
      (_, i) =>
        time(() =>
          store.change('bench.write', (s) => {
            s.tasks[0].description = `Изменение ${i}: ` + s.tasks[0].description.slice(0, 200);
            return { i };
          }),
        ).ms,
    );
    const metrics = time(() => workflowMetrics(h));
    const overview = time(() => authorOverview(h));

    const scheduler = new Scheduler(h, root);
    const app = await serve(h, scheduler, { port: 0 });
    const api: Record<string, { ms: ReturnType<typeof stats>; bytes: number }> = {};
    for (const path of ['/api/state', '/api/overview']) {
      const samples: number[] = [];
      let bytes = 0;
      for (let i = 0; i < 5; i++) {
        const r = await timeAsync(async () => (await fetch(app.url + path)).arrayBuffer());
        samples.push(r.ms);
        bytes = r.value.byteLength;
      }
      api[path] = { ms: stats(samples), bytes };
    }
    // Задержка event loop, пока идут heartbeat и опрос панели, как в работе:
    // синхронная запись SQLite держит процесс, и таймеры ждут её.
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const until = Date.now() + 5000;
    const polling = (async () => {
      while (Date.now() < until) await (await fetch(app.url + '/api/state')).arrayBuffer();
    })();
    const beating = (async () => {
      while (Date.now() < until) {
        h.heartbeat(active.id, active.token);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    await Promise.all([polling, beating]);
    lag.disable();
    await app.close();
    await scheduler.stop();
    store.close();

    const dbBytes = ['', '-wal', '-shm']
      .map((suffix) => {
        try {
          return statSync(path + suffix).size;
        } catch {
          return 0;
        }
      })
      .reduce((a, b) => a + b, 0);
    // Восстановление после перезапуска: открыть базу, прочитать состояние,
    // снять истёкшее владение.
    const recovery = time(() => {
      store = new Store(path);
      h = new DevContour(store, config());
      h.store.read();
      return h.expire(Date.now() + 7_200_000);
    });
    store.close();
    return {
      tasks: corpus.tasks.length,
      runs: corpus.runs.length,
      evidence: corpus.runs.reduce((n, r) => n + r.evidence.length, 0),
      events: size * eventsPerTask + 1,
      corpusBuildMs: +build.ms.toFixed(1),
      stateBytes,
      dbBytes,
      storeReadMs: stats(reads),
      heartbeatMs: stats(heartbeats),
      writeWithEventMs: stats(writes),
      metricsMs: +metrics.ms.toFixed(1),
      overviewMs: +overview.ms.toFixed(1),
      api,
      eventLoopLagMs: {
        p50: +(lag.percentile(50) / 1e6).toFixed(1),
        p95: +(lag.percentile(95) / 1e6).toFixed(1),
        max: +(lag.max / 1e6).toFixed(1),
      },
      recoveryMs: +recovery.ms.toFixed(1),
      expiredOnRecovery: recovery.value.length,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const templateRoot = mkdtempSync(join(tmpdir(), 'devcontour-storage-template-'));
const templateStore = new Store(join(templateRoot, 'state.sqlite'));
const base = template(new DevContour(templateStore, config()));
templateStore.close();
rmSync(templateRoot, { recursive: true, force: true });

const host = {
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  memoryGb: +(totalmem() / 2 ** 30).toFixed(1),
  node: process.version,
  loadAverageAtStart: loadavg().map((x) => +x.toFixed(1)),
};
const leaseMs = config().leaseMs;
const results = [];
for (const size of sizes) {
  const result = await measure(size, base, 30);
  results.push(result);
  console.error(
    `${size}: state ${(result.stateBytes / 1e6).toFixed(1)} MB, heartbeat p95 ${result.heartbeatMs.p95} ms, /api/state p95 ${result.api['/api/state'].ms.p95} ms, lag max ${result.eventLoopLagMs.max} ms`,
  );
}
const report = {
  observedAt: new Date().toISOString(),
  host: { ...host, loadAverageAtEnd: loadavg().map((x) => +x.toFixed(1)) },
  corpus: {
    board: BOARD,
    runsPerTask: 2,
    evidencePerRun: 4,
    eventsPerTask: 30,
    note: 'Одна доска проходит доменные переходы и тиражируется с новыми идентификаторами',
  },
  leaseMs,
  heartbeatEveryMs: Math.max(1000, leaseMs / 3),
  results,
};
const text = JSON.stringify(report, null, 2);
if (out) writeFileSync(out, text + '\n');
else console.log(text);
