/**
 * Модели ролей из панели: тот же путь, что `config-apply --keys models`.
 * Ожидаемый digest, проверка тем же загрузчиком (правило вендора ревью),
 * только известные workspace модели, запись файла объявления (config.json
 * или файл компонента) вместе с запросом применения, применение тактом
 * сервера после drain и повторное утверждение плана вместо молчаливого
 * перезакрепления. Модели не вызываются: runtime демо и fixture-конфигурации.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input, removeTestCheckoutRoot, testCheckoutRoot } from './helpers.ts';
import { DevContour, digest, loadedDigest, withoutModels } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { loadConfig } from '../src/runner/config.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { parseOperationalKeys, serveReconfigure } from '../src/runner/reconfigure.ts';
import { modelSettingsView, previewModels, requestModels } from '../src/runner/model-settings.ts';

const price = (runtime: string, model: string) => ({
  runtime,
  model,
  effectiveAt: '2026-01-01T00:00:00Z',
  input: 1,
  output: 4,
  cacheRead: 0.1,
  cacheWrite: 1,
});

/** Сервер с конфигурацией из файла: `raw` — поверх учебной конфигурации. */
function served(raw: Record<string, unknown> = {}, component?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-models-'));
  const checkouts = testCheckoutRoot();
  const path = join(root, 'config.json');
  const repository = mkdtempSync(join(root, 'repo-'));
  const base = {
    ...JSON.parse(JSON.stringify(config({ checkoutRoot: checkouts, repository }))),
    prices: [price('codex', 'EXAMPLE_CODEX_B'), price('claude', 'EXAMPLE_CLAUDE_B')],
    ...raw,
  } as Record<string, unknown>;
  if (component) {
    writeFileSync(
      join(repository, 'devcontour.component.json'),
      JSON.stringify(component, null, 2) + '\n',
    );
    base.repositories = [{ id: 'app', path: repository, configFile: 'devcontour.component.json' }];
    delete base.gates;
  }
  writeFileSync(path, JSON.stringify(base, null, 2) + '\n');
  const server = new DevContour(new Store(join(root, 'state.sqlite')), loadConfig(path));
  assert.ok(server.leader('server'));
  server.recordConfig('server');
  const tick = () => {
    server.leader('server');
    serveReconfigure(server, path, 'server');
  };
  return {
    root,
    path,
    repository,
    server,
    tick,
    events: (type: string) => server.store.events().filter((e) => e.type === type),
    cleanup: () => {
      server.store.close();
      rmSync(root, { recursive: true, force: true });
      removeTestCheckoutRoot(checkouts);
    },
  };
}

const live = {
  mode: 'local',
  roles: {
    backend: { runtime: 'claude', model: 'EXAMPLE_CLAUDE_A' },
    qa: { runtime: 'codex', effort: 'low', reviewer: { runtime: 'claude' } },
  },
  reviewer: { runtime: 'codex', model: 'EXAMPLE_CODEX_A' },
};

test('The settings view lists bindings, their files and only models the workspace knows', () => {
  const s = served(live);
  try {
    const view = modelSettingsView(s.server, s.root);
    assert.deepEqual(view.runtimes, ['codex', 'claude'], 'demo — только в demo mode');
    // Модели — из привязок и тарифов; «по умолчанию» — пустая модель.
    assert.deepEqual(view.models, {
      codex: ['EXAMPLE_CODEX_A', 'EXAMPLE_CODEX_B'],
      claude: ['EXAMPLE_CLAUDE_A', 'EXAMPLE_CLAUDE_B'],
    });
    const slot = (id: string) => view.slots.find((x) => x.id === id);
    assert.deepEqual(slot('writer:main:backend')?.binding, {
      runtime: 'claude',
      model: 'EXAMPLE_CLAUDE_A',
    });
    assert.equal(slot('writer:main:backend')?.file, 'config.json');
    // Ревьюер роли без своего — наследуется от общего.
    assert.equal(slot('reviewer:main:backend')?.own, false);
    assert.deepEqual(slot('reviewer:main:backend')?.binding, {
      runtime: 'codex',
      model: 'EXAMPLE_CODEX_A',
    });
    assert.equal(slot('reviewer:main:qa')?.own, true);
    assert.equal(slot('reviewer')?.editable, true);
    // Ревью плана и контракта без своего ревьюера — правило по умолчанию.
    assert.equal(slot('review:plan')?.binding, null);
    assert.equal(slot('review:plan')?.nullable, true);
    assert.equal(slot('review:code'), undefined);
  } finally {
    s.cleanup();
  }
});

