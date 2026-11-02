import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, fixture } from './helpers.ts';
import { AgentService } from '../src/application/agent.ts';
import { DomainError } from '../src/core/model.ts';
import { command } from '../src/runner/process.ts';
import { z, ZodError } from 'zod';

const invalidPlan = {
  operation: 'plan_import',
  input: {
    plan: {
      title: 42,
      description: 'План с ошибками в полях.',
      tasks: [
        {
          key: 'a',
          title: 'Задача',
          description: 'Описание задачи плана.',
          role: 'qa',
          dependsOn: 'b',
          acceptance: ['Проверки зелёные'],
        },
      ],
    },
  },
};

const named = (message: string) => {
  assert.match(message, /^Запрос plan_import не принят: /);
  assert.match(message, /plan\.title: /);
  assert.match(message, /plan\.tasks\[0\]\.dependsOn: /);
  assert.ok(!message.includes('"code"'), message);
  assert.ok(!message.includes('"path"'), message);
};

test('Агентский запрос с неверным входом отклоняется по названным полям, без сырого zod', async () => {
  const f = fixture();
  try {
    const api = new AgentService(f.h);
    const refused = (e: unknown) => {
      assert.ok(e instanceof DomainError, String(e));
      assert.equal(e.status, 400);
      named(e.message);
      return true;
    };
    // execute — вход HTTP-панели и тестов, run — общий вход CLI, HTTP и MCP.
    assert.throws(() => api.execute(invalidPlan), refused);
    await assert.rejects(api.run(invalidPlan), refused);
    // Неверное имя операции тоже называет поле.
    await assert.rejects(api.run({ operation: 'plan_imprt', input: {} }), (e: unknown) => {
      assert.ok(e instanceof DomainError && e.status === 400, String(e));
      assert.match(e.message, /^Запрос plan_imprt не принят: operation: /);
      return true;
    });
    // Имя операции из запроса в сообщении не длиннее 80 символов.
    await assert.rejects(api.run({ operation: 'x'.repeat(500), input: {} }), (e: unknown) => {
      assert.ok(e instanceof DomainError && e.status === 400, String(e));
      assert.ok(e.message.startsWith(`Запрос ${'x'.repeat(80)} не принят: operation: `), e.message);
      return true;
    });
    assert.equal(f.store.read().tasks.length, 0);

    // Сбой разбора внутри исполнения (сохранённые данные, конфигурация) — не
    // отказ запроса: он остаётся внутренней ошибкой, а не «Запрос не принят».
    f.h.createBoard = () => {
      z.object({ stored: z.string() }).parse({});
      throw new Error('разбор должен был отказать');
    };
    const internal = (e: unknown) => {
      assert.ok(e instanceof ZodError, String(e));
      assert.ok(!(e instanceof DomainError));
      return true;
    };
    assert.throws(
      () => api.execute({ operation: 'board_create', input: { title: 'Доска' } }),
      internal,
    );
    await assert.rejects(
      api.run({ operation: 'board_create', input: { title: 'Доска' } }),
      internal,
    );
  } finally {
    f.cleanup();
  }
});

test('agent --file с неверным plan_import печатает поля, а не массив zod', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-agent-input-'));
  try {
    const repo = join(root, 'repo'),
      data = join(root, 'data');
    await mkdir(repo);
    await mkdir(data);
    await writeFile(join(data, 'config.json'), JSON.stringify(config({ repository: repo })));
    const request = join(root, 'request.json');
    await writeFile(request, JSON.stringify(invalidPlan));
    const cli = ['node', '--import', 'tsx', 'src/cli.ts'];
    const result = await command(
      [...cli, 'agent', '--file', request, '--data', data],
      process.cwd(),
    );
    assert.notEqual(result.code, 0);
    named(result.stderr.trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
