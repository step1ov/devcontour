import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, input } from './helpers.ts';
import { digest } from '../src/core/service.ts';
import { Workspace, changeSnapshot, snapshotDigest } from '../src/core/workspace.ts';
import { authorOverview } from '../src/application/overview.ts';

// Сводка для автора: вопросы автора продукта, а не сущности контроллера.

test('Пустой workspace говорит, что разработка не началась, и ничего не требует', () => {
  const f = fixture();
  try {
    const o = authorOverview(f.h);
    assert.match(o.headline, /не началась/);
    assert.deepEqual(o.decisions, []);
    assert.equal(o.tryNow, undefined);
    assert.equal(o.preview.configured, false);
  } finally {
    f.cleanup();
  }
});

test('Отказ провайдера — внешний доступ, и он первым в заголовке', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.store.change('fixture.pause', (s) => {
      s.paused = true;
      s.pauseReason = 'runtime';
      s.pauseFailures = ['provider-auth'];
    });
    const o = authorOverview(f.h);
    assert.match(o.headline, /внешний доступ/);
    const access = o.decisions.find((d) => d.kind === 'access')!;
    assert.match(access.title, /провайдер/);
    assert.deepEqual(access.action, { type: 'resume-queue' });
    assert.match(o.activity.doing, /остановлена системой/);
  } finally {
    f.cleanup();
  }
});

test('Проверенное изменение: сначала попробовать в preview, затем принять', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const change = new Workspace(f.h).create({
      title: 'Каталог',
      description: 'Поиск по каталогу',
      boardIds: [b.id],
    });
    f.h.config.preview = {
      compose: 'main/c.yml',
      service: 'web',
      port: 45998,
      health: { path: '/health', timeoutMs: 1000 },
    };
    const manifest = { main: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) } };
    const verificationId = randomUUID();
    f.store.change('fixture.verified', (s) => {
      const cs = s.changeSets.find((x) => x.id === change.id)!;
      cs.verifications.push({
        id: verificationId,
        token: randomUUID(),
        leaseUntil: 0,
        startedAt: new Date().toISOString(),
        status: 'passed',
        policyDigest: new Workspace(f.h).policyDigest(),
        specDigest: snapshotDigest(changeSnapshot(s, cs)),
        tasks: [],
        boards: [],
        manifest,
        manifestDigest: digest(manifest),
        evidence: [],
      });
    });
    let o = authorOverview(f.h);
    let product = o.decisions.find((d) => d.kind === 'product')!;
    assert.match(product.title, /Каталог/);
    assert.deepEqual(product.action, { type: 'deploy-preview', changeSetId: change.id });
    assert.equal(o.tryNow, undefined);
    assert.equal(o.changes.find((c) => c.kind === 'changeset')!.status, 'verified');

    // Эта версия работает в preview: её можно открыть и принять.
    f.store.change('fixture.preview', (s) => {
      s.previews = [
        {
          id: randomUUID(),
          changeSetId: change.id,
          verificationId,
          manifestDigest: digest(manifest),
          policyDigest: 'p',
          release: 'r123',
          project: 'dc-x-r123',
          token: 't',
          leaseUntil: 0,
          status: 'unconfirmed',
          active: false,
          startedAt: new Date().toISOString(),
          url: 'http://127.0.0.1:45998',
        },
      ];
    });
    // Расходы: вызов без известной стоимости не превращается в ноль.
    f.store.atomic(() =>
      f.store.saveLocal('usage', undefined, 'u1', {
        id: 'u1',
        startedAt: new Date().toISOString(),
        outcome: 'succeeded',
        usage: { complete: false },
        costUsd: null,
        costSource: 'unknown',
      }),
    );
    o = authorOverview(f.h);
    assert.equal(o.tryNow?.url, 'http://127.0.0.1:45998');
    assert.equal(o.tryNow?.scenario, 'unconfirmed', 'сценарий не подтверждён — так и сказано');
    product = o.decisions.find((d) => d.kind === 'product')!;
    assert.deepEqual(product.action, { type: 'accept-changeset', changeSetId: change.id });
    assert.match(o.headline, /ваше решение/);
    assert.equal(o.spend.unknownCalls, 1);
    assert.equal(o.spend.complete, false);
  } finally {
    f.cleanup();
  }
});

test('Остановленное восстановление — техническое исправление, а не вопрос автору', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.store.atomic(() =>
      f.store.saveLocal('lead', undefined, 'k'.repeat(64), {
        key: 'k'.repeat(64),
        kind: 'board',
        id: b.id,
        stage: 1,
        status: 'failed',
        error: 'исчерпан бюджет автоматических восстановлений доски',
        attempts: 1,
        maxAttempts: 3,
        history: [],
      }),
    );
    const o = authorOverview(f.h);
    const technical = o.decisions.find((d) => d.kind === 'technical')!;
    assert.match(technical.detail, /бюджет/);
    assert.equal(technical.action, undefined, 'автору не предлагают чинить самому');
    assert.match(o.headline, /технической проблеме/);
  } finally {
    f.cleanup();
  }
});
