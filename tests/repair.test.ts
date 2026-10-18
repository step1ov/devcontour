import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import type { FailureKind } from '../src/core/failure.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Довести задачу до падения с заданным классом и вернуть её id. */
function breakTask(h: DevContour, taskId: string, kind: FailureKind, message: string) {
  h.pause(false);
  const run = h.claim('test')!;
  assert.equal(run.taskId, taskId);
  h.fail(run.id, run.token, message, false, kind);
  return run;
}

test('Ведущий цикл чинит упавшую задачу сам и учитывает это в одной транзакции', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, t.id, 'gate', 'candidate/typecheck: ошибка');

    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    const claimed = flow.claim(job.key, job.owner)!;
    // Вторая стадия: план уже проверен, задачи исполняются.
    f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
    const running = flow.get(job.key, job.owner);

    const runner = new LeadRunner(f.h, f.root);
    const waiting = await runner.execute(running, new AbortController().signal);

    assert.equal(waiting, true, 'цикл ждёт результата назначенного повтора');
    assert.equal(f.store.read().tasks[0].status, 'ready');
    assert.equal(f.store.read().tasks[0].failure, undefined);
    assert.equal(flow.get(job.key, job.owner).repairs, 1);
    assert.ok(
      flow.get(job.key, job.owner).history.some((h) => h.event === 'repair:gate'),
      'решение видно в истории работы',
    );

    // Так стадию завершает настоящий цикл: ожидание возвращает попытку стадии
    // и снимает запись о захвате. Снять при этом решение о восстановлении
    // значило бы стереть единственный след того, что цикл сделал сам.
    flow.finish(running, waiting);
    const after = flow.get(job.key, job.owner);
    assert.equal(after.stage, 1, 'ожидание не продвигает стадию');
    assert.equal(after.attempts, 0, 'ожидание не тратит попытку стадии');
    assert.deepEqual(
      after.history.map((h) => h.event),
      ['repair:gate'],
    );
    assert.equal(after.repairs, 1);
  } finally {
    f.cleanup();
  }
});

test('Исчерпанный класс останавливает работу с причиной, которую видит человек', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, t.id, 'provider-auth', 'Credit balance too low');

    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    const claimed = flow.claim(job.key, job.owner)!;
    f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
    const running = flow.get(job.key, job.owner);

    const runner = new LeadRunner(f.h, f.root);
    await assert.rejects(
      () => runner.execute(running, new AbortController().signal),
      /кредитов|авторизован/,
    );
    // Задача осталась упавшей: остановка не маскирует причину сменой статуса.
    assert.equal(f.store.read().tasks[0].status, 'failed');
    assert.equal(flow.get(job.key, job.owner).repairs, undefined);
  } finally {
    f.cleanup();
  }
});

test('Восстановление снимает только свою паузу выдачи', async () => {
  // Очередь общая на весь workspace. Снять чужую паузу значит выдать работу
  // под ту самую причину, из-за которой выдача и остановлена: пауза человека —
  // его решение, а пауза от отказа провайдера по соседней доске стоит денег.
  for (const [reason, failures, expected] of [
    ['runtime', ['environment'], false],
    ['runtime', ['provider-auth'], true],
    // Обе очерёдности прихода: более строгая причина не теряется за уже
    // стоящей паузой, и починка обрыва связи её не снимает.
    ['runtime', ['environment', 'provider-auth'], true],
    ['runtime', ['provider-auth', 'environment'], true],
    ['operator', undefined, true],
  ] as const) {
    const f = fixture();
    try {
      const b = f.h.createBoard('Board');
      const t = f.h.addTask(b.id, input());
      f.h.approve(b.id);
      breakTask(f.h, t.id, 'environment', 'runtime: транспорт оборван');
      // Выдача остановлена: одной причиной — сам рантайм, другой — человек.
      f.store.change('test.pause', (s) => {
        s.paused = true;
        s.pauseReason = reason;
        s.pauseFailures = failures ? [...failures] : undefined;
        return {};
      });

      const flow = new LeadWorkflow(f.h);
      const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
      const claimed = flow.claim(job.key, job.owner)!;
      f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));

      const runner = new LeadRunner(f.h, f.root);
      await runner.execute(flow.get(job.key, job.owner), new AbortController().signal);

      assert.equal(f.store.read().tasks[0].status, 'ready', 'повтор назначается всегда');
      // Починенная причина уходит из списка, даже когда пауза остаётся.
      if (reason === 'runtime')
        assert.equal(
          (f.store.read().pauseFailures ?? []).includes('environment'),
          false,
          'своя причина снята',
        );
      assert.equal(
        f.store.read().paused,
        expected,
        `пауза ${reason}/${failures?.join('+') ?? '—'} ${expected ? 'должна остаться' : 'должна быть снята'}`,
      );
    } finally {
      f.cleanup();
    }
  }
});

