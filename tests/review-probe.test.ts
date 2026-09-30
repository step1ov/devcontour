import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReviewProbes,
  probeCommand,
  probeSpec,
  type ProbeSpec,
} from '../src/runner/review-probe.ts';
import { isolationSupport } from '../src/runner/isolation.ts';
import { adapters, cliArguments, type AgentRequest } from '../src/runner/adapters.ts';
import { claudeMcp, type ProbeServer } from '../src/runner/tools.ts';
import { toolProfileSchema } from '../src/core/integrations.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { fixture, input } from './helpers.ts';
import { setupDemo } from '../src/demo.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';

async function stage(overrides: Partial<ProbeSpec> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-probe-'));
  const spec: ProbeSpec = {
    cwd: root,
    controller: [],
    readable: [root],
    isolation: { mode: 'none', domains: [] },
    commandTimeoutMs: 1500,
    budgetMs: 60000,
    deadline: Date.now() + 600000,
    env: ['PATH', 'HOME', 'DEVCONTOUR_TEST_PROBE_SECRET'],
    secrets: ['DEVCONTOUR_TEST_PROBE_SECRET'],
    settingsDir: join(root, 'settings'),
    log: join(root, 'probes.jsonl'),
    ...overrides,
  };
  return { root, spec, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('A hanging reviewer check is stopped with its detached children and returned as a typed result', async () => {
  const s = await stage();
  try {
    const probes = new ReviewProbes(s.spec);
    const pidFile = join(s.root, 'child.pid');
    const started = Date.now();
    // Команда печатает, оставляет отсоединённого потомка и зависает.
    const hung = await probes.run({
      argv: ['sh', '-c', `echo started; (sleep 60 & echo $! > ${pidFile}); sleep 60`],
      // Просьба модели не расширяет предел контура.
      timeoutMs: 3600000,
    });
    assert.equal(hung.status, 'timeout');
    assert.equal(hung.limitMs, 1500);
    assert.equal(hung.exitCode, null);
    assert.ok(Date.now() - started < 15000, 'остановлено за конечное время');
    assert.match(hung.stdout, /started/, 'частичный вывод сохранён');
    assert.match(hung.note ?? '', /не доказанный дефект/);
    const child = Number((await readFile(pidFile, 'utf8')).trim());
    for (let i = 0; i < 20 && alive(child); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(child), false, 'потомок не пережил проверку');

    // Обычные исходы и скрытие секретов.
    process.env.DEVCONTOUR_TEST_PROBE_SECRET = 'probe-secret-7731';
    const ok = await probes.run({
      argv: [process.execPath, '-e', 'console.log(process.env.DEVCONTOUR_TEST_PROBE_SECRET)'],
    });
    assert.equal(ok.status, 'passed');
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.stdout.includes('probe-secret-7731'), false);
    const failed = await probes.run({ argv: [process.execPath, '-e', 'process.exit(3)'] });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.exitCode, 3);
    const missing = await probes.run({ argv: ['devcontour-no-such-command'] });
    assert.notEqual(missing.status, 'passed');

    // Журнал контура — по записи на каждую команду, без значения секрета.
    const log = await readFile(s.spec.log, 'utf8');
    assert.equal(log.trim().split('\n').length, 4);
    assert.equal(log.includes('probe-secret-7731'), false);
  } finally {
    delete process.env.DEVCONTOUR_TEST_PROBE_SECRET;
    await s.cleanup();
  }
});

test('Reviewer checks share a budget and leave the reserve for the verdict', async () => {
  const s = await stage({ commandTimeoutMs: 1500, budgetMs: 4000 });
  try {
    const probes = new ReviewProbes(s.spec);
    const marker = join(s.root, 'ran');
    const hang = ['sh', '-c', `touch ${marker}; sleep 30`];
    // Каждая следующая команда получает не больше остатка бюджета; когда
    // остатка на осмысленную проверку нет, команда не запускается.
    let left = s.spec.budgetMs;
    let last;
    for (let i = 0; i < 6; i++) {
      await rm(marker, { force: true });
      last = await probes.run({ argv: hang });
      if (last.status === 'budget-exhausted') break;
      assert.equal(last.status, 'timeout');
      assert.ok(last.limitMs <= Math.min(1500, left), `предел ${last.limitMs} ≤ остатка ${left}`);
      left = last.budgetLeftMs;
    }
    assert.equal(last?.status, 'budget-exhausted');
    assert.equal(last.durationMs, 0);
    assert.ok(last.budgetLeftMs < 1000);
    assert.equal(existsSync(marker), false, 'после исчерпания бюджета команда не запускалась');

    // Время до заключения кончилось раньше бюджета — команда тоже не идёт.
    const late = new ReviewProbes({ ...s.spec, deadline: Date.now() + 500 });
    const refused = await late.run({ argv: hang });
    assert.equal(refused.status, 'budget-exhausted');
    assert.equal(existsSync(marker), false);
  } finally {
    await s.cleanup();
  }
});