test('Model changes are validated by the config loader: vendor rule, unknown model, effort, CAS', () => {
  const s = served(live);
  try {
    const before = readFileSync(s.path, 'utf8');
    const digest = s.server.configDigest;
    const preview = (changes: unknown, expected = digest) =>
      previewModels(s.server, s.root, { changes, expectedConfigDigest: expected });
    // Исполнитель на runtime своего ревьюера без явного правила вендора — отказ загрузчика.
    assert.throws(
      () => preview([{ slot: 'writer:main:backend', binding: { runtime: 'codex' } }]),
      (e: Error & { status?: number }) =>
        e.status === 400 && /другой runtime ревьюера|другого вендора/.test(e.message),
    );
    // Модель, которой workspace не знает, — отказ с перечнем известных.
    assert.throws(
      () =>
        preview([
          {
            slot: 'writer:main:backend',
            binding: { runtime: 'claude', model: 'EXAMPLE_TYPO' },
          },
        ]),
      /не знает.*EXAMPLE_CLAUDE_A, EXAMPLE_CLAUDE_B/,
    );
    // Уровень рассуждения — только codex.
    assert.throws(
      () =>
        preview([{ slot: 'writer:main:backend', binding: { runtime: 'claude', effort: 'high' } }]),
      /только для codex/,
    );
    // Исполнителя снять нельзя; неизвестная привязка — отказ.
    assert.throws(() => preview([{ slot: 'writer:main:backend', binding: null }]), /нельзя снять/);
    assert.throws(() => preview([{ slot: 'writer:main:nobody', binding: null }]), /Неизвестная/);
    // Чужой digest — 409 без записи.
    assert.throws(
      () =>
        preview([{ slot: 'writer:main:backend', binding: { runtime: 'claude' } }], 'a'.repeat(64)),
      (e: Error & { status?: number }) => e.status === 409,
    );
    // Допустимая правка: предпросмотр называет изменение и ничего не пишет.
    const ok = preview([
      {
        slot: 'writer:main:backend',
        binding: { runtime: 'claude', model: 'EXAMPLE_CLAUDE_B' },
      },
      { slot: 'review:plan', binding: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } },
    ]);
    assert.equal(ok.changes.length, 2);
    assert.deepEqual(ok.files, ['config.json']);
    assert.equal(readFileSync(s.path, 'utf8'), before);
    assert.equal(s.server.store.read().reconfigure, undefined);
  } finally {
    s.cleanup();
  }
});