test('Бюджет восстановлений тратится накопительно и останавливает цикл сам', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 5 });
    const runner = new LeadRunner(f.h, f.root);
    const stage = () => {
      const claimed = flow.claim(job.key, job.owner)!;
      f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
      return flow.get(job.key, job.owner);
    };

    // Бюджет доски — 6 по умолчанию. Каждое восстановление тратит ровно один,
    // и счётчик обязан накапливаться: реализация, выставляющая единицу, дошла
    // бы до бесконечности.
    // Причины намеренно разные по тексту: одинаковые остановил бы предел
    // повторов класса, а проверяется здесь именно бюджет доски. Числами их
    // различить нельзя — отпечаток числа нормализует.
    const causes = ['typecheck', 'lint', 'unit', 'contract', 'build', 'smoke'];
    for (let i = 1; i <= causes.length; i++) {
      breakTask(f.h, t.id, 'gate', `candidate/${causes[i - 1]}: проверка не прошла`);
      const running = stage();
      assert.equal(await runner.execute(running, new AbortController().signal), true);
      flow.finish(running, true);
      assert.equal(flow.get(job.key, job.owner).repairs, i, `восстановление ${i} учтено`);
      f.store.change('test.attempts', (s) => {
        s.tasks[0].attempt = 0;
        return {};
      });
    }

    // Седьмой отказ бюджета не находит и останавливает работу с этой причиной.
    breakTask(f.h, t.id, 'gate', 'candidate/e2e: проверка не прошла');
    await assert.rejects(
      () => runner.execute(stage(), new AbortController().signal),
      /бюджет автоматических восстановлений/,
    );
    assert.equal(flow.get(job.key, job.owner).repairs, 6, 'остановка бюджет не тратит');
  } finally {
    f.cleanup();
  }
});

test('Сорванное восстановление не оставляет ни учёта без повтора, ни повтора без учёта', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, t.id, 'gate', 'candidate/typecheck: ошибка');
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    const running = flow.claim(job.key, job.owner)!;

    assert.throws(
      () =>
        flow.repair(running, 'repair:gate', () => {
          f.h.retry(t.id);
          throw new Error('Прерывание между решением и его исполнением');
        }),
      /Прерывание/,
    );
    // Счётчик и повтор либо оба состоялись, либо ни один.
    assert.equal(flow.get(job.key, job.owner).repairs, undefined);
    assert.equal(f.store.read().tasks[0].status, 'failed');
  } finally {
    f.cleanup();
  }
});

test('Пауза оператора переживает и восстановление, и следующий шаг стадии', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    breakTask(f.h, t.id, 'gate', 'candidate/typecheck: ошибка');

    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 5 });
    const runner = new LeadRunner(f.h, f.root);
    const stage = () => {
      const claimed = flow.claim(job.key, job.owner)!;
      f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
      return flow.get(job.key, job.owner);
    };

    // Человек останавливает выдачу уже после регистрации работы.
    f.h.pause(true);
    const first = stage();
    assert.equal(await runner.execute(first, new AbortController().signal), true);
    flow.finish(first, true);
    assert.equal(f.store.read().paused, true, 'восстановление паузу не снимает');

    // Следующий шаг той же стадии снимал её безусловно: разрешение начать
    // работу однажды не должно отменять все будущие остановки.
    const second = stage();
    flow.finish(second, await runner.execute(second, new AbortController().signal));
    assert.equal(f.store.read().paused, true, 'шаг стадии паузу не снимает');
    assert.equal(f.store.read().pauseReason, 'operator');

    // Штатная остановка сервера — не решение о работе, её цикл снимает сам.
    f.h.pause(false);
    f.h.pause(true, 'shutdown');
    const third = stage();
    flow.finish(third, await runner.execute(third, new AbortController().signal));
    assert.equal(f.store.read().paused, false, 'остановка сервера выдачу не держит');
  } finally {
    f.cleanup();
  }
});

/** Записать состояние в обход Store — так, как его оставила прежняя версия. */
function writeLegacy(path: string, patch: (raw: any) => void) {
  const db = new DatabaseSync(path);
  try {
    const raw = JSON.parse(
      (db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string }).data,
    );
    patch(raw);
    db.prepare('UPDATE main.state SET data=? WHERE id=1').run(JSON.stringify(raw));
  } finally {
    db.close();
  }
}

