import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Preparation } from '../src/core/preparation.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { preparationStore, startWorkspace } from '../src/runner/start.ts';
import { AttentionService } from '../src/application/attention.ts';
import type { AttentionView } from '../src/application/attention.ts';
import { product } from './preparation-fixture.ts';
import { config, withTestHome } from './helpers.ts';
import { byKey, dumpDatabase, fileStamps } from './attention-fixture.ts';

// D04-F: центр внимания работает до setup на той же базе, что и после него.

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-attention-')));

/** Каталог проекта без Git: подключение стоит на блокере `not-git-repository`. */
function plainDirectory(root: string) {
  writeFileSync(join(root, 'package.json'), '{"name":"app","private":true}\n');
}

/** Вопрос, редакция на согласовании и быстрое изменение с каталогом без Git. */
function seed(data: string, repository: string) {
  const store = preparationStore(data);
  try {
    const p = new Preparation(store);
    p.execute('preparation_create', { title: 'Модерация чата' });
    const status = p.status();
    if (!status.enabled) throw new Error('preparation');
    const changeId = status.activeChangeId!;
    p.execute('preparation_question', {
      changeId,
      stage: 'architecture',
      add: [{ text: 'Кто модерирует чат ночью?' }],
    });
    p.execute('preparation_product', {
      changeId,
      expectedDigest: null,
      reason: 'Постановка',
      content: product,
    });
    const view = p.status(changeId);
    if (!view.enabled) throw new Error('preparation');
    p.execute('preparation_submit', {
      changeId,
      stage: 'product',
      expectedDigest: view.current!.product!.digest,
    });
    p.execute('preparation_quick', {
      requestKey: 'attention-quick-1',
      title: 'Быстрая правка',
      repository,
      brief: 'Исправить сложение отрицательных чисел',
      criterion: 'add(-2, -3) возвращает -5',
    });
    return changeId;
  } finally {
    store.close();
  }
}

test('D04-F: до setup GET /api/attention показывает вопрос, согласование и стоящее подключение и ничего не пишет', () =>
  withTestHome(async () => {
    const workspace = temp();
    const repository = temp();
    plainDirectory(repository);
    const app = await startWorkspace(workspace, { port: 0, workspaceMode: 'separate' });
    try {
      const data = join(workspace, '.devcontour-local');
      const changeId = seed(data, repository);
      const get = async (query = '') => {
        const response = await fetch(app.url + '/api/attention' + query);
        assert.equal(response.status, 200);
        return (await response.json()) as AttentionView;
      };
      // Первое чтение прогревает кэш фактов: дальше сравниваем снимки.
      await get();
      const before = dumpDatabase(join(data, 'state.sqlite'));
      const stamps = fileStamps(data);
      const view = await get();
      const operator = await get('?actor=operator');
      assert.equal(dumpDatabase(join(data, 'state.sqlite')), before);
      assert.deepEqual(fileStamps(data), stamps);
      assert.equal(view.engineConnected, false);
      const question = view.items.find((i) => i.source === 'prep-question')!;
      assert.equal(question.actor, 'operator');
      assert.ok(question.actions.some((a) => a.id === 'answer'));
      assert.ok(byKey(view.items, `prep:stage:${changeId}:product`));
      const connection = view.items.find((i) => i.sourceKey.endsWith(':connection'))!;
      assert.equal(connection.source, 'quick');
      assert.equal(connection.category, 'access');
      assert.ok(operator.items.every((i) => i.actor === 'operator'));
      // Порядок: доступ раньше вопроса, вопрос раньше решения.
      const order = view.items.map((i) => i.category);
      assert.ok(order.indexOf('access') < order.indexOf('question'));
      assert.ok(order.indexOf('question') < order.indexOf('decision'));
      // Повторное чтение — те же карточки и версии.
      assert.deepEqual(
        (await get()).items.map((i) => [i.id, i.sourceVersion]),
        view.items.map((i) => [i.id, i.sourceVersion]),
      );
    } finally {
      await app.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(repository, { recursive: true, force: true });
    }
  }));

test('D04-F: после подключения движка к той же базе ключи и появления карточек подготовки те же', async () => {
  const root = temp();
  try {
    const path = join(root, 'state.sqlite');
    const bootstrap = new Store(path);
    let before: string[];
    try {
      const p = new Preparation(bootstrap);
      p.execute('preparation_create', { title: 'Модерация чата' });
      const status = p.status();
      if (!status.enabled) throw new Error('preparation');
      p.execute('preparation_question', {
        changeId: status.activeChangeId!,
        add: [{ text: 'Нужна ли история?' }],
      });
      before = (await new AttentionService(bootstrap, undefined).active()).items.map((i) => i.id);
    } finally {
      bootstrap.close();
    }
    const store = new Store(path);
    try {
      const h = new DevContour(store, config());
      const after = (await new AttentionService(store, h).active()).items
        .filter((i) => i.source.startsWith('prep-'))
        .map((i) => i.id);
      assert.deepEqual(after, before);
      assert.equal(before.length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
