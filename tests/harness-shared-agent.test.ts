// M04/M05 (D3): усечение строк, байтовые пределы транспорта, оба pager и
// построитель каталога — операции установленного harness. Хост: свой каталог
// (имена, описания, readOnly, схемы, protocolVersion 1, пределы), binding и
// revision cursor, источники снимков и прежние тексты/статусы отказов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sharedOperationNames } from 'devcontour-harness';
import { DIAGNOSTIC, SHORT, clip, short } from '../src/application/bounded.ts';
import { AgentService, capabilities } from '../src/application/agent.ts';
import { AgentContext } from '../src/application/context.ts';
import { Observability } from '../src/application/observability.ts';
import { digest } from '../src/core/service.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { fixture, input } from './helpers.ts';

// Снято на HEAD 59e5000 (alpha.10, прежний код) и совпадает с baseline ab35a6a:
//   node --import tsx -e "import('./src/application/agent.ts').then(a=>process.stdout.write(JSON.stringify(a.capabilities())))"
// Каталог называет версию продукта; снимок снят на 0.4.0-alpha.7. Байты
// сравниваются с подставленной версией снимка, версия — с package.json.
// Намеренное изменение: contract_change_revise получил необязательный
// `proposal` (исправленное предложение того же контракта); прочие операции
// байтово прежние.
const CATALOG_DIGEST = '7e26fb1533e26e18796f7c8eff13c3804bfba9d38438757ee48398c2babf0be2';
const SNAPSHOT_VERSION = '0.4.0-alpha.7';
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  version: string;
};
const atSnapshot = (text: string) =>
  text.replace(`"version":"${version}"`, `"version":"${SNAPSHOT_VERSION}"`);
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

test('AC18: каталог DevContour байтово прежний — catalogDigest, HTTP /api/capabilities, CLI; каталоги harness и хоста раздельны', async () => {
  assert.equal(capabilities().version, version);
  assert.equal(digest({ ...capabilities(), version: SNAPSHOT_VERSION }), CATALOG_DIGEST);
  assert.equal(sha(atSnapshot(JSON.stringify(capabilities()))), CATALOG_DIGEST);
  const c = capabilities();
  assert.equal(c.protocolVersion, 1);
  assert.equal(c.maxInputBytes, 100000);
  assert.equal(c.maxResultBytes, 65536);
  assert.equal(c.tools.length, 53);
  for (const name of sharedOperationNames)
    assert.equal(
      c.tools.some((t) => t.name === name),
      false,
      'общая операция harness не в каталоге DevContour: ' + name,
    );
  const f = fixture();
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const body = Buffer.from(await (await fetch(app.url + '/api/capabilities')).arrayBuffer());
    assert.equal(
      sha(atSnapshot(body.toString('utf8'))),
      CATALOG_DIGEST,
      'тело HTTP /api/capabilities байтово прежнее',
    );
  } finally {
    await app.close();
    f.cleanup();
  }
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'capabilities'], {
    cwd: resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, JSON.stringify(capabilities(), null, 2) + '\n');
});

test('AC19: short/clip — 300/2000 code units и «…», вложенный token удалён, вход не меняется, размер объекта не ограничен', () => {
  assert.equal(SHORT, 300);
  assert.equal(DIAGNOSTIC, 2000);
  assert.equal(short('я'.repeat(301)), 'я'.repeat(300) + '…');
  assert.equal(short('x'.repeat(300)), 'x'.repeat(300));
  assert.equal(short(''), '');
  assert.equal(short(undefined), undefined);
  // Code units: суррогатная пара считается за два, как прежде.
  assert.equal(short('😀'.repeat(200), 301), '😀'.repeat(150) + '\ud83d' + '…');
  const value = { a: 'x'.repeat(2001), nested: [{ token: 's', b: 1, c: null }], n: 3 };
  const before = JSON.stringify(value);
  assert.deepEqual(clip(value), {
    a: 'x'.repeat(2000) + '…',
    nested: [{ b: 1, c: null }],
    n: 3,
  });
  assert.equal(JSON.stringify(value), before, 'вход не меняется');
  const big = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => ['k' + i, 'y'.repeat(1000)]),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(clip(big))) > 65536,
    'clip не ограничивает размер объекта',
  );
});

test('AC19: байтовые пределы — запрос 100000 и ответ 65536 байт UTF-8, прежние 413', () => {
  const f = fixture();
  try {
    const api = new AgentService(f.h);
    // Предел — UTF-8 байты: 2-байтовые символы считаются по байтам, не по знакам.
    const request = (chars: number) => ({
      operation: 'project_context',
      input: { pad: 'я'.repeat(chars) },
    });
    const base = Buffer.byteLength(JSON.stringify(request(0)));
    const at = (bytes: number) => request((bytes - base) / 2);
    const status = (raw: unknown) => {
      try {
        api.execute(raw);
        return 200;
      } catch (e) {
        return (e as { status?: number }).status ?? 400;
      }
    };
    const even = base % 2 ? 1 : 0;
    assert.equal(
      status(at(100000 - even)),
      400,
      'в пределе: дальше отказывает строгая схема входа',
    );
    assert.throws(
      () => api.execute(at(100002 - even)),
      (e: Error & { status?: number }) =>
        e.message === 'Запрос превышает 100000 байт' && e.status === 413,
    );
  } finally {
    f.cleanup();
  }
});

