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
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input, removeTestCheckoutRoot, testCheckoutRoot } from './helpers.ts';
import { DevContour, digest, loadedDigest, withoutModels } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { loadConfig } from '../src/runner/config.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { parseOperationalKeys, serveReconfigure } from '../src/runner/reconfigure.ts';
import {
  modelSettingsView,
  previewModels,
  pendingConfigWrite,
  recoverConfigWrite,
  requestModels,
} from '../src/runner/model-settings.ts';
import { sensitiveBaseEntries } from '../src/runner/sensitive-paths.ts';
import { withModelChoices } from '../src/runner/workspace-setup.ts';

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
    // Агентский API такой операции не знает: ни одна операция каталога (он же
    // — инструменты MCP) не принимает выбор моделей или порог вопросов.
    const catalog = (await (await fetch(app.url + '/api/capabilities')).json()) as {
      tools: { name: string; inputSchema?: unknown; input?: unknown }[];
    };
    assert.ok(catalog.tools.length > 10);
    for (const tool of catalog.tools) {
      const shape = JSON.stringify(tool.inputSchema ?? tool.input ?? {});
      assert.doesNotMatch(tool.name, /model|config|input_policy|threshold/, tool.name);
      for (const field of ['expectedConfigDigest', 'acknowledgedApprovals', '"threshold"'])
        assert.ok(!shape.includes(field), `${tool.name}: ${field}`);
    }
    const fileBefore = readFileSync(s.path, 'utf8');
    for (const operation of ['models_set', 'config_models', 'input_policy']) {
      const agent = await post('/api/agent', {
        operation,
        input: { changes, expectedConfigDigest: result.digest },
      });
      assert.equal(agent.status, 400, operation);
    }
    assert.equal(readFileSync(s.path, 'utf8'), fileBefore, 'агентский вызов файл не тронул');
    // Без подтверждения показанного набора маршрут отвечает 409 — проверено ниже функцией;
    // здесь — что маршрут передаёт отказ как 409, а не 500.
    const noAck = await post('/api/config/models', {
      changes: [{ slot: 'reviewer:main:backend', binding: { runtime: 'codex' } }],
      expectedConfigDigest: 'a'.repeat(64),
    });
    assert.equal(noAck.status, 409);
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
    // Подтверждение другого набора (например, показанного до нового утверждения) — тоже отказ.
    assert.throws(
      () => requestModels(s.server, s.root, { ...body, acknowledgedApprovals: 'b'.repeat(64) }),
      (e: Error & { status?: number }) =>
        e.status === 409 && /изменился после показа/.test(e.message),
    );
    assert.equal(readFileSync(s.path, 'utf8'), before);
    assert.equal(s.server.store.read().reconfigure, undefined);
    requestModels(s.server, s.root, { ...body, acknowledgedApprovals: preview.approvals.digest });
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
    assert.deepEqual(result.components, ['app/devcontour.component.json']);
    assert.deepEqual(result.files, ['app/devcontour.component.json', 'config.json']);
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

const gate = {
  id: 'test',
  kind: 'test',
  command: ['node', 'verify.mjs'],
  report: { type: 'junit', path: '.reports/junit.xml' },
};
const component = (roles: Record<string, unknown>) => ({
  name: 'Example app',
  gates: [gate],
  roles,
  reviewer: { runtime: 'demo' },
});

