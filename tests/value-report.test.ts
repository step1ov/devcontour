// Отчёт об эффекте DevContour: CLI `report` только читает базу, агентская
// операция `value_report` и HTTP `/api/report` отдают отчёт harness без
// изменений и приложение вмешательств из журнала контура.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { valueReportSchema, type ValueReport } from 'devcontour-harness/contracts';
import { complete, config, input } from './helpers.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { configSchema, repositorySchema } from '../src/core/model.ts';
import {
  devcontourValueReport,
  type DevContourValueReport,
} from '../src/application/value-report.ts';
import { readOnlyValueReport } from '../src/runner/value-report.ts';
import { command, git } from '../src/runner/process.ts';
import { parseUsage } from '../src/runner/usage.ts';
import { measuredAgentCall } from '../src/harness/measured.ts';
import type { AgentRequest } from '../src/runner/adapters.ts';
import { AgentService, capabilities } from '../src/application/agent.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

const TITLE = 'Zebra private title';
const RESET_REASON = 'Okapi reset reason after diagnosis';
const SHA = (c: string) => c.repeat(40);

/** Вызов с известной ценой (`usd`) или без неё (`null`): тот же путь учёта, что у runtime. */
async function call(h: DevContour, runId: string, usd: number | null, repositoryId = 'main') {
  const usage = parseUsage(
    'claude',
    JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      ...(usd === null ? {} : { total_cost_usd: usd }),
    }),
    true,
  );
  await measuredAgentCall(
    h,
    {
      name: 'claude',
      version: 'fixture',
      execute: (r) => {
        r.onUsage!(usage);
        return Promise.resolve({ data: {}, log: '', command: [] });
      },
    },
    {
      prompt: 'fixture prompt',
      model: 'fixture',
      signal: new AbortController().signal,
    } as AgentRequest,
    { repositoryId, runId, stage: 'implementation' },
  );
}

/**
 * Каталог данных с конфигурацией и закрытой базой: пять задач цепочкой —
 * с первой попытки (A, E), возврат проверкой (B), отказ окружения (C), два
 * отказа ревью и сброс бюджета (D). Повторы явные (`retry`), как у ведущего
 * агента; пауза оператора и ручной перенос базы.
 */
async function workspaceFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-report-')));
  const repo = join(root, 'repo'),
    data = join(root, 'data');
  await mkdir(repo);
  await mkdir(data);
  await git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'Report fixture');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'fixture');
  const c = config({ repository: repo, maxAttempts: 2 });
  await writeFile(join(data, 'config.json'), JSON.stringify(c));
  const h = new DevContour(new Store(join(data, 'state.sqlite')), c);
  try {
    const b = h.createBoard('Report board', '', 'main');
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C', 'D', 'E'])
      ids.push(
        h.addTask(b.id, {
          ...input(name === 'A' ? TITLE : `Task ${name}`, ids.slice(-1)),
        }).id,
      );
    h.approve(b.id);
    const [a, bTask, cTask, d, e] = ids as [string, string, string, string, string];
    await call(h, complete(h, a).id, 0.5);
    const claim = () => h.claim(h.store.read().leader?.owner ?? 'test')!;
    const status = (id: string) => h.store.read().tasks.find((t) => t.id === id)!.status;
    h.pause(false);
    const gate = claim();
    h.fail(gate.id, gate.token, 'gate failed', false, 'gate');
    assert.equal(status(bTask), 'failed');
    h.retry(bTask);
    await call(h, complete(h, bTask).id, 1.5);
    h.pause(false);
    const env = claim();
    h.fail(env.id, env.token, 'sandbox unavailable', true, 'environment');
    assert.equal(status(cTask), 'failed');
    h.retry(cTask);
    complete(h, cTask);
    h.pause(false);
    const review = claim();
    h.fail(review.id, review.token, 'review rejected', false, 'review');
    h.retry(d);
    h.pause(false);
    const again = claim();
    h.fail(again.id, again.token, 'review rejected', false, 'review');
    h.retry(d, { reason: RESET_REASON });
    complete(h, d);
    await call(h, complete(h, e).id, null);
    h.pause(true);
    h.baseUpdated([{ repositoryId: 'main', from: SHA('1'), to: SHA('2') }]);
    h.pause(false);
    h.pause(true);
    return { root, data, ids };
  } finally {
    h.store.close();
  }
}

