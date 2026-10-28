// Наблюдение границы агентского слоя (запускается из
// tests/harness-shared-agent.test.ts с --experimental-test-module-mocks).
// Шпионы оборачивают настоящие clipText/clipDeep, pageItems, checkJsonBytes,
// utf8Bytes и operationCatalog: подменённый ответ определяет результат хоста,
// отказ общей операции не уходит в собственный алгоритм.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as real from 'devcontour-harness';

type Mode = {
  page?: unknown;
  pageError?: Error;
  bytes?: { bytes: number; within: boolean };
  utf8?: number;
  catalog?: unknown;
  catalogError?: Error;
  clip?: unknown;
};
let mode: Mode = {};
const calls = {
  clipDeep: [] as unknown[][],
  clipText: [] as unknown[][],
  page: [] as unknown[][],
  bytes: [] as unknown[][],
  utf8: [] as string[],
  catalog: [] as unknown[],
};
const reset = (next: Mode = {}) => {
  mode = next;
  for (const list of Object.values(calls)) list.length = 0;
};

mock.module('devcontour-harness', {
  namedExports: {
    ...real,
    clipDeep: (...args: Parameters<typeof real.clipDeep>) => {
      calls.clipDeep.push(args);
      return mode.clip ?? real.clipDeep(...args);
    },
    clipText: (...args: Parameters<typeof real.clipText>) => {
      calls.clipText.push(args);
      return real.clipText(...args);
    },
    pageItems: (...args: Parameters<typeof real.pageItems>) => {
      calls.page.push(args);
      if (mode.pageError) throw mode.pageError;
      return mode.page ?? real.pageItems(...args);
    },
    checkJsonBytes: (...args: Parameters<typeof real.checkJsonBytes>) => {
      calls.bytes.push(args);
      return mode.bytes ?? real.checkJsonBytes(...args);
    },
    utf8Bytes: (text: string) => {
      calls.utf8.push(text);
      return mode.utf8 ?? real.utf8Bytes(text);
    },
    operationCatalog: (input: Parameters<typeof real.operationCatalog>[0]) => {
      calls.catalog.push(input);
      if (mode.catalogError) throw mode.catalogError;
      return mode.catalog ?? real.operationCatalog(input);
    },
  },
});
const { clip, short } = await import('../../../src/application/bounded.ts');
const { AgentService, capabilities } = await import('../../../src/application/agent.ts');
const { AgentContext } = await import('../../../src/application/context.ts');
const { Observability } = await import('../../../src/application/observability.ts');
const { fixture, input } = await import('../../helpers.ts');

void test('clip и short — ответ clipDeep/clipText с пределами хоста', () => {
  reset({ clip: { spy: true } });
  assert.deepEqual(clip({ a: 'x' }), { spy: true });
  assert.deepEqual(calls.clipDeep[0], [{ a: 'x' }, 2000]);
  reset();
  short('abc');
  assert.deepEqual(calls.clipText[0], ['abc']);
});

void test('capabilities — ответ operationCatalog на каталоге хоста; отказ — тот же объект', () => {
  reset({ catalog: { spy: 'catalog' } });
  assert.deepEqual(capabilities(), { spy: 'catalog' });
  const [arg] = calls.catalog as Parameters<typeof real.operationCatalog>[0][];
  assert.equal(arg.protocolVersion, 1);
  assert.equal(arg.maxInputBytes, 100000);
  assert.equal(arg.maxResultBytes, 65536);
  assert.equal(Object.keys(arg.operations).length, 54);
  assert.equal(Object.keys(arg.operations)[0], 'preparation_status');
  const catalogError = new Error('spy: каталог');
  reset({ catalogError });
  assert.throws(
    () => capabilities(),
    (e) => e === catalogError,
  );
});

