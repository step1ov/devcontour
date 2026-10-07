import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AgentService, capabilities } from '../src/application/agent.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { serve } from '../src/server/http.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { command, git } from '../src/runner/process.ts';
import { submitCase } from '../src/runner/checks.ts';
import { check, checkProject, fixture, knap, rejection, removeRoot } from './check-fixture.ts';

const zero = (v: number) => JSON.stringify({ items: [{ w: 0, v }], cap: 0 });
type F = Awaited<ReturnType<typeof fixture>>;

async function failedTask(f: F) {
  f.write('src/knap.mjs', knap.zeroWeight);
  const board = f.h.createBoard('Transports');
  const t = f.h.addTask(board.id, {
    title: 'Knapsack',
    description: 'Оптимум рюкзака по договору проверки.',
    role: 'backend',
    contracts: [f.contract!.id],
    acceptance: ['AC-optimal'],
    writePaths: ['src/'],
    properties: ['knapsack-optimal'],
  });
  f.h.approve(board.id);
  f.h.pause(false);
  await f.scheduler.drain();
  f.h.pause(true);
  return t;
}

test('AC33: Agent API, CLI, HTTP and MCP share version checks, refusals and side effects; read-only methods start nothing', async () => {
  const p = await checkProject({ 'check.mjs': check(120, { zeroWeights: false }) });
  const f = await fixture(p, {
    reviewer: (_r, calls) =>
      calls.review === 1
        ? rejection({ property: 'knapsack-optimal', input: zero(5), expected: '5', actual: '0' })
        : undefined,
  });
  const app = await serve(f.h, f.scheduler, { port: 0 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const service = new AgentService(f.h, p.root);
  const server = createMcpServer(service);
  const client = new Client({ name: 'check-api', version: '1.0.0' });
  try {
    const t = await failedTask(f);
    await server.connect(serverSide);
    await client.connect(clientSide);
    await writeFile(join(p.root, 'config.json'), JSON.stringify(f.h.config));
    const http = async (operation: string, input: unknown) => {
      const r = await fetch(app.url + '/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
        body: JSON.stringify({ operation, input }),
      });
      const body = (await r.json()) as Record<string, unknown>;
      return { status: r.status, body };
    };
    const mcp = async (operation: string, input: unknown) => {
      const r = (await client.callTool({
        name: operation,
        arguments: input as Record<string, unknown>,
      })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content: { text: string }[];
      };
      return r.isError
        ? {
            status: (JSON.parse(r.content[0].text) as { status: number }).status,
            body: JSON.parse(r.content[0].text) as Record<string, unknown>,
          }
        : { status: 200, body: r.structuredContent! };
    };
    const cli = async (operation: string, input: unknown) => {
      const file = join(p.root, `request-${operation}.json`);
      await writeFile(file, JSON.stringify({ operation, input }));
      const r = await command(
        [
          process.execPath,
          '--import',
          import.meta.resolve('tsx'),
          resolve('src/cli.ts'),
          'agent',
          '--file',
          file,
          '--data',
          p.root,
        ],
        process.cwd(),
        {
          timeoutMs: 120000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        },
      );
      return r.code
        ? { status: 500, body: { error: r.stderr } as Record<string, unknown> }
        : { status: 200, body: JSON.parse(r.stdout) as Record<string, unknown> };
    };
    const local = async (operation: string, input: unknown) => {
      try {
        return { status: 200, body: await service.run({ operation, input }) };
      } catch (error) {
        return {
          status: (error as { status?: number }).status ?? 500,
          body: { error: String(error) } as Record<string, unknown>,
        };
      }
    };

    // Чтение: одинаковый ответ, ничего не запускает и не пишет.
    const events = f.store.eventCount();
    const worktrees = await git(p.repo, 'worktree', 'list');
    const view = { taskId: t.id, limit: 5 };
    const read = await Promise.all(
      [local, http, mcp, cli].map((call) => call('checks_view', view)),
    );
    for (const r of read) assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const r of read.slice(1)) assert.deepEqual(r.body, read[0].body);
    const viaPanel = (await (
      await fetch(`${app.url}/api/tasks/${t.id}/checks?limit=5`)
    ).json()) as unknown;
    assert.deepEqual(viaPanel, read[0].body);
    assert.equal((read[0].body.next as { actor: string }).actor, 'controller');
    assert.equal(f.store.eventCount(), events, 'чтение ничего не записало');
    assert.equal(await git(p.repo, 'worktree', 'list'), worktrees, 'чтение ничего не запустило');
    const tools = capabilities().tools;
    for (const name of ['checks_view', 'contract_change_status', 'feasibility_spikes'])
      assert.equal(tools.find((x) => x.name === name)?.readOnly, true);
    for (const name of [
      'checks_case_submit',
      'checks_adopt',
      'recovery_decide',
      'contract_change_revise',
    ])
      assert.equal(tools.find((x) => x.name === name)?.readOnly, false);

    // Изменение: один ключ — один эффект, через любой транспорт.
    const submit = {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: zero(5),
      expected: '5',
      key: 'api-case-zero',
    };
    const first = await http('checks_case_submit', submit);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const decision = first.body.decision as { id: string; outcome: string };
    assert.equal(decision.outcome, 'confirmed');
    for (const call of [mcp, local, cli]) {
      const again = await call('checks_case_submit', submit);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.repeated, true);
      assert.equal((again.body.decision as { id: string }).id, decision.id);
    }

    // Отказы различимы одинаково: быстрый путь не удаляет, неизвестное — 404.
    for (const call of [local, http, mcp]) {
      const refused = await call('checks_case_submit', {
        ...submit,
        key: 'api-remove',
        change: 'remove',
      });
      assert.equal(refused.status, 409);
      const missing = await call('checks_adopt', {
        suiteId: 'KS-missing',
        version: 1,
        tasks: [t.id],
        reason: 'Принять несуществующую версию.',
      });
      assert.equal(missing.status, 404);
      const unknown = await call('contract_change_revise', {
        id: 'CC-missing',
        expectedVersion: 0,
      });
      assert.equal(unknown.status, 404);
    }
    // Устаревшая версия записи эпизода отказывает одинаково.
    f.h.retry(t.id);
    f.h.pause(false);
    await f.scheduler.drain();
    f.h.pause(true);
    const recovery = f.store.read().tasks.find((x) => x.id === t.id)!.recovery!;
    assert.equal(recovery.status, 'awaiting-lead');
    const stale = {
      taskId: t.id,
      recoveryId: recovery.id,
      expectedVersion: recovery.version + 5,
      action: 'new-approach',
      reason: 'Устаревшая версия записи эпизода не применяется.',
      hypothesis: 'Брать нулевые веса.',
      plan: 'Корпус.',
    };
    for (const call of [local, http, mcp])
      assert.equal((await call('recovery_decide', stale)).status, 409);
    const decided = await mcp('recovery_decide', { ...stale, expectedVersion: recovery.version });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal((decided.body.recovery as { status: string }).status, 'retry');
  } finally {
    await client.close().catch(() => undefined);
    await app.close();
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC35: metrics keep their denominators over gate, review and infrastructure failures, unknown prices and an imported receipt', async () => {
  const p = await checkProject({ 'check.mjs': check(120, { zeroWeights: false }) });
  const f = await fixture(p, {
    config: { maxAttempts: 6 },
    reviewer: (_r, calls) =>
      calls.review === 1
        ? rejection({ property: 'knapsack-optimal', input: zero(5), expected: '5', actual: '0' })
        : undefined,
  });
  try {
    const t = await failedTask(f); // ревью отклонило при зелёных гейтах
    // Пример ревьюера контур подтвердил эталоном сам; ручной повтор того же
    // входа не создаёт второй версии, но остаётся отдельным решением.
    await submitCase(f.h, p.root, {
      taskId: t.id,
      property: 'knapsack-optimal',
      input: zero(5),
      key: 'metrics-case',
    });
    f.h.retry(t.id);
    f.h.pause(false);
    await f.scheduler.drain(); // тот же случай корпуса: повторный дефект, отказ гейта
    // Два отказа по свойству открыли эпизод: повтор — по ручному решению.
    const episode = f.store.read().tasks.find((x) => x.id === t.id)!.recovery!;
    f.h.recoveryDecide(t.id, episode.id, {
      action: 'new-approach',
      reason: 'Ручное решение: нулевые веса нужно брать всегда.',
      evidence: [],
      hypothesis: 'Брать предметы нулевого веса.',
      plan: 'Корпус и генератор.',
      source: { kind: 'operator' },
      decidedAt: new Date().toISOString(),
    });
    // Отказ окружения: не дефект и не отказ ревью.
    const original = f.scheduler.runtimes.demo.execute.bind(f.scheduler.runtimes.demo);
    f.scheduler.runtimes.demo.execute = () => Promise.reject(new Error('socket hang up'));
    f.h.retry(t.id);
    f.h.pause(false);
    await f.scheduler.drain();
    f.scheduler.runtimes.demo.execute = original;
    // Неизвестная цена: вызов без тарифа и без отчёта провайдера.
    f.h.store.atomic(() =>
      f.h.store.saveLocal('usage', 'main', 'manual-call', {
        repositoryId: 'main',
        id: 'manual-call',
        stage: 'property-recovery',
        runtime: 'codex',
        model: null,
        runtimeVersion: null,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        finishedAt: new Date().toISOString(),
        outcome: 'returned',
        promptBytes: 10,
        promptDigest: 'x',
        usage: {
          complete: false,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reportedUsd: null,
        },
        costUsd: null,
        costSource: 'unknown',
      }),
    );
    // Импортированный результат соседнего клона.
    f.store.change('test.imported', (s) => {
      const other = structuredClone(s.tasks.find((x) => x.id === t.id)!);
      other.id = 'T-imported';
      other.status = 'done';
      other.resultSha = 'a'.repeat(40);
      other.sharedCompletion = { receipt: {} as never, sourceCommit: 'b'.repeat(40) };
      other.recovery = undefined;
      s.tasks.push(other);
      s.boards[0].revisions[0].taskIds.push(other.id);
    });
    const m = workflowMetrics(f.h, 'main');
    const feedback = m.feedback;
    assert.equal(feedback.reviewAfterGreenGates.completed, 1, 'одно ревью после зелёных гейтов');
    assert.equal(feedback.reviewAfterGreenGates.rejected, 1);
    assert.equal(feedback.reviewAfterGreenGates.rate, 1);
    assert.equal(feedback.repeatedDefects.sameCase, 1, 'тот же случай корпуса вернулся');
    assert.equal(feedback.repeatedDefects.newCaseSameProperty, 0);
    assert.equal(feedback.feedbackCost.outcomes.confirmed, 2);
    assert.equal(feedback.feedbackCost.confirmations.count, 2);
    assert.ok(
      feedback.feedbackCost.confirmations.knownMs > 0,
      'длительность подтверждения измерена',
    );
    assert.equal(feedback.feedbackCost.leadAnalyses.count, 1);
    assert.equal(feedback.feedbackCost.corpusVersions, 1);
    // Неизвестная стоимость не превращается в ноль и в полный итог.
    assert.equal(m.usage.complete, false);
    assert.equal(m.costUsd, null);
    assert.ok(m.usage.unknownCalls >= 1);
    // Импорт считается отдельно и не входит в локальную автономность.
    assert.equal(m.counts.importedResults, 1);
    assert.equal(feedback.autonomy.accepted, 0);
    const runs = f.store.read().runs.filter((r) => r.taskId === t.id);
    assert.deepEqual(
      runs.map((r) => r.failureKind),
      ['review', 'gate', 'environment'],
    );
    // Ручное решение разбора — наблюдаемое техническое вмешательство.
    assert.ok(feedback.feedbackCost.technicalInterventions >= 1);
    assert.equal(
      f.store.read().tasks.find((x) => x.id === t.id)!.recovery?.status,
      'retry',
      'отказ окружения вернул право на повтор',
    );
    const progress = feedback.progress.find((x) => x.taskId === t.id)!;
    assert.equal(progress.attempts, 3);
    assert.equal(progress.toAcceptedMs, null, 'неприняте не измеряется как принятое');
    assert.ok(progress.ongoingMs !== null);
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});
