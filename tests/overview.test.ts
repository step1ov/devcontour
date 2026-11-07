import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, input } from './helpers.ts';
import { digest } from '../src/core/service.ts';
import { Workspace, changeSnapshot, snapshotDigest } from '../src/core/workspace.ts';
import { authorOverview } from '../src/application/overview.ts';
import { AttentionService } from '../src/application/attention.ts';
import { headlineOf } from '../src/web/attention-logic.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';

// Сводка для автора: вопросы автора продукта, а не сущности контроллера.
// Решения автора и ведущего — карточки центра внимания: сводка их больше не
// перечисляет, панель показывает голову очереди и дополняет заголовок.

type Fixture = ReturnType<typeof fixture>;
const attention = async (f: Fixture) => (await new AttentionService(f.store, f.h).active()).items;
const domainIds = (item: { actions: { kind: string; id: string }[] } | undefined) =>
  (item?.actions ?? []).filter((a) => a.kind === 'domain').map((a) => a.id);

test('Пустой workspace говорит, что разработка не началась, и ничего не требует', async () => {
  const f = fixture();
  try {
    const o = authorOverview(f.h);
    assert.match(o.headline, /не началась/);
    assert.equal('decisions' in o, false, 'решения — в центре внимания');
    const items = await attention(f);
    assert.deepEqual(
      items.filter((i) => i.actor === 'operator'),
      [],
    );
    assert.match(headlineOf(o, items), /не началась/);
    assert.equal(o.tryNow, undefined);
    assert.equal(o.preview.configured, false);
  } finally {
    f.cleanup();
  }
});

test('Отказ провайдера — внешний доступ, и он первым в заголовке', async () => {
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
    const items = await attention(f);
    assert.match(headlineOf(o, items), /внешний доступ/);
    const access = items.find((i) => i.category === 'access')!;
    assert.equal(access.actor, 'operator');
    assert.match(access.title, /доступ/);
    assert.deepEqual(domainIds(access), ['resume']);
    assert.match(o.activity.doing, /остановлена системой/);
  } finally {
    f.cleanup();
  }
});

test('Проверенное изменение: сначала попробовать в preview, затем принять', async () => {
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
        finishedAt: new Date().toISOString(),
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
    let items = await attention(f);
    let product = items.find((i) => i.sourceKey === `changeset:${change.id}`)!;
    assert.match(product.title, /Каталог/);
    assert.equal(product.actor, 'operator');
    assert.deepEqual(domainIds(product), ['deploy-preview', 'accept']);
    assert.match(product.subject.href, new RegExp(`#changeset-${change.id}$`));
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
    items = await attention(f);
    product = items.find((i) => i.sourceKey === `changeset:${change.id}`)!;
    assert.deepEqual(domainIds(product), ['accept']);
    assert.match(o.headline, /попробовать/, 'сводка без решений');
    assert.match(headlineOf(o, items), /ваше решение по готовому изменению/);
    assert.equal(o.spend.unknownCalls, 1);
    assert.equal(o.spend.complete, false);
  } finally {
    f.cleanup();
  }
});

test('Остановленное восстановление — техническое исправление, а не вопрос автору', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    flow.fail(
      flow.claim(job.key, job.owner)!,
      'исчерпан бюджет автоматических восстановлений доски',
    );
    const o = authorOverview(f.h);
    const items = await attention(f);
    const technical = items.find((i) => i.sourceKey === `board:${b.id}`)!;
    assert.equal(technical.actor, 'lead');
    assert.equal(technical.category, 'technical');
    assert.deepEqual(domainIds(technical), [], 'автору не предлагают чинить самому');
    assert.ok(technical.actions.some((a) => a.kind === 'handoff'));
    assert.match(headlineOf(o, [technical]), /технической проблеме — разбирает ведущий агент/);
  } finally {
    f.cleanup();
  }
});

test('Повторная проверка того же кода не запирает автора на выкладке', async () => {
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
          finishedAt: new Date().toISOString(),
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
    const product = (await attention(f)).find((i) => i.sourceKey === `changeset:${change.id}`)!;
    assert.deepEqual(domainIds(product), ['accept']);
    assert.match(product.reason, /работает в preview/);
  } finally {
    f.cleanup();
  }
});

test('Упавшая задача без восстановления объяснена, отмена показана как отмена', async () => {
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
    // Упавшая задача — карточка задачи с прогнозом восстановления (S10):
    // одна карточка, зависимая задача — её влияние, а не своя карточка.
    const items = await attention(f);
    const technical = items.find((i) => i.sourceKey === `work:${failing.id}`)!;
    assert.match(technical.title, /Сломанная задача/);
    assert.match(technical.reason, /Код выхода 1/);
    assert.equal(technical.impact.waiting, 1);
    assert.equal(items.filter((i) => i.title.includes('Зависимая')).length, 0);
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

test('Упавший workflow, чья работа ушла дальше, не держит «нужен разбор»', async () => {
  const f = fixture();
  try {
    const flow = new LeadWorkflow(f.h);
    const failed = (id: string, error: string) => {
      const job = flow.start({ kind: 'board', id, authorRuntime: 'codex', maxAttempts: 3 });
      flow.fail(flow.claim(job.key, job.owner)!, error);
      return job;
    };
    // План перепланирован: вся работа прежней доски отменена.
    const old = f.h.createBoard('Прежний план');
    const dropped = f.h.addTask(old.id, input('Отменённая'));
    f.h.cancel(dropped.id);
    failed(old.id, 'Независимое ревью отклонено: план требует исправлений');
    // Та же доска получила новое задание после исправления плана.
    const current = f.h.createBoard('Текущий план');
    f.h.addTask(current.id, input('Живая'));
    const job = failed(current.id, 'Независимое ревью отклонено: план требует исправлений');
    flow.retry(job.key, job.owner);
    const boardCards = async () =>
      (await attention(f)).filter((i) => i.sourceKey.startsWith('board:'));
    assert.deepEqual(await boardCards(), []);
    assert.doesNotMatch(
      headlineOf(authorOverview(f.h), await attention(f)),
      /технической проблеме/,
    );
    // Упавший последним — по-прежнему решение ведущего.
    flow.fail(flow.claim(job.key, job.owner)!, 'Независимое ревью отклонено снова');
    const one = await boardCards();
    assert.deepEqual(
      one.map((i) => [i.sourceKey, i.actor]),
      [[`board:${current.id}`, 'lead']],
    );
    // Упал и следующий — карточка одна, по последнему; прежний отказ — история.
    flow.retry(job.key, job.owner);
    flow.fail(flow.claim(job.key, job.owner)!, 'И ещё раз');
    const again = await boardCards();
    assert.equal(again.length, 1);
    assert.notEqual(again[0].occurrenceId, one[0].occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('Доска с неутверждённым планом в «Что изменилось» — план, а не работа', () => {
  const f = fixture();
  try {
    const drafts = f.h.createBoard('Находки');
    f.h.addTask(drafts.id, input('Черновик'));
    const working = f.h.createBoard('Этап');
    f.h.addTask(working.id, input('Утверждённая'));
    f.h.approve(working.id);
    const status = (title: string) =>
      authorOverview(f.h).changes.find((c) => c.title === title)?.status;
    assert.equal(status('Находки'), 'planned');
    assert.equal(status('Этап'), 'in-progress');
  } finally {
    f.cleanup();
  }
});