void test('context pager — ответ pageItems с binding и revision запроса; отказы — прежние тексты и статусы', () => {
  const f = fixture();
  try {
    const api = new AgentContext(f.h);
    f.h.addTask(f.h.createBoard('Board').id, input());
    reset({ page: { spy: 'page' } });
    assert.deepEqual(api.execute('project_overview', { repositoryId: 'main', limit: 3 }), {
      spy: 'page',
    });
    const [items, header, options] = calls.page[0] as [
      unknown[],
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    assert.ok(items.length > 0);
    assert.deepEqual(header, { scope: 'main', paused: true });
    assert.equal(options.binding, 'overview/main');
    assert.equal(options.limit, 3);
    assert.match(String(options.revision), /^[a-f0-9]{64}$/);
    const mapped = (code: string, path: (string | number)[], message: string, status: number) => {
      reset({ pageError: new real.HarnessError(code as never, 'spy', [{ path, message: 'spy' }]) });
      assert.throws(
        () => api.execute('project_overview', { repositoryId: 'main', limit: 3 }),
        (e: Error & { status?: number }) => e.message === message && (e.status ?? 409) === status,
        code,
      );
    };
    mapped('INVALID_INPUT', ['cursor'], 'Некорректный cursor', 400);
    mapped('INVALID_INPUT', ['cursor', 'offset'], 'Некорректный cursor offset', 400);
    mapped(
      'REVISION_CONFLICT',
      ['cursor'],
      'Контекст изменился или cursor принадлежит другому запросу. Начните с первой страницы.',
      409,
    );
    mapped('RESPONSE_TOO_LARGE', ['items', 0], 'Элемент контекста превышает лимит ответа', 413);
    const other = new Error('spy: другое');
    reset({ pageError: other });
    assert.throws(
      () => api.execute('project_overview', { repositoryId: 'main', limit: 3 }),
      (e) => e === other,
    );
  } finally {
    f.cleanup();
  }
});

void test('observability pager — digest-offset, бюджет записей 48000; отказы 409/413', () => {
  const f = fixture();
  try {
    const obs = new Observability(f.h);
    reset({ page: { revision: 'r', items: ['SPY'], total: 1, hasMore: false, nextCursor: null } });
    assert.deepEqual(obs.usage({ limit: 5 }), {
      revision: 'r',
      records: ['SPY'],
      nextCursor: null,
    });
    const options = calls.page[0][2] as Record<string, unknown>;
    assert.equal(options.cursorFormat, 'digest-offset');
    assert.equal(options.measure, 'items');
    assert.equal(options.maxBytes, 48000);
    assert.equal(options.reserveBytes, 0);
    reset({
      pageError: new real.HarnessError('INVALID_INPUT', 'spy', [
        { path: ['cursor', 'offset'], message: 'spy' },
      ]),
    });
    assert.throws(
      () => obs.usage({ limit: 5 }),
      (e: Error & { status?: number }) =>
        e.message === 'Некорректный cursor' && (e.status ?? 409) === 409,
    );
    reset({
      pageError: new real.HarnessError('RESPONSE_TOO_LARGE', 'spy', [
        { path: ['items', 0], message: 'spy' },
      ]),
    });
    assert.throws(
      () => obs.usage({ limit: 5 }),
      (e: Error & { status?: number }) =>
        e.message === 'Запись превышает размер страницы' && e.status === 413,
    );
  } finally {
    f.cleanup();
  }
});

void test('байтовые пределы agent API — ответ checkJsonBytes решает отказ 413', () => {
  const f = fixture();
  try {
    const api = new AgentService(f.h);
    reset({ bytes: { bytes: 1, within: false } });
    assert.throws(
      () => api.execute({ operation: 'project_context' }),
      (e: Error & { status?: number }) =>
        e.message === 'Запрос превышает 100000 байт' && e.status === 413,
    );
    assert.deepEqual(calls.bytes[0], [{ operation: 'project_context' }, 100000]);
    reset();
    api.execute({ operation: 'project_context' });
    assert.deepEqual(
      calls.bytes.map((c) => c[1]),
      [100000, 65536, 65536],
      'запрос, ответ контекста, ответ агентского API',
    );
  } finally {
    f.cleanup();
  }
});