test('A top-level role shared by several components is one binding; the preview names every component', () => {
  const s = served();
  const second = mkdtempSync(join(s.root, 'repo-b-'));
  const raw = JSON.parse(readFileSync(s.path, 'utf8')) as Record<string, unknown>;
  delete raw.gates;
  raw.repositories = [
    { id: 'a', name: 'A', path: s.repository, gates: [gate] },
    { id: 'b', name: 'B', path: second, gates: [gate] },
  ];
  writeFileSync(s.path, JSON.stringify(raw, null, 2) + '\n');
  try {
    const h = new DevContour(s.server.store, loadConfig(s.path));
    const view = modelSettingsView(h, s.root);
    const qa = view.slots.filter((x) => x.role === 'qa' && x.kind === 'writer');
    assert.deepEqual(
      qa.map((x) => [x.id, x.repositories]),
      [['writer:*:qa', ['a', 'b']]],
      'одна привязка на роль, а не по одной на компонент',
    );
    assert.match(qa[0].note ?? '', /обновление профиля/);
    const preview = previewModels(h, s.root, {
      changes: [{ slot: 'writer:*:qa', binding: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } }],
      expectedConfigDigest: h.configDigest,
    });
    assert.deepEqual(
      preview.effective
        .filter((e) => e.role === 'qa' && e.kind === 'writer')
        .map((e) => [e.repositoryId, e.after]),
      [
        ['a', { runtime: 'codex', model: 'EXAMPLE_CODEX_B' }],
        ['b', { runtime: 'codex', model: 'EXAMPLE_CODEX_B' }],
      ],
    );
  } finally {
    s.cleanup();
  }
});

test('A role the component file lacks is read-only: the panel does not pin the whole role into the file', () => {
  const s = served({}, component({ qa: { runtime: 'demo' } }));
  const raw = JSON.parse(readFileSync(s.path, 'utf8')) as {
    repositories: Record<string, unknown>[];
  };
  // Роль из профиля или реестра — в записи репозитория, а не в файле компонента.
  raw.repositories[0].roles = { backend: { runtime: 'demo', writePaths: ['src/'] } };
  writeFileSync(s.path, JSON.stringify(raw, null, 2) + '\n');
  try {
    const h = new DevContour(s.server.store, loadConfig(s.path));
    const backend = modelSettingsView(h, s.root).slots.find((x) => x.id === 'writer:app:backend')!;
    assert.equal(backend.editable, false);
    assert.match(backend.reason ?? '', /workspace\.json/);
    const before = readFileSync(join(s.repository, 'devcontour.component.json'), 'utf8');
    assert.throws(
      () =>
        requestModels(h, s.root, {
          changes: [{ slot: 'writer:app:backend', binding: { runtime: 'codex' } }],
          expectedConfigDigest: h.configDigest,
        }),
      (e: Error & { status?: number }) => e.status === 409,
    );
    assert.equal(readFileSync(join(s.repository, 'devcontour.component.json'), 'utf8'), before);
  } finally {
    s.cleanup();
  }
});

test('A failed multi-file write returns every file byte for byte; a crash journal is rolled back on start', () => {
  const s = served({}, component({ qa: { runtime: 'demo' } }));
  try {
    const file = join(s.repository, 'devcontour.component.json');
    const before = { config: readFileSync(s.path, 'utf8'), component: readFileSync(file, 'utf8') };
    const body = {
      changes: [
        { slot: 'writer:app:qa', binding: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } },
        { slot: 'reviewer:app', binding: { runtime: 'claude' } },
      ],
      expectedConfigDigest: s.server.configDigest,
    };
    const request = s.server.requestReconfigure.bind(s.server);
    s.server.requestReconfigure = () => {
      throw new Error('request not written');
    };
    assert.throws(() => requestModels(s.server, s.root, body), /request not written/);
    assert.equal(readFileSync(s.path, 'utf8'), before.config);
    assert.equal(readFileSync(file, 'utf8'), before.component);
    assert.equal(existsSync(join(s.root, 'config-write.json')), false);
    assert.equal(s.server.store.read().reconfigure, undefined);
    s.server.requestReconfigure = request;
    // Сбой процесса посреди записи: журнал остаётся, файлы — наполовину новые.
    writeFileSync(
      join(s.root, 'config-write.json'),
      JSON.stringify({
        operation: 'config-apply:models:crash001',
        files: [
          { path: realpathSync(file), before: before.component, after: '{}' },
          { path: s.path, before: before.config, after: '{}' },
        ],
      }),
    );
    writeFileSync(file, '{}');
    // Пока журнал лежит, новая запись не начинается.
    assert.throws(
      () => requestModels(s.server, s.root, body),
      (e: Error & { status?: number }) => e.status === 409 || /не завершена/.test(e.message),
    );
    assert.deepEqual(recoverConfigWrite(s.root), {
      restored: [realpathSync(file)],
      skipped: [s.path],
    });
    assert.equal(readFileSync(file, 'utf8'), before.component);
    assert.equal(readFileSync(s.path, 'utf8'), before.config);
    assert.equal(recoverConfigWrite(s.root), undefined, 'журнала больше нет');
  } finally {
    s.cleanup();
  }
});