test('The panel route writes config.json with the apply request; the server tick applies models only', async () => {
  const s = served(live);
  const app = await serve(s.server, new Scheduler(s.server, s.root), { port: 0 });
  try {
    const post = (path: string, body: unknown) =>
      fetch(app.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
        body: JSON.stringify(body),
      });
    const settings = (await (await fetch(app.url + '/api/config/settings')).json()) as {
      configDigest: string;
      models: { slots: { id: string }[] };
      inputPolicy: unknown;
    };
    assert.equal(settings.configDigest, s.server.configDigest);
    assert.equal(settings.inputPolicy, null, 'порог вопросов — на том же экране');
    const changes = [
      { slot: 'writer:main:qa', binding: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } },
      { slot: 'reviewer:main:qa', binding: null },
      { slot: 'reviewer:main:backend', binding: { runtime: 'codex', effort: 'high' } },
    ];
    // Без заголовка локального клиента маршрут закрыт, как и остальные операции панели.
    const foreign = await fetch(app.url + '/api/config/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes, expectedConfigDigest: settings.configDigest }),
    });
    assert.equal(foreign.status, 403);
    // qa без своего ревьюера наследует общего codex — тот же runtime, что исполнитель.
    const refused = await post('/api/config/models', {
      changes,
      expectedConfigDigest: settings.configDigest,
    });
    assert.equal(refused.status, 400);
    changes[1] = {
      slot: 'reviewer:main:qa',
      binding: { runtime: 'claude', model: 'EXAMPLE_CLAUDE_B' },
    };
    const ok = await post('/api/config/models', {
      changes,
      expectedConfigDigest: settings.configDigest,
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    const result = (await ok.json()) as { operation: string; digest: string; changes: unknown[] };
    assert.match(result.operation, /^config-apply:models:/);
    assert.equal(result.changes.length, 3);
    const file = JSON.parse(readFileSync(s.path, 'utf8')) as {
      roles: Record<string, Record<string, unknown>>;
    };
    // Поля модели заменены, прочие поля привязки сохранены.
    assert.deepEqual(file.roles.qa, {
      runtime: 'codex',
      reviewer: { runtime: 'claude', model: 'EXAMPLE_CLAUDE_B' },
      model: 'EXAMPLE_CODEX_B',
    });
    assert.deepEqual(file.roles.backend.reviewer, { runtime: 'codex', effort: 'high' });
    // Пока такт не применил, сервер работает с прежними моделями.
    assert.equal(s.server.config.roles.qa.model, undefined);
    s.tick();
    assert.equal(s.server.config.roles.qa.model, 'EXAMPLE_CODEX_B');
    assert.equal(s.server.configDigest, result.digest);
    const applied = s.events('config.applied');
    assert.equal(applied.length, 1);
    assert.deepEqual((applied[0].data as { keys: string[] }).keys, ['models']);
    assert.ok(
      (applied[0].data as { changed: string[] }).changed.includes('models'),
      'журнал называет изменённый ключ',
    );
    // Агентский API такой операции не знает.
    const agent = await post('/api/agent', {
      operation: 'models_set',
      input: { changes, expectedConfigDigest: result.digest },
    });
    assert.notEqual(agent.status, 200);
  } finally {
    await app.close();
    s.cleanup();
  }
});

test('Applying models refuses anything but model fields: config-apply --keys models', () => {
  const s = served(live);
  try {
    assert.deepEqual(parseOperationalKeys('models'), ['models']);
    // Тот же digest без полей модели — привязки; другая область записи — нет.
    const current = loadConfig(s.path);
    const edited = JSON.parse(readFileSync(s.path, 'utf8')) as {
      roles: Record<string, Record<string, unknown>>;
    };
    edited.roles.backend.model = 'EXAMPLE_CLAUDE_B';
    edited.roles.backend.reviewer = { runtime: 'codex' };
    writeFileSync(s.path, JSON.stringify(edited));
    assert.equal(digest(withoutModels(loadConfig(s.path))), digest(withoutModels(current)));
    edited.roles.backend.writePaths = ['src/'];
    writeFileSync(s.path, JSON.stringify(edited));
    const next = loadConfig(s.path);
    assert.notEqual(digest(withoutModels(next)), digest(withoutModels(current)));
    assert.throws(() => s.server.reconfigure(next, ['models']), /не только models/);
    assert.equal(s.server.config.roles.backend.model, 'EXAMPLE_CLAUDE_A');
  } finally {
    s.cleanup();
  }
});

test('Approved tasks pinned under the old models need re-approval; the panel asks first and never re-pins', () => {
  const s = served({ prices: [price('codex', 'EXAMPLE_CODEX_B')] });
  try {
    const board = s.server.createBoard('Example board');
    const task = s.server.addTask(board.id, input());
    s.server.approve(board.id);
    const pinned = s.server.store.read().tasks.find((t) => t.id === task.id)!.approvedPolicy;
    assert.equal(pinned, s.server.planPolicyDigest());
    const body = {
      changes: [
        { slot: 'writer:main:qa', binding: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } },
      ],
      expectedConfigDigest: s.server.configDigest,
    };
    const preview = previewModels(s.server, s.root, body);
    assert.equal(preview.approvals.stale, 1);
    assert.deepEqual(preview.approvals.tasks, [{ id: task.id, title: task.title }]);
    const before = readFileSync(s.path, 'utf8');
    // Без подтверждения — отказ без записи.
    assert.throws(
      () => requestModels(s.server, s.root, body),
      (e: Error & { status?: number }) => e.status === 409 && /review-plan/.test(e.message),
    );
    assert.equal(readFileSync(s.path, 'utf8'), before);
    assert.equal(s.server.store.read().reconfigure, undefined);
    requestModels(s.server, s.root, { ...body, acknowledgeReapproval: true });
    s.tick();
    assert.equal(s.server.config.roles.qa.model, 'EXAMPLE_CODEX_B');
    const after = s.server.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(after.approvedPolicy, pinned, 'закрепление утверждения не тронуто');
    assert.ok(s.server.approvalStale(after), 'задача ждёт повторного утверждения плана');
  } finally {
    s.cleanup();
  }
});