test('Обновление не снимает паузу, записанную прежней версией', async () => {
  // Прежняя версия хранила одну причину в pauseFailure, а пауза человека —
  // без времени. Новый код, не прочитав их, видел пустой список блокировок и
  // «раннюю» паузу — и выдавал работу вопреки отказу провайдера и человеку.
  for (const legacy of [
    { pauseReason: 'runtime', pauseFailure: 'provider-auth' },
    { pauseReason: 'runtime' },
  ]) {
    const f = fixture();
    let store: Store | undefined;
    try {
      const a = f.h.createBoard('Board A');
      const t = f.h.addTask(a.id, input());
      f.h.approve(a.id);
      const b = f.h.createBoard('Board B');
      f.h.addTask(b.id, input('Вторая'));
      breakTask(f.h, t.id, 'environment', 'runtime: транспорт оборван');
      const flow = new LeadWorkflow(f.h);
      const job = flow.start({ kind: 'board', id: a.id, authorRuntime: 'codex', maxAttempts: 3 });
      const claimed = flow.claim(job.key, job.owner)!;
      f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
      f.store.close();
      writeLegacy(join(f.root, 'state.sqlite'), (raw) => {
        raw.paused = true;
        delete raw.pausedAt;
        delete raw.pauseFailures;
        Object.assign(raw, legacy);
      });

      store = new Store(join(f.root, 'state.sqlite'));
      const h = new DevContour(store, f.h.config);
      const runner = new LeadRunner(h, f.root);
      const reflow = new LeadWorkflow(h);
      await runner.execute(reflow.get(job.key, job.owner), new AbortController().signal);

      const label = JSON.stringify(legacy);
      assert.equal(store.read().tasks[0].status, 'ready', `${label}: повтор назначен`);
      assert.equal(store.read().paused, true, `${label}: пауза пережила обновление`);
      assert.equal(store.read().pauseReason, legacy.pauseReason);
      // Старая причина сохранена; пауза без записанной причины помечена
      // неизвестной — её не снимает ни одно восстановление.
      assert.deepEqual(
        store.read().pauseFailures,
        legacy.pauseFailure ? ['provider-auth'] : ['unknown'],
        `${label}: причина сохранена`,
      );
      // Явное решение человека по-прежнему снимает паузу.
      h.pause(false);
      assert.equal(store.read().paused, false, `${label}: явное продолжение работает`);
    } finally {
      store?.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('Прежняя причина паузы переносится и в component storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-legacy-'));
  try {
    for (const id of ['app', 'lib']) mkdirSync(join(root, id));
    const locations = ['app', 'lib'].map((id) => ({ id, path: join(root, id) }));
    const path = join(root, 'coordinator', 'state.sqlite');
    new Store(path, locations).close();
    // Смешанное состояние: старое поле рядом с новым списком, одна причина
    // повторяется. Список объединяется без повторов.
    writeLegacy(path, (raw) => {
      raw.paused = true;
      raw.pauseReason = 'runtime';
      raw.pauseFailure = 'provider-auth';
      raw.pauseFailures = ['environment', 'provider-auth'];
    });
    const store = new Store(path, locations);
    try {
      const s = store.read();
      assert.deepEqual(s.pauseFailures, ['environment', 'provider-auth']);
      assert.equal((s as { pauseFailure?: unknown }).pauseFailure, undefined);
      // Идемпотентно: запись нормализованного состояния и повторное чтение
      // ничего не добавляют.
      store.change('test.touch', (state) => {
        state.sequence += 1;
        return {};
      });
      assert.deepEqual(store.read().pauseFailures, ['environment', 'provider-auth']);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Пауза человека без времени не снимается стадией выдачи', async () => {
  // Прежняя версия не записывала время паузы. Сравнение с началом работы
  // принимало такую паузу за «раньше регистрации» и снимало её.
  const f = fixture();
  let store: Store | undefined;
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    const claimed = flow.claim(job.key, job.owner)!;
    f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
    f.store.close();
    writeLegacy(join(f.root, 'state.sqlite'), (raw) => {
      raw.paused = true;
      raw.pauseReason = 'operator';
      delete raw.pausedAt;
    });

    store = new Store(join(f.root, 'state.sqlite'));
    const h = new DevContour(store, f.h.config);
    await new LeadRunner(h, f.root).execute(
      new LeadWorkflow(h).get(job.key, job.owner),
      new AbortController().signal,
    );
    assert.equal(store.read().paused, true, 'пауза человека стоит до явного продолжения');
    h.pause(false);
    assert.equal(store.read().paused, false);
  } finally {
    store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
