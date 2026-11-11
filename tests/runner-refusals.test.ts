import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockedError } from '../src/core/model.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, reviewTransitions, type AgentRequest } from '../src/runner/adapters.ts';
import { git } from '../src/runner/process.ts';
import { input, reapprove } from './helpers.ts';
import { repositories } from '../src/core/repositories.ts';
import { runtimeFixture } from './runner-fixture.ts';

test('The scheduler classifies a refusal itself: a runtime that never ran refunds, one that worked does not', async () => {
  const f = await runtimeFixture();
  const refusing = (error: Error) => ({
    ...adapters,
    demo: {
      ...adapters.demo,
      name: 'demo' as const,
      execute: () => Promise.reject(error),
    },
  });
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const refused = f.h.addTask(board.id, input('Задача с отказом окружения'));
    f.h.approve(board.id);
    f.h.pause(false);

    // Отказ окружения приходит исключением из runtime — классифицирует его
    // scheduler, а не вызывающий. Тест, подставляющий флаг руками, прошёл бы
    // и с удалённой классификацией.
    const blocked = new Scheduler(f.h, f.root, refusing(new BlockedError('demo: Not logged in')));
    await blocked.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === refused.id)!.status, 'failed');
    assert.equal(f.store.read().tasks.find((t) => t.id === refused.id)!.attempt, 0);
    assert.equal(f.store.read().runs.at(-1)!.blocked, true);
    await blocked.stop();

    // Обычный сбой исполнителя попытку расходует.
    f.h.retry(refused.id);
    f.h.pause(false);
    const failing = new Scheduler(f.h, f.root, refusing(new Error('demo: не справился')));
    await failing.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === refused.id)!.attempt, 1);
    assert.equal(f.store.read().runs.at(-1)!.blocked, undefined);
    await failing.stop();
  } finally {
    await f.cleanup();
  }
});

test('A task runs its own scope of proof, not every gate the profile declares', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    // Гейт соседней, ещё не сделанной задачи. Раньше он ложился на любую
    // задачу компонента: параллельная декомпозиция не могла пройти, пока не
    // сделаны все соседи, хотя область доказательства у каждой своя.
    const failing = {
      id: 'sibling-tests',
      kind: 'test' as const,
      command: ['sh', '-c', 'exit 1'],
      timeoutMs: 60_000,
      report: { type: 'junit' as const, path: '.reports/junit.xml' },
      artifacts: [],
    };
    f.h.config.gates = [...f.h.config.gates, failing];
    f.h.config.repositories = [];

    const board = f.h.createBoard('Доска с областями');
    const own = f.h.config.gates.filter((g) => g.id !== failing.id).map((g) => g.id);
    const scoped = f.h.addTask(board.id, { ...input('Задача со своей областью'), gates: own });
    f.h.approve(board.id);
    f.h.pause(false);
    const scheduler = new Scheduler(f.h, f.root);
    await scheduler.drain();

    const done = f.store.read().tasks.find((t) => t.id === scoped.id)!;
    assert.equal(done.status, 'done', done.failure);
    const run = f.store.read().runs.find((r) => r.taskId === scoped.id)!;
    assert.ok(
      !run.evidence.some((e) => e.gate === failing.id),
      'чужой gate не должен выполняться в прогоне задачи',
    );
    await scheduler.stop();
  } finally {
    await f.cleanup();
  }
});

test('A refusal that will repeat on every task stops the queue instead of burning budgets', async () => {
  const f = await runtimeFixture();
  const refusing = (message: string) => ({
    ...adapters,
    demo: {
      ...adapters.demo,
      name: 'demo' as const,
      execute: () => Promise.reject(new Error(message)),
    },
  });
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const first = f.h.addTask(board.id, input('Первая задача'));
    const second = f.h.addTask(board.id, input('Вторая задача'));
    f.h.approve(board.id);
    f.h.pause(false);

    // Кончился лимит сессии провайдера: причина вне контура и одна для всех задач. Очередь,
    // которая продолжит перебор, сожжёт бюджет попыток каждой из них.
    const scheduler = new Scheduler(
      f.h,
      f.root,
      refusing(
        "demo: runtime завершился с кодом 1: You've hit your session limit · resets 2:40am (Europe/Moscow)",
      ),
    );
    await scheduler.drain();
    const state = f.store.read();
    assert.equal(state.paused, true, 'выдача остановлена');
    assert.equal(
      state.runs.filter((r) => r.taskId === second.id).length,
      0,
      'вторая задача не выдавалась',
    );
    // Провайдер задачу не пробовал: попытка возвращается.
    assert.equal(state.tasks.find((t) => t.id === first.id)!.attempt, 0);
    assert.equal(state.tasks.find((t) => t.id === first.id)!.failureKind, 'provider-auth');
    assert.equal(state.tasks.find((t) => t.id === second.id)!.attempt, 0);
    assert.match(
      (f.store.events().find((e) => e.type === 'scheduler.error')?.data as { error: string }).error,
      /session limit/,
    );
    await scheduler.stop();
  } finally {
    await f.cleanup();
  }
});