/** Отпечаток каталога: имя, размер и содержимое каждого файла (рекурсивно). */
async function digestDir(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (d: string) => {
    for (const entry of (await readdir(d, { withFileTypes: true })).sort((x, y) =>
      x.name < y.name ? -1 : 1,
    )) {
      const p = join(d, entry.name);
      hash.update(p + '\0');
      if (entry.isDirectory()) await walk(p);
      else hash.update(await readFile(p));
    }
  };
  await walk(dir);
  return hash.digest('hex');
}

/**
 * Каталог данных без права записи на время `fn`: writer (PRAGMA режима
 * журнала, DDL, файлы `-wal`/`-shm`) открыть базу не сможет, а чтение
 * только для чтения — сможет. Совпадение байтов одно этого не ловит: writer
 * без изменений оставляет базу байтово прежней.
 */
async function withoutWrite<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const files = (await readdir(dir)).map((n) => join(dir, n));
  for (const f of files) await chmod(f, 0o444);
  await chmod(dir, 0o555);
  try {
    return await fn();
  } finally {
    await chmod(dir, 0o755);
    for (const f of files) await chmod(f, 0o644);
  }
}

type AgentReport = DevContourValueReport & { detail: string; omitted: string[] };
/** Ответ CLI или HTTP: отчёт harness проверяется его схемой. */
function parsed(text: string) {
  const value = JSON.parse(text) as DevContourValueReport;
  return { report: valueReportSchema.parse(value.report), host: value.host };
}
function headline(report: ValueReport, id: string) {
  if (report.summary.status !== 'ok') throw new Error('Нет сводки: ' + report.summary.status);
  const found = report.summary.headlines.find((x) => x.id === id);
  if (!found) throw new Error('Нет заголовка ' + id);
  return found;
}
const configOf = async (data: string) =>
  configSchema.parse(JSON.parse(await readFile(join(data, 'config.json'), 'utf8')));

const cli = (...args: string[]) =>
  command(['node', '--import', 'tsx', 'src/cli.ts', 'report', ...args], process.cwd());

/** Удаление только созданного здесь временного каталога. */
async function removeFixture(root: string) {
  assert.ok(root.startsWith(await realpath(tmpdir())) && root.includes('dc-report-'));
  await rm(root, { recursive: true, force: true });
}