test('AC19: context — чужой/устаревший cursor 409, нечитаемый 400, offset 400, сборка по страницам без потерь', () => {
  const f = fixture();
  try {
    const api = new AgentContext(f.h);
    const board = f.h.createBoard('Pages');
    for (let i = 0; i < 30; i++) f.h.addTask(board.id, input('Задача ' + 'ж'.repeat(150) + i));
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const p = api.execute('project_overview', { repositoryId: 'main', limit: 7, cursor }) as {
        items: { key: string }[];
        nextCursor: string | null;
      };
      all.push(...p.items.map((i) => i.key));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    const once = api.execute('project_overview', { repositoryId: 'main', limit: 50 }) as {
      items: { key: string }[];
    };
    assert.deepEqual(
      all,
      once.items.map((i) => i.key),
    );
    const first = api.execute('project_overview', { repositoryId: 'main', limit: 1 }) as {
      nextCursor: string;
    };
    const offsetCursor = (offset: number) => {
      const c = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()) as Record<
        string,
        unknown
      >;
      return Buffer.from(JSON.stringify({ ...c, offset })).toString('base64url');
    };
    const refused = (cursorValue: string, status: number, message: RegExp) =>
      assert.throws(
        () =>
          api.execute('project_overview', { repositoryId: 'main', limit: 1, cursor: cursorValue }),
        (e: Error & { status?: number }) => message.test(e.message) && (e.status ?? 409) === status,
      );
    refused('not-a-cursor', 400, /^Некорректный cursor$/);
    refused(offsetCursor(10_000), 400, /^Некорректный cursor offset$/);
    refused(
      (
        api.execute('task_briefing', { taskId: f.store.read().tasks[0].id, limit: 1 }) as {
          nextCursor: string;
        }
      ).nextCursor,
      409,
      /cursor принадлежит другому запросу/,
    );
  } finally {
    f.cleanup();
  }
});

test('AC19: observability — чужой cursor и offset 409, запись больше страницы 413, полная выдача по страницам', () => {
  const f = fixture();
  try {
    const obs = new Observability(f.h);
    const record = (i: number, size = 10) => ({
      id: 'u' + String(i).padStart(3, '0'),
      startedAt: '2026-01-01T00:00:' + String(i).padStart(2, '0') + '.000Z',
      note: 'z'.repeat(size),
    });
    for (let i = 0; i < 12; i++)
      f.store.atomic(() => f.store.saveLocal('usage', undefined, 'u' + i, record(i, 6000)));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const p = obs.usage({ limit: 50, cursor }) as {
        records: { id: string }[];
        nextCursor: string | null;
      };
      assert.ok(Buffer.byteLength(JSON.stringify(p.records)) <= 48000 + 50);
      ids.push(...p.records.map((r) => r.id));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 12);
    const first = obs.usage({ limit: 1 }) as { nextCursor: string; revision: string };
    assert.throws(
      () => obs.usage({ limit: 1, cursor: 'f'.repeat(64) + ':1' }),
      (e: Error & { status?: number }) =>
        e.message === 'Отчёт изменился; начните чтение заново' && e.status === 409,
    );
    assert.throws(
      () => obs.usage({ limit: 1, cursor: first.revision + ':999' }),
      (e: Error & { status?: number }) => e.message === 'Некорректный cursor' && e.status === 409,
    );
    // Первая запись отчёта не помещается в страницу: отказ, а не потеря.
    f.store.atomic(() =>
      f.store.saveLocal('usage', undefined, 'huge', {
        ...record(0, 50_000),
        id: 'a',
        startedAt: '2025-01-01T00:00:00.000Z',
      }),
    );
    assert.throws(
      () => obs.usage({ limit: 50 }),
      (e: Error & { status?: number }) =>
        e.message === 'Запись превышает размер страницы' && e.status === 413,
    );
  } finally {
    f.cleanup();
  }
});

function spyRun(fixtureFile: string) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--disable-warning=ExperimentalWarning',
      '--import',
      'tsx',
      '--test',
      '--test-reporter=spec',
      fixtureFile,
    ],
    { cwd: resolve('.'), env, encoding: 'utf8', timeout: 240_000 },
  );
}

test('M04/M05 граница: clip, pager, байтовые пределы и каталог — ответ harness; отказ — без fallback', () => {
  const result = spyRun('tests/fixtures/shared-boundary/agent-boundary.spy.ts');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ℹ fail 0$/m);
  const pass = Number(/^ℹ pass (\d+)$/m.exec(result.stdout)?.[1] ?? -1);
  assert.ok(pass >= 5, result.stdout);
});

test('M04/M05 AC02: прежние алгоритмы удалены — ни рекурсивного clip, ни своих pager, байтовых сумм и построителя каталога', () => {
  const code = (p: string) => readFileSync(p, 'utf8');
  assert.doesNotMatch(
    code('src/application/bounded.ts'),
    /Object\.entries|\.slice\(|function clip/,
  );
  for (const p of ['src/application/panel.ts', 'src/harness/store.ts'])
    assert.doesNotMatch(
      code(p),
      /function withoutTokens|\.filter\(\(\[k\]\) => k !== 'token'\)/,
      p,
    );
  for (const p of [
    'src/application/agent.ts',
    'src/application/context.ts',
    'src/application/observability.ts',
    'src/application/preparation-agent.ts',
  ])
    assert.doesNotMatch(code(p), /Buffer\.byteLength/, p);
  assert.doesNotMatch(
    code('src/server/http.ts').slice(0, code('src/server/http.ts').indexOf('JSON.parse(text')),
    /Buffer\.byteLength\(text\)/,
  );
  assert.doesNotMatch(code('src/application/agent.ts'), /toJSONSchema/);
  assert.match(code('src/application/agent.ts'), /operationCatalog\(/);
  for (const p of ['src/application/context.ts', 'src/application/observability.ts']) {
    assert.match(code(p), /pageItems\(/, p);
    assert.doesNotMatch(code(p), /base64url'\)\.toString\(\)|match\(\/\^\(\[a-f0-9\]\{64\}\)/, p);
  }
});