test('A component file edited after the panel read it is a CAS conflict, even when config.json is unchanged', () => {
  const s = served({}, component({ qa: { runtime: 'demo' } }));
  try {
    const seen = s.server.configDigest;
    const file = join(s.repository, 'devcontour.component.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { roles: Record<string, unknown> };
    raw.roles.qa = { runtime: 'claude' };
    writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
    assert.throws(
      () =>
        requestModels(s.server, s.root, {
          changes: [{ slot: 'writer:app:qa', binding: { runtime: 'codex' } }],
          expectedConfigDigest: seen,
        }),
      (e: Error & { status?: number }) => e.status === 409,
    );
    assert.equal(s.server.store.read().reconfigure, undefined);
  } finally {
    s.cleanup();
  }
});

test('The preview warns when review independence weakens: same vendor, no check rights, plan and contract reviewers', () => {
  const s = served({
    ...live,
    review: { code: { vendor: 'same-vendor-allowed' } },
  });
  try {
    const preview = (changes: unknown) =>
      previewModels(s.server, s.root, { changes, expectedConfigDigest: s.server.configDigest });
    // Ревьюер qa — того же вендора, что исполнитель: только явным правилом, и с предупреждением.
    const same = preview([{ slot: 'reviewer:main:qa', binding: { runtime: 'codex' } }]);
    assert.ok(
      same.warnings.some((w) => /same-vendor-allowed/.test(w)),
      same.warnings.join('\n'),
    );
    // codex-ревьюер без профиля запускает проверки, claude без Bash в профиле — нет.
    const reads = preview([{ slot: 'reviewer:main:backend', binding: { runtime: 'claude' } }]);
    assert.ok(reads.warnings.some((w) => /не сможет запускать проверки/.test(w)));
    // Ревьюер плана, названный явно, — того же runtime, что автор codex: ревью такому автору невозможно.
    const plan = preview([{ slot: 'review:plan', binding: { runtime: 'codex' } }]);
    assert.ok(
      plan.reviews.some(
        (r) => r.kind === 'plan' && r.author === 'codex' && r.after === 'отказ правила вендора',
      ),
    );
    assert.ok(plan.warnings.some((w) => /Ревью плана автора codex станет невозможным/.test(w)));
    const contract = preview([{ slot: 'review:contract', binding: { runtime: 'claude' } }]);
    assert.ok(contract.warnings.some((w) => /Ревью контракта автора claude/.test(w)));
  } finally {
    s.cleanup();
  }
});

test('A legacy approval without a pinned policy is pinned to the old policy before the change, then needs re-approval', () => {
  const s = served({ prices: [price('codex', 'EXAMPLE_CODEX_B')] });
  try {
    const board = s.server.createBoard('Example board');
    const task = s.server.addTask(board.id, input());
    s.server.approve(board.id);
    const old = s.server.planPolicyDigest();
    s.server.store.change('fixture.legacy', (state) => {
      delete state.tasks.find((t) => t.id === task.id)!.approvedPolicy;
    });
    const body = {
      changes: [{ slot: 'writer:main:qa', binding: { runtime: 'codex' } }],
      expectedConfigDigest: s.server.configDigest,
    };
    const preview = previewModels(s.server, s.root, body);
    assert.equal(preview.approvals.stale, 1, 'утверждение без закрепления тоже затронуто');
    requestModels(s.server, s.root, { ...body, acknowledgedApprovals: preview.approvals.digest });
    assert.equal(
      s.server.store.read().tasks.find((t) => t.id === task.id)!.approvedPolicy,
      old,
      'закреплено за прежней политикой до смены, а не за новой',
    );
    s.tick();
    assert.ok(s.server.approvalStale(s.server.store.read().tasks.find((t) => t.id === task.id)!));
  } finally {
    s.cleanup();
  }
});

test('A refused apply is journaled as config.apply-refused when the files moved before the tick', () => {
  const s = served({ prices: [price('codex', 'EXAMPLE_CODEX_B')] });
  try {
    const result = requestModels(s.server, s.root, {
      changes: [{ slot: 'writer:main:qa', binding: { runtime: 'codex' } }],
      expectedConfigDigest: s.server.configDigest,
    });
    const raw = JSON.parse(readFileSync(s.path, 'utf8')) as {
      roles: Record<string, Record<string, unknown>>;
    };
    raw.roles.qa.model = 'EXAMPLE_CODEX_B';
    writeFileSync(s.path, JSON.stringify(raw, null, 2) + '\n');
    s.tick();
    const refused = s.events('config.apply-refused');
    assert.equal(refused.length, 1);
    assert.equal((refused[0].data as { operation: string }).operation, result.operation);
    assert.equal(s.server.config.roles.qa.runtime, 'demo', 'прежние модели остались');
    assert.equal(s.server.store.read().reconfigure, undefined, 'запрос снят');
  } finally {
    s.cleanup();
  }
});

test('Committing the edited component file is a contour change of the run base: the panel names the stop', async () => {
  const s = served({}, component({ qa: { runtime: 'demo' } }));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', s.repository, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    const result = requestModels(s.server, s.root, {
      changes: [{ slot: 'writer:app:qa', binding: { runtime: 'codex' } }],
      expectedConfigDigest: s.server.configDigest,
    });
    assert.deepEqual(result.components, ['app/devcontour.component.json']);
    git('commit', '-q', '-am', 'models');
    const entries = await sensitiveBaseEntries(
      s.server,
      s.root,
      s.server.store.read(),
      'app',
      base,
      git('rev-parse', 'HEAD'),
    );
    // Диспетчер не перематывает базу через этот коммит: очередь ждёт base-update.
    assert.ok(
      entries.some((e) => e.path === 'devcontour.component.json'),
      JSON.stringify(entries),
    );
  } finally {
    s.cleanup();
  }
});