test('An empty candidate is refused before an independent review is spent on it', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const task = f.h.addTask(board.id, {
      ...input('Задача с областью записи'),
      writePaths: ['src'],
    });
    f.h.approve(board.id);
    f.h.pause(false);

    // Исполнитель отчитался «сделано», не изменив ни файла. Гейты на таком
    // кандидате зелены — они были зелены и до него, — а всю проверку принимает
    // на себя независимое ревью: пустой коммит стоил полного ревью, чтобы
    // услышать «diff пуст».
    let reviews = 0;
    const idle = {
      ...adapters,
      demo: {
        ...adapters.demo,
        name: 'demo' as const,
        execute: (request: AgentRequest) => {
          if (request.review) reviews++;
          return Promise.resolve({
            data: request.review
              ? { approved: true, summary: 'Нечего смотреть', findings: [], discoveries: [] }
              : { completed: true, summary: 'Всё уже готово', discoveries: [] },
            log: '',
            command: ['fixture'],
          });
        },
      },
    };
    const scheduler = new Scheduler(f.h, f.root, idle);
    await scheduler.drain();
    const failed = f.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(failed.status, 'failed');
    assert.match(failed.failure ?? '', /Изменений нет/);
    assert.equal(reviews, 0, 'ревью на пустом кандидате не запускается');
    await scheduler.stop();
  } finally {
    await f.cleanup();
  }
});