test('A component binding is edited in its component file; the single-component copy follows', () => {
  const s = served(
    { roles: { qa: { runtime: 'demo' } }, reviewer: { runtime: 'demo' } },
    {
      name: 'Example app',
      gates: [
        {
          id: 'test',
          kind: 'test',
          command: ['node', 'verify.mjs'],
          report: { type: 'junit', path: '.reports/junit.xml' },
        },
      ],
      roles: { qa: { runtime: 'demo', writePaths: ['tests/'] } },
      reviewer: { runtime: 'demo' },
    },
  );
  try {
    const view = modelSettingsView(s.server, s.root);
    const writer = view.slots.find((x) => x.id === 'writer:app:qa')!;
    assert.equal(writer.file, 'app/devcontour.component.json');
    assert.ok(
      view.slots.some((x) => x.id === 'reviewer:app'),
      'ревьюер компонента',
    );
    assert.ok(!view.slots.some((x) => x.id === 'reviewer'), 'верхний ревьюер — копия, не показан');
    const result = requestModels(s.server, s.root, {
      changes: [
        { slot: 'writer:app:qa', binding: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } },
        { slot: 'reviewer:app', binding: { runtime: 'claude' } },
      ],
      expectedConfigDigest: s.server.configDigest,
    });
    assert.deepEqual(result.commit, ['app/devcontour.component.json']);
    const file = JSON.parse(
      readFileSync(join(s.repository, 'devcontour.component.json'), 'utf8'),
    ) as { roles: Record<string, unknown>; reviewer: unknown };
    assert.deepEqual(file.roles.qa, {
      runtime: 'codex',
      writePaths: ['tests/'],
      model: 'EXAMPLE_CODEX_B',
    });
    assert.deepEqual(file.reviewer, { runtime: 'claude' });
    const top = JSON.parse(readFileSync(s.path, 'utf8')) as {
      roles: Record<string, unknown>;
      reviewer: unknown;
    };
    assert.deepEqual(top.roles.qa, { runtime: 'codex', model: 'EXAMPLE_CODEX_B' });
    assert.deepEqual(top.reviewer, { runtime: 'claude' });
    s.tick();
    assert.equal(s.server.configDigest, result.digest);
    assert.equal(loadedDigest(loadConfig(s.path)), result.digest);
  } finally {
    s.cleanup();
  }
});

test('review rules declared in workspace.json stay read-only in the panel', () => {
  const s = served();
  const registry = join(s.root, 'workspace');
  mkdirSync(registry);
  const raw = JSON.parse(readFileSync(s.path, 'utf8')) as Record<string, unknown>;
  writeFileSync(s.path, JSON.stringify({ ...raw, workspaceRoot: registry }, null, 2) + '\n');
  writeFileSync(
    join(registry, 'workspace.json'),
    JSON.stringify({ review: { plan: { vendor: 'different-vendor' } } }),
  );
  try {
    const h = new DevContour(s.server.store, loadConfig(s.path));
    const view = modelSettingsView(h, s.root);
    const plan = view.slots.find((x) => x.id === 'review:plan')!;
    assert.equal(plan.editable, false);
    assert.match(plan.reason ?? '', /workspace\.json/);
    assert.equal(view.slots.find((x) => x.id === 'review:contract')?.editable, true);
    assert.throws(
      () =>
        previewModels(h, s.root, {
          changes: [{ slot: 'review:plan', binding: { runtime: 'codex' } }],
          expectedConfigDigest: h.configDigest,
        }),
      (e: Error & { status?: number }) => e.status === 409,
    );
  } finally {
    s.cleanup();
  }
});