test('A profile upgrade keeps only model choices made in the panel and never brings back a removed reviewer', () => {
  const declared = {
    qa: {
      runtime: 'claude',
      writePaths: ['tests/'],
      reviewer: { runtime: 'codex', model: 'EXAMPLE_Y' },
    },
    backend: { runtime: 'claude', model: 'EXAMPLE_NEW' },
    docs: { runtime: 'claude' },
  };
  const existing = {
    qa: {
      runtime: 'codex',
      model: 'EXAMPLE_CODEX_B',
      reviewer: { runtime: 'codex', model: 'EXAMPLE_X' },
    },
    // Значение прежнего профиля, а не выбор оператора: профиль его обновляет.
    backend: { runtime: 'claude', model: 'EXAMPLE_OLD' },
    docs: { runtime: 'codex', reviewer: { runtime: 'claude' } },
  };
  const chosen = {
    qa: { writer: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } },
    // Ревьюер, которого новый профиль у роли убрал, не возвращается.
    docs: { writer: { runtime: 'codex' }, reviewer: { runtime: 'claude' } },
    // Выбор, который config.json уже не держит (правка руками после панели), не переносится.
    backend: { writer: { runtime: 'codex' } },
  };
  const { roles, kept } = withModelChoices(declared, existing, chosen);
  assert.deepEqual(roles.qa, {
    runtime: 'codex',
    writePaths: ['tests/'],
    reviewer: { runtime: 'codex', model: 'EXAMPLE_Y' },
    model: 'EXAMPLE_CODEX_B',
  });
  assert.deepEqual(roles.backend, { runtime: 'claude', model: 'EXAMPLE_NEW' });
  assert.deepEqual(roles.docs, { runtime: 'codex' });
  assert.deepEqual(kept.sort(), ['docs', 'qa']);
  assert.deepEqual(withModelChoices(declared, existing).kept, [], 'без выбора панели — профиль');
});