test('A retry is told where the previous review objected, not only that it did', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const task = f.h.addTask(board.id, input('Задача с замечанием'));
    f.h.approve(board.id);
    f.h.pause(false);

    const prompts: string[] = [];
    const runtimes = (approve: boolean) => ({
      ...adapters,
      demo: {
        ...adapters.demo,
        name: 'demo' as const,
        execute: async (request: AgentRequest) => {
          if (request.review) {
            prompts.push(request.prompt);
            return {
              data: {
                approved: approve,
                summary: 'Порядок выбора нарушен',
                discoveries: [],
                findings: approve
                  ? []
                  : [
                      {
                        severity: 'blocking',
                        message: 'Списки сохраняют порядок обхода: нужна канонизация',
                        path: 'src/assembly.ts',
                        line: 296,
                      },
                    ],
                // Повтор с исправлением закрывает выданную находку по её ID.
                previous: reviewTransitions(
                  request.findings,
                  approve,
                  approve ? 'Канонизация списков на месте' : 'Порядок обхода не канонизирован',
                ),
              },
              log: '',
              command: ['fixture'],
            };
          }
          prompts.push(request.prompt);
          return adapters.demo.execute(request);
        },
      },
    });
    const rejecting = new Scheduler(f.h, f.root, runtimes(false));
    await rejecting.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === task.id)!.status, 'failed');
    await rejecting.stop();

    // Следующая попытка получает саму находку — путь, строку и формулировку, а
    // не только «ревью отклонило». Без этого круг повторяется с тем же
    // замечанием, что и случилось на живом продукте дважды подряд.
    prompts.length = 0;
    f.h.retry(task.id);
    f.h.pause(false);
    const retrying = new Scheduler(f.h, f.root, runtimes(true));
    await retrying.drain();
    const implementation = prompts.find((p) => p.includes('Previous attempts'))!;
    assert.ok(implementation, 'попытка получает историю прошлых прогонов');
    assert.match(implementation, /нужна канонизация/);
    assert.match(implementation, /src\/assembly\.ts/);
    assert.match(implementation, /296/);
    // Находка получила ID controller и закрыта повторным ревью по этому ID с
    // основанием, а не забыта одобрением.
    const reviews = f.store
      .read()
      .runs.filter((r) => r.taskId === task.id)
      .flatMap((r) => r.evidence)
      .filter((e) => e.kind === 'review');
    const issued = reviews.flatMap((e) => e.findings ?? []).find((x) => x.id);
    assert.ok(issued?.id, 'находке выдан ID');
    assert.equal(issued.status, 'open');
    const closing = reviews.find((e) => e.passed)!;
    assert.equal(closing.reviewRound?.protocol, 'valid');
    assert.deepEqual(
      closing.reviewRound?.transitions?.map((t) => [t.id, t.from, t.to, t.basis]),
      [[issued.id, 'open', 'closed', 'Канонизация списков на месте']],
    );
    assert.equal(f.store.read().tasks.find((t) => t.id === task.id)!.status, 'done');
    await retrying.stop();
  } finally {
    await f.cleanup();
  }
});
test('Ответ ревьюера вне протокола находок — не замечание к коду; адаптер без протокола сохраняет прежнюю приёмку', async () => {
  const f = await runtimeFixture();
  try {
    const repo = repositories(f.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = f.h.createBoard('Доска');
    const task = f.h.addTask(board.id, input('Задача с находкой ревью'));
    f.h.approve(board.id);
    f.h.pause(false);
    let writes = 0;
    let reviews = 0;
    const runtimes = (
      verdict: (request: AgentRequest) => Record<string, unknown>,
      protocol: boolean,
    ) => ({
      ...adapters,
      demo: {
        name: 'demo' as const,
        ...(protocol ? { reviewProtocol: 1 as const } : {}),
        execute: async (request: AgentRequest) => {
          if (request.task?.id !== task.id) return adapters.demo.execute(request);
          if (!request.review) {
            writes++;
            return adapters.demo.execute(request);
          }
          reviews++;
          return {
            data: { summary: 'fixture', discoveries: [], ...verdict(request) },
            log: '',
            command: ['fixture'],
          };
        },
      },
    });
    const drain = async (runtime: ReturnType<typeof runtimes>) => {
      const scheduler = new Scheduler(f.h, f.root, runtime);
      await scheduler.drain();
      await scheduler.stop();
    };
    const current = () => f.store.read().tasks.find((t) => t.id === task.id)!;
    const evidenceOf = (attempt: number) =>
      f.store
        .read()
        .runs.filter((r) => r.taskId === task.id && r.attempt === attempt)
        .flatMap((r) => r.evidence)
        .filter((e) => e.kind === 'review');

    // Отказ по существу выдаёт находку с ID controller.
    await drain(
      runtimes(
        () => ({
          approved: false,
          findings: [{ severity: 'blocking', message: 'Нет обработки пустого ввода' }],
        }),
        true,
      ),
    );
    assert.equal(current().failureKind, 'review');
    const [issued] = evidenceOf(1).flatMap((e) => e.findings ?? []);
    assert.ok(issued?.id);

    // Одобрение, забывшее выданную находку, — ошибка протокола: ограниченный
    // повтор reviewer без нового writer, затем остановка без автоповтора.
    f.h.retry(task.id);
    f.h.pause(false);
    reviews = 0;
    writes = 0;
    await drain(runtimes(() => ({ approved: true, findings: [], previous: [] }), true));
    assert.equal(current().status, 'failed');
    assert.equal(current().failureKind, 'review-protocol');
    assert.match(current().failure ?? '', /REVIEW_PROTOCOL_INVALID/);
    assert.equal(reviews, 2, 'один дополнительный вызов reviewer');
    assert.equal(writes, 1, 'writer не вызывается ради повтора reviewer');
    const invalid = evidenceOf(2);
    assert.deepEqual(
      invalid.map((e) => [e.passed, e.reviewRound?.protocol, e.reviewRound?.call]),
      [
        [false, 'invalid', 1],
        [false, 'invalid', 2],
      ],
    );
    assert.ok(
      invalid.every((e) =>
        e.reviewRound?.issues?.some((i) => i.reason === 'missing' && i.path === 'previous'),
      ),
    );
    // Выдачу останавливает только остановка scheduler теста, не отказ.
    assert.equal(f.store.read().pauseReason, 'shutdown');
    assert.deepEqual(f.store.read().pauseFailures ?? [], [], 'выдача не останавливается отказом');

    // Адаптер без протокола (runtime хоста прежней версии): переходы не
    // требуются, одобрение принимается как в alpha.5, раунд помечен legacy.
    f.h.retry(task.id);
    f.h.pause(false);
    await drain(runtimes(() => ({ approved: true, findings: [] }), false));
    assert.equal(current().status, 'done', current().failure);
    const accepted = f.store
      .read()
      .runs.filter((r) => r.taskId === task.id)
      .flatMap((r) => r.evidence)
      .filter((e) => e.kind === 'review' && e.passed);
    assert.ok(accepted.length);
    assert.ok(accepted.every((e) => e.reviewRound?.mode === 'legacy'));
  } finally {
    await f.cleanup();
  }
});
test('Замечание ревью про HTTP 401 не останавливает выдачу как отказ провайдера', async () => {
  const f = await runtimeFixture();
  try {
    // Ревью говорит о поведении разрабатываемого приложения. Сам рантайм
    // отработал и вернул структурированный вердикт: внешнего отказа нет.
    // Разбор этого текста вторым проходом делал из замечания отказ провайдера
    // и останавливал очередь навсегда — повтор назначался и никогда не
    // выдавался, потому что класс review паузу снимать не вправе.
    const scheduler = new Scheduler(f.h, f.root, {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          if (r.review)
            return {
              data: {
                approved: false,
                summary: 'Missing handling for HTTP 401 Unauthorized in the client',
                findings: [
                  { severity: 'blocking', message: 'Unauthorized response is not handled' },
                ],
              },
              log: 'rejected',
              command: ['fixture-review'],
            };
          return adapters.demo.execute(r);
        },
      },
    });
    f.h.pause(false);
    await scheduler.drain();

    const state = f.store.read();
    const failed = state.tasks.find((t) => t.status === 'failed')!;
    assert.equal(failed.failureKind, 'review');
    assert.equal(state.paused, false, 'выдача продолжается: внешнего отказа не было');
    assert.deepEqual(state.pauseFailures ?? [], []);
  } finally {
    await f.cleanup();
  }
});
test('Провал проверки несёт свою причину: разные ошибки не считаются одной', async () => {
  // Полный вывод лежит в артефакте, но исполнителю следующей попытки он
  // недоступен, а в отказ попадало только «Код выхода 1». Два несвязанных
  // провала одной проверки выглядели одной причиной, и предел одинаковых
  // повторов исчерпывался впустую.
  const fingerprints: string[] = [];
  for (const marker of ['EXPECTED_TOTAL_WRONG', 'MISSING_REQUIRED_FIELD']) {
    const f = await runtimeFixture();
    try {
      f.h.config.gates[0].command = ['sh', '-c', `echo ${marker} >&2; exit 1`];
      reapprove(f.h);
      f.h.pause(false);
      await new Scheduler(f.h, f.root).drain();

      const failed = f.store.read().tasks.find((t) => t.status === 'failed')!;
      assert.match(failed.failure!, new RegExp(marker), 'причина названа в отказе');
      const run = f.store.read().runs.findLast((r) => r.taskId === failed.id)!;
      assert.match(
        run.evidence.find((e) => !e.passed)!.summary,
        new RegExp(marker),
        'причина доходит до подсказки следующей попытки через evidence',
      );
      fingerprints.push(failed.failureFingerprint!);
    } finally {
      await f.cleanup();
    }
  }
  assert.notEqual(fingerprints[0], fingerprints[1], 'разные причины — разные отпечатки');
});
test('Текст провала из отчёта проходит тот же redact, что и вывод команды', async () => {
  // Отчёт пишет раннер, и секрет попадает туда так же легко, как в вывод:
  // в сообщение провала, в том числе на границе обрезки, и в имя testcase.
  const f = await runtimeFixture();
  const secret = 'gate-secret-value-7310-abcdefgh';
  process.env.DEVCONTOUR_TEST_GATE_SECRET = secret;
  try {
    f.h.config.environment = {
      inherit: [],
      values: {},
      secrets: { GATE_TOKEN: 'DEVCONTOUR_TEST_GATE_SECRET' },
    };
    f.h.config.gates[0].command = [
      process.execPath,
      '-e',
      `const t=process.env.GATE_TOKEN;require('fs').mkdirSync('.reports',{recursive:true});require('fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase classname="auth" name="LEAKS_TOKEN"><failure message="'+'p'.repeat(184)+t+'"/></testcase><testcase name="case-'+t+'"><failure message="named"/></testcase></testsuite>');process.exit(1)`,
    ];
    f.h.config.gates[0].report = { type: 'junit', path: '.reports/unit.xml' };
    reapprove(f.h);
    f.h.pause(false);
    await new Scheduler(f.h, f.root).drain();
    const failed = f.store.read().tasks.find((t) => t.status === 'failed')!;
    const run = f.store.read().runs.findLast((r) => r.taskId === failed.id)!;
    const evidence = run.evidence.find((e) => !e.passed)!;
    assert.match(evidence.summary, /LEAKS_TOKEN/, 'причина из отчёта дошла');
    assert.ok(evidence.tests?.length, 'манифест упавшей проверки записан');
    // Ни целиком, ни префиксом — ни в сводке, ни в манифесте, ни в отказе.
    const stored = JSON.stringify(f.store.read());
    for (const piece of [secret, secret.slice(0, 12)])
      assert.ok(!stored.includes(piece), `в состоянии нет «${piece}»`);
  } finally {
    delete process.env.DEVCONTOUR_TEST_GATE_SECRET;
    await f.cleanup();
  }
});