test('CLI report: ключевые числа, приложение журнала, детерминизм и база без изменений', async () => {
  const { root, data, ids } = await workspaceFixture();
  try {
    const before = await digestDir(data);
    const json = await withoutWrite(data, () => cli('--data', data));
    assert.equal(json.code, 0, json.stderr);
    const { report, host } = parsed(json.stdout);
    assert.equal(report.enoughData, true);
    assert.equal(headline(report, 'accepted').value, '5');
    assert.equal(headline(report, 'environment').value, '1 of 4');
    assert.equal(report.speed.firstPass.value, 3, 'A, C (отказ окружения не считается) и E');
    assert.equal(report.speed.firstPass.n, 5);
    assert.deepEqual(
      { value: report.defects.sentBack.value, n: report.defects.sentBack.n },
      { value: 2, n: 5 },
    );
    assert.deepEqual(report.defects.byKind, { gate: 1, review: 2, 'scope-violation': 0 });
    assert.equal(
      headline(report, 'spend').value,
      '≥ $0.40',
      'известные $2.00 на 5 принятых, нижняя граница',
    );
    assert.equal(headline(report, 'spend').measure.bound, 'lower');
    // Малые выборки: «k of n» без процентов, медиана — от 5 значений.
    assert.equal(headline(report, 'sent-back').value, '2 of 5');
    assert.ok(!/\d+%/.test(JSON.stringify(report.summary)), 'нет процентов при знаменателе < 20');
    assert.equal(report.autonomy.actions.retries, null, 'вход harness повторов не знает');
    assert.equal(host.source, 'devcontour-journal');
    assert.equal(host.retries, 4, 'B, C и дважды D');
    assert.equal(host.resets, 1);
    assert.deepEqual(host.acceptedWithoutRetry, { value: 2, n: 5 });
    assert.deepEqual(host.acceptedWithoutResetOrDecision, { value: 4, n: 5 });
    assert.equal(host.baseUpdates, 1);
    assert.equal(host.operatorPauses, 2);
    assert.equal(host.automaticBaseUpdates, 0);
    assert.equal(host.cancellations, 0);
    assert.equal(host.reopened, 0);
    assert.equal(host.corrections, 0);
    // Заголовок задачи — по умолчанию, причина сброса — никогда.
    assert.ok(json.stdout.includes(TITLE));
    assert.ok(!json.stdout.includes(RESET_REASON));
    assert.ok(!json.stdout.includes('/Users/') && !json.stdout.includes(root));

    const md = await cli('--data', data, '--format', 'md');
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, /^# Harness report: data\n/);
    assert.match(md.stdout, /\*\*2 of 5\*\*/);
    assert.match(md.stdout, /## Приложение DevContour: вмешательства по журналу контура/);
    assert.match(
      md.stdout,
      /Явные повторы задач \(оператор, ведущий агент или восстановление цикла ведущего\): 4, из них со сбросом бюджета попыток: 1/,
    );
    assert.match(md.stdout, /Принято без явного повтора: 2 из 5\n/);
    const again = await cli('--data', data, '--format', 'md');
    assert.equal(again.stdout, md.stdout, 'те же данные — те же байты');

    const html = await cli('--data', data, '--format', 'html');
    assert.equal(html.code, 0, html.stderr);
    assert.ok(html.stdout.startsWith('<!doctype html>'));
    assert.ok(!/<script|https?:\/\//.test(html.stdout));
    assert.ok(html.stdout.indexOf('Приложение DevContour') < html.stdout.indexOf('</main>'));

    const hidden = await cli('--data', data, '--format', 'md', '--no-titles');
    assert.equal(hidden.code, 0, hidden.stderr);
    assert.ok(!hidden.stdout.includes(TITLE));
    assert.ok(hidden.stdout.includes(ids[0]), 'вместо заголовка — ID');

    const window = await cli('--data', data, '--since', '2000-01-01', '--until', '2000-02-01');
    assert.equal(window.code, 0, window.stderr);
    assert.equal(parsed(window.stdout).report.summary.status, 'not-enough-data');
    assert.equal(parsed(window.stdout).host.retries, 0);
    const bad = await cli('--data', data, '--since', 'yesterday');
    assert.notEqual(bad.code, 0);
    const format = await cli('--data', data, '--format', 'pdf');
    assert.notEqual(format.code, 0);
    assert.match(format.stderr, /json, md или html/);
    const component = await cli('--data', data, '--repository-id', 'main');
    assert.equal(component.code, 0, component.stderr);
    assert.equal(headline(parsed(component.stdout).report, 'accepted').value, '5');
    const missing = await cli('--data', data, '--repository-id', 'nope');
    assert.notEqual(missing.code, 0);

    assert.equal(await digestDir(data), before, 'каталог данных не изменился, новых файлов нет');
  } finally {
    await removeFixture(root);
  }
});

test('CLI report --out: временный файл и rename, права 0600 или прежние, ссылки — отказ', async () => {
  const { root, data } = await workspaceFixture();
  try {
    const before = await digestDir(data);
    const out = join(root, 'report.html');
    const written = await cli('--data', data, '--format', 'html', '--out', out);
    assert.equal(written.code, 0, written.stderr);
    assert.equal((JSON.parse(written.stdout) as { out: string }).out, out);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    assert.ok((await readFile(out, 'utf8')).startsWith('<!doctype html>'));
    await chmod(out, 0o640);
    assert.equal((await cli('--data', data, '--format', 'md', '--out', out)).code, 0);
    assert.equal((await stat(out)).mode & 0o777, 0o640, 'права прежнего файла сохранены');
    assert.match(await readFile(out, 'utf8'), /^# Harness report/);

    const target = join(root, 'target.txt');
    await writeFile(target, 'keep');
    await symlink(target, join(root, 'link.md'));
    const viaLink = await cli('--data', data, '--format', 'md', '--out', join(root, 'link.md'));
    assert.notEqual(viaLink.code, 0);
    assert.match(viaLink.stderr, /символическая ссылка/);
    await link(target, join(root, 'hard.md'));
    const viaHard = await cli('--data', data, '--format', 'md', '--out', join(root, 'hard.md'));
    assert.notEqual(viaHard.code, 0);
    assert.match(viaHard.stderr, /жёстких ссылок/);
    assert.equal(await readFile(target, 'utf8'), 'keep');
    const inside = await cli('--data', data, '--out', join(data, 'report.json'));
    assert.notEqual(inside.code, 0);
    assert.match(inside.stderr, /внутри каталога данных/);
    // Каталог данных компонента (.devcontour-local его репозитория) — тоже отказ.
    await mkdir(join(root, 'repo', '.devcontour-local'));
    const component = await cli(
      '--data',
      data,
      '--out',
      join(root, 'repo', '.devcontour-local', 'r.md'),
    );
    assert.notEqual(component.code, 0);
    assert.match(component.stderr, /внутри каталога данных/);
    const noDir = await cli('--data', data, '--out', join(root, 'absent', 'r.md'));
    assert.notEqual(noDir.code, 0);
    assert.deepEqual(
      (await readdir(root)).filter((n) => n.endsWith('.tmp')),
      [],
      'временных файлов не осталось',
    );
    assert.equal(await digestDir(data), before);
  } finally {
    await removeFixture(root);
  }
});

test('value_report: в каталоге только чтения со схемой; JSON по схеме harness и в пределе ответа', async () => {
  const { root, data } = await workspaceFixture();
  const c = await configOf(data);
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(store, c);
  try {
    const tool = capabilities().tools.find((t) => t.name === 'value_report')!;
    assert.equal(tool.readOnly, true);
    const schema = tool.inputSchema as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'asOf',
      'detail',
      'noTitles',
      'repositoryId',
      'since',
      'until',
    ]);
    const agent = new AgentService(h, data);
    const eventsBefore = store.lastEventId();
    const summary = agent.execute({
      operation: 'value_report',
      input: {},
    }) as unknown as AgentReport;
    valueReportSchema.parse(summary.report);
    assert.equal(summary.detail, 'summary');
    assert.deepEqual(summary.report.works.rows, []);
    assert.equal(summary.report.works.truncated, true);
    assert.deepEqual(summary.report.defects.items, []);
    assert.equal(summary.report.defects.itemsTruncated, true);
    assert.equal(summary.host.resets, 1);
    const limits = summary.report.limitations.map((l) => l.id);
    assert.ok(limits.includes('summary-omitted'));
    assert.ok(!limits.includes('works-truncated') && !limits.includes('items-truncated'));
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 65536);
    const full = agent.execute({
      operation: 'value_report',
      input: { detail: 'full' },
    }) as unknown as AgentReport;
    valueReportSchema.parse(full.report);
    assert.equal(full.detail, 'full');
    assert.equal(full.report.works.rows.length, 5);
    assert.ok(full.report.defects.items.length > 0);
    const hidden = agent.execute({
      operation: 'value_report',
      input: { noTitles: true, detail: 'full' },
    });
    assert.ok(!JSON.stringify(hidden).includes(TITLE));
    assert.throws(
      () => agent.execute({ operation: 'value_report', input: { format: 'md' } }),
      /format/,
    );
    assert.throws(
      () => agent.execute({ operation: 'value_report', input: { since: 'yesterday' } }),
      (e: Error & { status?: number }) => e.status === 400,
    );
    assert.equal(store.lastEventId(), eventsBefore, 'операция ничего не пишет в журнал');
    // Рядом открыт writer (файлы журнала SQLite есть): CLI читает с журналом
    // и вторым writer не становится.
    assert.ok((await readdir(data)).includes('state.sqlite-wal'));
    const beside = await cli('--data', data, '--format', 'md');
    assert.equal(beside.code, 0, beside.stderr);
    assert.match(beside.stdout, /\*\*2 of 5\*\*/);
    assert.equal(store.lastEventId(), eventsBefore);
  } finally {
    store.close();
    await removeFixture(root);
  }
});