test('The panel records top-level model choices for profile upgrades', () => {
  const s = served({ prices: [price('codex', 'EXAMPLE_CODEX_B')] });
  try {
    requestModels(s.server, s.root, {
      changes: [
        { slot: 'writer:main:qa', binding: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } },
      ],
      expectedConfigDigest: s.server.configDigest,
    });
    assert.deepEqual(JSON.parse(readFileSync(join(s.root, 'model-choices.json'), 'utf8')), {
      roles: { qa: { writer: { runtime: 'codex', model: 'EXAMPLE_CODEX_B' } } },
    });
  } finally {
    s.cleanup();
  }
});

test('Recovery restores only files still holding the panel text; a later edit refuses start and changes nothing', () => {
  const s = served({}, component({ qa: { runtime: 'demo' } }));
  try {
    const file = realpathSync(join(s.repository, 'devcontour.component.json'));
    const before = { config: readFileSync(s.path, 'utf8'), component: readFileSync(file, 'utf8') };
    const journal = join(s.root, 'config-write.json');
    const temp = join(s.repository, '.devcontour.component.json.crash001.tmp');
    const write = () =>
      writeFileSync(
        journal,
        JSON.stringify({
          operation: 'config-apply:models:crash001',
          files: [
            { path: file, before: before.component, after: '{"panel": 1}\n', temp },
            {
              path: s.path,
              before: before.config,
              after: '{"panel": 2}\n',
              temp: s.path + '.x.tmp',
            },
          ],
        }),
      );
    // Сбой: файл компонента уже новый (и рядом — недописанный временный), config.json — прежний.
    write();
    writeFileSync(file, '{"panel": 1}\n');
    writeFileSync(temp, 'partial');
    assert.deepEqual(recoverConfigWrite(s.root), { restored: [file], skipped: [s.path] });
    assert.equal(readFileSync(file, 'utf8'), before.component);
    assert.equal(existsSync(temp), false, 'свой временный файл убран');
    assert.equal(existsSync(journal), false);
    // Сбой, затем правка руками (или workspace-init): ничего не трогается, запуск отказывает.
    write();
    writeFileSync(file, '{"panel": 1}\n');
    writeFileSync(s.path, '{"hand": true}\n');
    assert.throws(
      () => recoverConfigWrite(s.root),
      new RegExp(
        `изменены: ${s.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*Ничего не изменено.*config-write\\.json`,
      ),
    );
    assert.equal(
      readFileSync(file, 'utf8'),
      '{"panel": 1}\n',
      'файл с текстом панели тоже не тронут',
    );
    assert.equal(readFileSync(s.path, 'utf8'), '{"hand": true}\n');
    assert.ok(existsSync(journal), 'журнал оставлен');
    assert.match(pendingConfigWrite(s.root) ?? '', /не завершена/);
    // Повреждённый журнал — понятный отказ, без изменений.
    writeFileSync(journal, '{"operation": "config-apply:mo');
    assert.throws(() => recoverConfigWrite(s.root), /повреждён.*удалите журнал/);
    assert.equal(readFileSync(s.path, 'utf8'), '{"hand": true}\n');
    // Пока журнал лежит, панель не пишет и чужой журнал не удаляет.
    writeFileSync(s.path, before.config);
    assert.throws(
      () =>
        requestModels(s.server, s.root, {
          changes: [{ slot: 'writer:app:qa', binding: { runtime: 'codex' } }],
          expectedConfigDigest: s.server.configDigest,
        }),
      (e: Error & { status?: number }) => e.status === 409,
    );
    assert.ok(existsSync(journal));
  } finally {
    s.cleanup();
  }
});
