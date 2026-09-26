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

test('Повторная проверка того же кода не запирает автора на выкладке', () => {
  // Выкладка переиспользуется по manifest, и обзор должен узнавать её по нему
  // же — иначе после повторной проверки кнопка «выложить» не сменялась на
  // «принять», сколько её ни нажимай.
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
      port: 45997,
      health: { path: '/health', timeoutMs: 1000 },
    };
    const manifest = { main: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) } };
    const verification = () =>
      f.store.change('fixture.verified', (s) => {
        const cs = s.changeSets.find((x) => x.id === change.id)!;
        const id = randomUUID();
        cs.verifications.push({
          id,
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
        return id;
      });
    const first = verification();
    f.store.change('fixture.preview', (s) => {
      s.previews = [
        {
          id: randomUUID(),
          changeSetId: change.id,
          verificationId: first,
          manifestDigest: digest(manifest),
          policyDigest: 'p',
          release: 'r1',
          project: 'dc-x-r1',
          token: 't',
          leaseUntil: 0,
          status: 'confirmed',
          active: false,
          startedAt: new Date().toISOString(),
          url: 'http://127.0.0.1:45997',
        },
      ];
    });
    verification();
    const product = authorOverview(f.h).decisions.find((d) => d.kind === 'product')!;
    assert.deepEqual(product.action, { type: 'accept-changeset', changeSetId: change.id });
    assert.equal(product.evidence?.preview?.release, 'r1');
  } finally {
    f.cleanup();
  }
});

test('Упавшая задача без восстановления объяснена, отмена показана как отмена', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const failing = f.h.addTask(b.id, input('Сломанная задача'));
    f.h.addTask(b.id, input('Зависимая', [failing.id]));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    f.h.fail(run.id, run.token, 'candidate/test: Код выхода 1', false, 'gate');
    let o = authorOverview(f.h);
    const technical = o.decisions.find((d) => d.kind === 'technical')!;
    assert.match(technical.title, /Сломанная задача/);
    assert.match(technical.detail, /Код выхода 1/);
    assert.match(technical.detail, /Ждут её результата: 1/);
    assert.doesNotMatch(o.headline, /ведущий агент/, 'не утверждает работу, которой не видно');

    const other = f.h.createBoard('Cancelled board');
    const t = f.h.addTask(other.id, input('Отменённая'));
    f.store.change('fixture.cancel-all', (s) => {
      for (const x of s.tasks) x.status = 'cancelled';
    });
    void t;
    o = authorOverview(f.h);
    assert.match(o.headline, /отменена/);
    assert.equal(o.counts.cancelled, 3);
  } finally {
    f.cleanup();
  }
});

test('Упавший workflow, чья работа ушла дальше, не держит «нужен разбор»', () => {
  const f = fixture();
  try {
    const job = (key: string, id: string, status: string, startedAt: string) =>
      f.store.atomic(() =>
        f.store.saveLocal('lead', undefined, key.repeat(64), {
          key: key.repeat(64),
          kind: 'board',
          id,
          stage: 0,
          status,
          error:
            status === 'failed'
              ? 'Независимое ревью отклонено: план требует исправлений'
              : undefined,
          attempts: 1,
          maxAttempts: 3,
          startedAt,
          history: [],
        }),
      );
    // План перепланирован: вся работа прежней доски отменена.
    const old = f.h.createBoard('Прежний план');
    const dropped = f.h.addTask(old.id, input('Отменённая'));
    f.h.cancel(dropped.id);
    job('a', old.id, 'failed', '2026-09-26T08:00:00.000Z');
    // Та же доска получила новый workflow после исправления плана.
    const current = f.h.createBoard('Текущий план');
    f.h.addTask(current.id, input('Живая'));
    job('b', current.id, 'failed', '2026-09-26T08:10:00.000Z');
    job('c', current.id, 'running', '2026-09-26T08:20:00.000Z');
    let o = authorOverview(f.h);
    assert.equal(o.decisions.filter((d) => d.kind === 'technical').length, 0);
    assert.doesNotMatch(o.headline, /технической проблеме/);
    // Упавший последним — по-прежнему решение.
    job('d', current.id, 'failed', '2026-09-26T08:30:00.000Z');
    o = authorOverview(f.h);
    assert.equal(o.decisions.filter((d) => d.kind === 'technical').length, 1);
  } finally {
    f.cleanup();
  }
});