test('HTTP /api/report: только из панели или локального клиента, память по ревизии данных, HTML/JSON/Markdown', async () => {
  const { root, data } = await workspaceFixture();
  const c = await configOf(data);
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(store, c);
  const app = await serve(h, new Scheduler(h, data), { port: 0 });
  const panel = { 'sec-fetch-site': 'same-origin' };
  const get = (query: string, headers: Record<string, string> = panel) =>
    fetch(app.url + '/api/report' + query, { headers });
  try {
    // Память: тот же запрос при тех же данных журнал заново не читает.
    let reads = 0;
    const eventsAfter = store.eventsAfter.bind(store);
    store.eventsAfter = (after, limit) => {
      reads++;
      return eventsAfter(after, limit);
    };
    // Чужой сайт (и клиент без признаков) отчёт не получает.
    assert.equal((await get('?format=html', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await get('?format=html', { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await get('?format=html', {})).status, 403);
    assert.equal(reads, 0, 'отказ — до расчёта');
    assert.equal((await get('?format=json', { 'sec-fetch-site': 'none' })).status, 200);
    assert.equal((await get('?format=json', { 'x-devcontour-request': '1' })).status, 200);

    const first = reads;
    assert.ok(first > 0, 'первый запрос читает журнал');
    const html = await get('?format=html');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type')!, /^text\/html/);
    assert.match(html.headers.get('content-security-policy')!, /default-src 'none'/);
    const page = await html.text();
    assert.ok(page.includes('Приложение DevContour'));
    assert.ok(page.includes(TITLE));
    assert.ok(!/<script/.test(page));
    assert.equal(await (await get('?format=html')).text(), page);
    assert.equal((await get('?format=md')).status, 200);
    assert.equal(reads, first, 'та же ревизия и те же параметры — без нового чтения журнала');
    h.pause(false);
    h.pause(true);
    const after = parsed(await (await get('?format=json')).text());
    assert.ok(reads > first, 'новые данные — новый расчёт');
    assert.equal(after.host.operatorPauses, 3);

    const hidden = await (await get('?format=md&noTitles=1')).text();
    assert.ok(hidden.startsWith('# Harness report'));
    assert.ok(!hidden.includes(TITLE));
    assert.equal((await get('?format=md&noTitles=true')).status, 400);
    assert.equal((await get('?format=md&noTitles=0')).status, 400);
    assert.equal((await get('?format=pdf')).status, 400);
    assert.equal((await get('?since=yesterday')).status, 400);
  } finally {
    await app.close();
    store.close();
    await removeFixture(root);
  }
});

/**
 * Два компонента: поручения, вызовы, ревью плана, доски, перенос и перемотка
 * базы, отмена и возврат относятся каждый к своему; workspace — всё вместе.
 */
test('Отчёт компонента: поручения, вызовы, ревью, доски и перенос базы — только свои', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-report-')));
  const data = join(root, 'data');
  await mkdir(data);
  const repos = [];
  for (const id of ['product', 'library']) {
    const path = join(root, id);
    await mkdir(path);
    await git(path, 'init', '-b', 'main');
    await writeFile(join(path, 'README.md'), id);
    await git(path, 'add', '.');
    await git(path, 'commit', '-m', 'fixture');
    repos.push(repositorySchema.parse({ id, name: id, kind: id, path, gates: config().gates }));
  }
  const c = config({ repository: repos[0].path, repositories: repos });
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(store, c);
  try {
    const board = (repositoryId: string, titles: string[]) => {
      const b = h.createBoard('Board ' + repositoryId, '', repositoryId);
      const ids: string[] = [];
      for (const title of titles)
        ids.push(h.addTask(b.id, { ...input(title, ids.slice(-1)), repositoryId }).id);
      h.approve(b.id);
      return { boardId: b.id, ids };
    };
    const product = board('product', ['Task P1', 'Task P2', 'Task P3']);
    const library = board('library', ['Task L1', 'Task L2', 'Task L3']);
    // Продукт: две приёмки (вторая — после возврата проверкой), третья задача отменена.
    await call(h, complete(h, product.ids[0]).id, 1, 'product');
    h.pause(false);
    const gate = h.claim(h.store.read().leader?.owner ?? 'test')!;
    assert.equal(gate.taskId, product.ids[1]);
    h.fail(gate.id, gate.token, 'gate failed', false, 'gate');
    h.retry(product.ids[1]);
    complete(h, product.ids[1]);
    h.cancel(product.ids[2], 'not needed any more');
    // Библиотека: две приёмки с первой попытки, третья возвращена в черновик.
    await call(h, complete(h, library.ids[0]).id, 3, 'library');
    complete(h, library.ids[1]);
    h.reopen(library.ids[2], 'requirements changed for this task');
    // Ревью плана — запись ревью о доске библиотеки.
    store.atomic(() =>
      store.saveLocal('reviews', undefined, 'R-plan-library', {
        id: 'R-plan-library',
        kind: 'plan',
        subject: library.boardId,
        digest: 'd'.repeat(64),
        round: 1,
        at: new Date().toISOString(),
        approved: false,
        summary: 'Fixture round',
        authorRuntime: 'claude',
        reviewerRuntime: 'codex',
        sameVendor: false,
        findings: [],
        artifact: '',
      }),
    );
    h.pause(true);
    h.baseUpdated([{ repositoryId: 'library', from: SHA('1'), to: SHA('2') }]);
    // Как у диспетчера: перемотка меняет документ (время паузы), иначе
    // событие журнала не пишется.
    store.change('base.fast-forwarded', (st) => {
      st.pausedAt = new Date(Date.now() + 1000).toISOString();
      return {
        updated: [{ repositoryId: 'product', branch: 'main', from: SHA('3'), to: SHA('4') }],
      };
    });

    const of = (repositoryId?: string) => {
      const value = devcontourValueReport(h, { repositoryId });
      return { report: valueReportSchema.parse(value.report), host: value.host };
    };
    const whole = of();
    const p = of('product');
    const l = of('library');
    // coverage.works — поручения с попытками: отменённая без попытки и
    // возвращённая в черновик не входят.
    assert.equal(whole.report.coverage.works, 4);
    assert.equal(p.report.coverage.works, 2);
    assert.equal(l.report.coverage.works, 2);
    assert.equal(p.report.coverage.attempts, 3);
    assert.equal(l.report.coverage.attempts, 2);
    assert.equal(p.report.defects.byKind.gate, 1);
    assert.equal(l.report.defects.byKind.gate, 0);
    assert.equal(whole.report.cost.knownUsd, 4);
    assert.equal(p.report.cost.knownUsd, 1);
    assert.equal(l.report.cost.knownUsd, 3);
    assert.equal(whole.report.coverage.reviews, 1);
    assert.equal(p.report.coverage.reviews, 0);
    assert.equal(l.report.coverage.reviews, 1);
    assert.deepEqual([p.host.retries, l.host.retries, whole.host.retries], [1, 0, 1]);
    assert.deepEqual([p.host.cancellations, l.host.cancellations], [1, 0]);
    assert.deepEqual([p.host.reopened, l.host.reopened], [0, 1]);
    assert.deepEqual([p.host.baseUpdates, l.host.baseUpdates, whole.host.baseUpdates], [0, 1, 1]);
    assert.deepEqual(
      [p.host.automaticBaseUpdates, l.host.automaticBaseUpdates, whole.host.automaticBaseUpdates],
      [1, 0, 1],
    );
    assert.deepEqual([p.host.corrections, l.host.corrections], [0, 0]);
    // Пауза очереди общая: она в отчёте каждого компонента.
    assert.equal(p.host.operatorPauses, l.host.operatorPauses);
    assert.deepEqual(p.host.acceptedWithoutRetry, { value: 1, n: 2 });
    assert.deepEqual(l.host.acceptedWithoutRetry, { value: 2, n: 2 });
    assert.throws(() => devcontourValueReport(h, { repositoryId: 'nope' }));
  } finally {
    store.close();
    await removeFixture(root);
  }
});

test('CLI-чтение повторяется, если во время чтения начал работу writer; непрерывная запись — отказ', async () => {
  const { root, data } = await workspaceFixture();
  const c = await configOf(data);
  try {
    // Writer открыл базу во время первого чтения: появились файлы журнала —
    // чтение повторяется уже обычным соединением с журналом.
    const attempts: number[] = [];
    let writer: Store | undefined;
    const value = readOnlyValueReport(c, data, {}, 'data', (attempt) => {
      attempts.push(attempt);
      writer ??= new Store(join(data, 'state.sqlite'));
    });
    writer?.close();
    assert.deepEqual(attempts, [1, 2]);
    assert.equal(headline(valueReportSchema.parse(value.report), 'accepted').value, '5');
    // Writer пишет и закрывается после каждого чтения: файл базы меняется,
    // согласованного чтения нет — отказ после трёх попыток.
    let writes = 0;
    assert.throws(
      () =>
        readOnlyValueReport(c, data, {}, 'data', () => {
          const s = new Store(join(data, 'state.sqlite'));
          try {
            new DevContour(s, c).pause(writes++ % 2 === 0);
          } finally {
            s.close();
          }
        }),
      /непрерывно меняет другой процесс/,
    );
    assert.equal(writes, 3);
  } finally {
    await removeFixture(root);
  }
});