test('Reviewer checks cannot write the reviewed sources under OS isolation', async (t) => {
  if (!isolationSupport().ok) {
    t.skip('Песочница ОС недоступна');
    return;
  }
  const s = await stage({ isolation: { mode: 'os', domains: [] }, commandTimeoutMs: 30000 });
  try {
    const probes = new ReviewProbes(s.spec);
    await writeFile(join(s.root, 'source.txt'), 'original');
    const read = await probes.run({ argv: ['cat', join(s.root, 'source.txt')] });
    assert.equal(read.status, 'passed', read.stderr);
    assert.match(read.stdout, /original/);
    const write = await probes.run({
      argv: ['sh', '-c', `echo changed > ${join(s.root, 'source.txt')}`],
    });
    assert.equal(write.status, 'failed');
    assert.equal(await readFile(join(s.root, 'source.txt'), 'utf8'), 'original');
    // Временные файлы проверка пишет в свой TMPDIR.
    const scratch = await probes.run({ argv: ['sh', '-c', 'echo x > "$TMPDIR/cache"'] });
    assert.equal(scratch.status, 'passed', scratch.stderr);
  } finally {
    await s.cleanup();
  }
});

/** Минимальный клиент MCP по stdio: запрос — ответ с тем же id. */
function client(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let buffer = '';
  const waiting = new Map<number, (value: unknown) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number };
      if (message.id !== undefined) waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  return {
    request(method: string, params: unknown) {
      const id = next++;
      return new Promise<Record<string, unknown>>((resolve) => {
        waiting.set(id, resolve as (value: unknown) => void);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method: string) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    close() {
      child.kill();
    },
  };
}

test('The reviewer CLI reaches the probe tool through the same command DevContour gives it', async () => {
  const s = await stage();
  try {
    const specPath = join(s.root, 'probe.json');
    await writeFile(specPath, JSON.stringify(s.spec));
    const { command, args } = probeCommand(specPath);
    const c = client(command, args);
    try {
      await c.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      c.notify('notifications/initialized');
      const tools = (await c.request('tools/list', {})) as {
        result: { tools: { name: string }[] };
      };
      assert.deepEqual(
        tools.result.tools.map((x) => x.name),
        ['run_check'],
      );
      const call = (await c.request('tools/call', {
        name: 'run_check',
        arguments: { argv: ['sh', '-c', 'echo probe-ok; sleep 30'] },
      })) as { result: { structuredContent: { status: string; stdout: string } } };
      assert.equal(call.result.structuredContent.status, 'timeout');
      assert.match(call.result.structuredContent.stdout, /probe-ok/);
    } finally {
      c.close();
    }
  } finally {
    await s.cleanup();
  }
});

test('Reviewer CLIs get the probe server with call limits above the controller limit', () => {
  const probe: ProbeServer = {
    command: '/usr/bin/node',
    args: ['cli.js', 'review-probe', '--spec', '/r/probe.json'],
    env: ['PATH', 'HOME'],
    commandTimeoutMs: 120000,
  };
  const profile = toolProfileSchema.parse({ runtime: 'claude', claudeTools: ['Read', 'Bash'] });
  const claude = cliArguments(
    'claude',
    { review: true, toolProfile: profile, probe, cwd: '/r' } as AgentRequest,
    's',
    'r',
  );
  const allowed = claude[claude.indexOf('--allowedTools') + 1].split(',');
  assert.ok(allowed.includes('mcp__devcontour_probe__run_check'));
  const env = (
    JSON.parse(claude[claude.indexOf('--settings') + 1]) as { env: Record<string, string> }
  ).env;
  assert.ok(Number(env.MCP_TOOL_TIMEOUT) > probe.commandTimeoutMs);
  assert.equal(env.BASH_MAX_TIMEOUT_MS, '120000', 'свой Bash ревьюера под тем же пределом');
  const servers = claudeMcp(profile, probe).mcpServers as Record<
    string,
    { command: string; env: Record<string, string> }
  >;
  assert.equal(servers.devcontour_probe.command, '/usr/bin/node');
  assert.deepEqual(servers.devcontour_probe.env, { PATH: '${PATH}', HOME: '${HOME}' });

  const codex = cliArguments(
    'codex',
    { review: true, probe, cwd: '/r' } as AgentRequest,
    's',
    'r',
  ).join(' ');
  assert.match(codex, /mcp_servers=\{ "devcontour_probe" = \{/);
  assert.match(codex, /"enabled_tools" = \["run_check"\]/);
  const timeout = Number(/"tool_timeout_sec" = (\d+)/.exec(codex)?.[1]);
  assert.ok(timeout * 1000 > probe.commandTimeoutMs, 'codex не обрывает вызов раньше контура');
  assert.match(codex, /"env_vars" = \["PATH", "HOME"\]/);
});

test('Only a reviewer that may run commands gets the probe tool, with limits in its prompt', async () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Probe board');
    const task = f.h.addTask(board.id, input());
    const scheduler = new Scheduler(f.h, f.root) as unknown as {
      reviewProbe: (
        ...args: unknown[]
      ) => Promise<{ prompt: string; server: ProbeServer; log: string } | undefined>;
    };
    const dir = await mkdtemp(join(tmpdir(), 'devcontour-probe-review-'));
    const execution = {
      env: { PATH: '/bin', TOKEN: 'secret-value' },
      redact: { secrets: ['secret-value'] },
    };
    const run = { id: 'R', dependencies: [] };
    const bash = toolProfileSchema.parse({ runtime: 'claude', claudeTools: ['Read', 'Bash'] });
    const reading = toolProfileSchema.parse({ runtime: 'claude' });
    const granted = await scheduler.reviewProbe(
      { name: 'claude' },
      run,
      task,
      '/w',
      dir,
      bash,
      execution,
    );
    assert.ok(granted);
    assert.match(granted.prompt, /run_check/);
    assert.match(granted.prompt, /120 s/);
    const spec = JSON.parse(await readFile(join(dir, 'probe.json'), 'utf8')) as ProbeSpec;
    assert.deepEqual(spec.secrets, ['TOKEN']);
    assert.equal(JSON.stringify(spec).includes('secret-value'), false, 'значения не на диске');
    assert.ok(spec.deadline < Date.now() + f.h.config.runTimeoutMs, 'резерв на заключение');
    assert.equal(
      await scheduler.reviewProbe({ name: 'claude' }, run, task, '/w', dir, reading, execution),
      undefined,
      'ревьюер только для чтения права не получает',
    );
    assert.ok(
      await scheduler.reviewProbe({ name: 'codex' }, run, task, '/w', dir, undefined, execution),
      'codex без профиля и так запускает команды — получает предел',
    );
    assert.equal(
      await scheduler.reviewProbe({ name: 'demo' }, run, task, '/w', dir, undefined, execution),
      undefined,
    );
    await rm(dir, { recursive: true, force: true });
  } finally {
    f.cleanup();
  }
});

test('A scheduled review hands the probe tool to the reviewer and records its checks from the controller log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-probe-run-'));
  await setupDemo(root);
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, loadConfig(join(root, 'config.json')));
  const requests: AgentRequest[] = [];
  // Ревьюер с именем codex и без профиля и так запускает команды — значит,
  // получает инструмент проверок. Заглушка вызывает его так, как вызвал бы
  // CLI: по спецификации из аргументов сервера.
  const runtimes = {
    ...adapters,
    demo: {
      name: 'codex' as const,
      async execute(r: AgentRequest) {
        requests.push(r);
        if (r.review && r.probe) {
          const path = r.probe.args[r.probe.args.indexOf('--spec') + 1];
          const spec = probeSpec.parse(JSON.parse(await readFile(path, 'utf8')));
          await new ReviewProbes(spec).run({ argv: [process.execPath, '-e', '1'] });
        }
        return adapters.demo.execute(r);
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  try {
    await scheduler.init();
    h.pause(false);
    await scheduler.drain();
    const reviews = requests.filter((r) => r.review);
    assert.ok(reviews.length > 0);
    assert.ok(reviews.every((r) => r.probe && r.prompt.includes('run_check')));
    const writers = requests.filter((r) => !r.review);
    assert.ok(writers.every((r) => !r.probe));
    // Исполнитель с shell получает просьбу проверить себя командами гейтов.
    assert.ok(writers.every((r) => /You have a shell.*Gate commands: \[\{"id"/s.test(r.prompt)));
    const logged = JSON.parse(
      await readFile(join(reviews[0].artifactDir, 'review.json'), 'utf8'),
    ) as {
      probes?: { status: string }[];
    };
    assert.deepEqual(
      logged.probes?.map((p) => p.status),
      ['passed'],
    );
  } finally {
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Reviewer check arguments are redacted in the result and the controller log', async () => {
  const s = await stage({ deadline: Date.now() });
  process.env.DEVCONTOUR_TEST_PROBE_SECRET = 'argv-secret-5521';
  try {
    // Бюджет исчерпан: команда не запускается, но аргументы сохраняются.
    const r = await new ReviewProbes(s.spec).run({
      argv: ['curl', '-H', 'Authorization: argv-secret-5521', 'http://127.0.0.1'],
    });
    assert.equal(r.status, 'budget-exhausted');
    assert.equal(JSON.stringify(r).includes('argv-secret-5521'), false);
    assert.equal((await readFile(s.spec.log, 'utf8')).includes('argv-secret-5521'), false);
  } finally {
    delete process.env.DEVCONTOUR_TEST_PROBE_SECRET;
    await s.cleanup();
  }
});
