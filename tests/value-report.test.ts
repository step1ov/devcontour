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
import { configSchema } from '../src/core/model.ts';
import type { DevContourValueReport } from '../src/application/value-report.ts';
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
async function call(h: DevContour, runId: string, usd: number | null) {
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
    { repositoryId: 'main', runId, stage: 'implementation' },
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
    // Заголовок задачи — по умолчанию, причина сброса — никогда.
    assert.ok(json.stdout.includes(TITLE));
    assert.ok(!json.stdout.includes(RESET_REASON));
    assert.ok(!json.stdout.includes('/Users/') && !json.stdout.includes(root));

    const md = await cli('--data', data, '--format', 'md');
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, /^# Harness report: data\n/);
    assert.match(md.stdout, /\*\*2 of 5\*\*/);
    assert.match(md.stdout, /## Приложение DevContour: вмешательства по журналу контура/);
    assert.match(md.stdout, /Явные повторы задач: 4, из них со сбросом бюджета попыток: 1/);
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
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 65536);
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

test('HTTP /api/report: HTML для ссылки панели, JSON и Markdown; неизвестный формат — 400', async () => {
  const { root, data } = await workspaceFixture();
  const c = await configOf(data);
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(store, c);
  const app = await serve(h, new Scheduler(h, data), { port: 0 });
  try {
    const html = await fetch(app.url + '/api/report?format=html');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type')!, /^text\/html/);
    assert.match(html.headers.get('content-security-policy')!, /default-src 'none'/);
    const page = await html.text();
    assert.ok(page.includes('Приложение DevContour'));
    assert.ok(page.includes(TITLE));
    assert.ok(!/<script/.test(page));
    const hidden = await (await fetch(app.url + '/api/report?format=md&noTitles=1')).text();
    assert.ok(hidden.startsWith('# Harness report'));
    assert.ok(!hidden.includes(TITLE));
    const json = await fetch(app.url + '/api/report?format=json');
    assert.equal(json.status, 200);
    const body = parsed(await json.text());
    assert.equal(body.host.resets, 1);
    assert.equal((await fetch(app.url + '/api/report?format=pdf')).status, 400);
    assert.equal((await fetch(app.url + '/api/report?since=yesterday')).status, 400);
  } finally {
    await app.close();
    store.close();
    await removeFixture(root);
  }
});
