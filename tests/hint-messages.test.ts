// Тексты шага DevContour пакета передачи (`host.next.detail`) по языку
// подсказок: у каждого кода есть русский текст, команды, JSON и id в нём — как
// в английском; без `hintLocale` тексты прежние.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { config, fixture, input } from './helpers.ts';
import { DevContour } from '../src/core/service.ts';
import { configSchema, DomainError } from '../src/core/model.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import {
  devcontourHandoff,
  handoffHostCommands,
  handoffHostCommandsByLocale,
  handoffResponse,
} from '../src/application/handoff.ts';
import { reviewContract, reviewPlan } from '../src/runner/agent-control.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import { approvalPolicyDigest } from '../src/harness/policy.ts';
import { profile } from '../src/runner/packs.ts';
import { projectConfig } from '../src/runner/setup.ts';
import type { LoopOutlook } from '../src/runner/lead-outlook.ts';
import {
  hintCatalogs,
  hintDetail,
  hintLocaleOf,
  hintLocales,
  reviewLanguageInstructions,
  type HintCode,
  type HintOf,
  type HintSubject,
} from '../src/application/hint-messages.ts';

const job = { key: 'job-key-1', repositoryId: 'api', status: 'failed', stage: 1, maxAttempts: 3 };
const stops = { count: 4, limit: 2, exhausted: true };
const input1 = { requestId: 'req-42', taskId: 'task-7' };
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

/** Все шаги цикла задания. */
const loops: LoopOutlook[] = [
  { step: 'review-plan' },
  { step: 'advance' },
  { step: 'recovery', taskId: 't-1', action: 'analyze' },
  { step: 'repair', taskId: 't-1', reason: 'gate' },
  { step: 'stop', taskId: 't-1', reason: 'REPAIR_BUDGET' },
  { step: 'check-base' },
  { step: 'lift-pause', pause: 'reconfigure' },
  { step: 'wait' },
  { step: 'accept' },
  { step: 'none' },
];

/** Шаг каждого кода с параметрами и полями, которые его текст читает. */
const samples: { [C in HintCode]: (HintSubject & Extract<HintOf, { code: C }>)[] } = {
  operator: [{ code: 'operator', params: {} }],
  'plan-unapproved': [
    {
      code: 'plan-unapproved',
      params: { scope: 2 },
      boardId: 'board-1',
      plan: {
        drafts: ['t-1', 't-2'],
        stale: [],
        review: ['t-1'],
        reviewCount: 1,
        unverified: ['t-2'],
        unverifiedCount: 1,
        blocked: [{ id: 't-3', reason: 'no gates' }],
        blockedCount: 1,
      },
    },
    {
      code: 'plan-unapproved',
      params: { scope: 25 },
      boardId: 'board-1',
      plan: {
        drafts: many('d', 24),
        stale: ['s-0'],
        review: many('d', 20),
        reviewCount: 25,
        unverified: [],
        unverifiedCount: 0,
        blocked: [],
        blockedCount: 0,
      },
    },
    {
      code: 'plan-unapproved',
      params: { scope: 30 },
      boardId: 'board-1',
      plan: {
        drafts: many('d', 30),
        stale: [],
        review: many('d', 20),
        reviewCount: 22,
        unverified: many('u', 20),
        unverifiedCount: 23,
        blocked: [],
        blockedCount: 0,
      },
    },
    {
      code: 'plan-unapproved',
      params: { scope: 1 },
      boardId: 'board-1',
      plan: {
        drafts: ['t-1'],
        stale: [],
        review: [],
        reviewCount: 0,
        unverified: ['t-1'],
        unverifiedCount: 1,
        blocked: [],
        blockedCount: 0,
      },
    },
  ],
  'job-stops': [
    {
      code: 'job-stops',
      params: { stage: 1 },
      boardId: 'board-1',
      job,
      loop: { step: 'stop', taskId: 't-1', reason: 'REPAIR_BUDGET' },
    },
  ],
  // Каждый шаг цикла (`loopEn`, `loopRu`) — через шаг ожидания задания.
  'job-live': loops.map((loop) => ({
    code: 'job-live' as const,
    params: { stage: 1 },
    boardId: 'board-1',
    job: { ...job, status: 'running' },
    loop,
  })),
  'input-refused': [
    { code: 'input-refused', params: { reason: 'нет референсов' }, boardId: 'board-1' },
  ],
  'job-retry-stops': [
    {
      code: 'job-retry-stops',
      params: { error: 'boom' },
      boardId: 'board-1',
      job,
      loop: { step: 'stop', reason: 'TERMINAL' },
    },
  ],
  'job-cancelled-task': [
    ...(['host', 'operator', 'graph', 'unknown'] as const).flatMap((by) =>
      [true, false].flatMap((budget) =>
        [false, true].map((live) => ({
          code: 'job-cancelled-task' as const,
          params: {
            taskId: 't-1',
            by,
            budget,
            live,
            ...(live ? {} : { error: 'boom' }),
          },
          boardId: 'board-1',
          job,
          loop: { step: 'stop' as const, taskId: 't-1', reason: 'cancelled' },
        })),
      ),
    ),
    // Все задачи ревизии отменены: второй путь — новая ревизия доски.
    // Хост без бюджета — четвёртая фраза о владельце решения.
    ...(
      [
        ['host', true],
        ['operator', false],
        ['host', false],
      ] as const
    ).map(([by, budget]) => ({
      code: 'job-cancelled-task' as const,
      params: {
        taskId: 't-1',
        by,
        budget,
        live: false,
        allCancelled: true as const,
        error: 'boom',
      },
      boardId: 'board-1',
      job,
      loop: { step: 'stop' as const, taskId: 't-1', reason: 'cancelled' },
    })),
  ],
  'job-retry': [
    {
      code: 'job-retry',
      params: { error: 'boom' },
      boardId: 'board-1',
      job,
      loop: { step: 'review-plan' },
    },
    {
      code: 'job-retry',
      params: {},
      boardId: 'board-1',
      job: { ...job, repositoryId: undefined },
      loop: { step: 'lift-pause', pause: 'shutdown' },
    },
  ],
  'job-exhausted': [
    {
      code: 'job-exhausted',
      params: {},
      boardId: 'board-1',
      job: { ...job, repositoryId: undefined },
    },
    { code: 'job-exhausted', params: { error: 'boom' }, boardId: 'board-1', job },
  ],
  'job-settled': [
    { code: 'job-settled', params: {}, boardId: 'board-1', job: { ...job, status: 'stale' } },
    { code: 'job-settled', params: {}, boardId: 'board-1', job: { ...job, status: 'completed' } },
  ],
  'job-idle': [{ code: 'job-idle', params: {}, boardId: 'board-1', job }],
  'board-start': [
    { code: 'board-start', params: { running: true }, boardId: 'board-1', job },
    { code: 'board-start', params: { running: false }, boardId: 'board-1' },
  ],
  'pause-lift': [
    {
      code: 'pause-lift',
      params: { pause: 'initial', stage: 1 },
      boardId: 'board-1',
      job,
      loop: { step: 'lift-pause', pause: 'initial' },
    },
    {
      code: 'pause-lift',
      params: { pause: 'operator', stage: 1 },
      boardId: 'board-1',
      job,
      loop: { step: 'check-base' },
    },
  ],
  'pause-operator': [
    { code: 'pause-operator', params: {} },
    { code: 'pause-operator', params: {}, boardId: 'board-1', job, loop: { step: 'accept' } },
    { code: 'pause-operator', params: { by: 'lead' } },
    {
      code: 'pause-operator',
      params: { by: 'lead' },
      boardId: 'board-1',
      job,
      loop: { step: 'accept' },
    },
  ],
  'base-held': [
    { code: 'base-held', params: { paths: [] } },
    {
      code: 'base-held',
      params: { paths: ['main:verify.mjs', 'main:docs/contracts/api.md'] },
      boardId: 'board-1',
      job,
    },
  ],
  'follow-up': [{ code: 'follow-up', params: { severity: 5, version: 3 }, input: input1 }],
  'answer-lead': [
    { code: 'answer-lead', params: { version: 2 }, input: input1 },
    { code: 'answer-lead', params: { version: 2, stops }, input: input1 },
  ],
  'answer-operator': [
    { code: 'answer-operator', params: { floors: ['security', 'data'] }, input: input1 },
    { code: 'answer-operator', params: { floors: [], stops }, input: input1 },
    {
      code: 'answer-operator',
      params: { floors: ['declared'], version: 3, proposed: false },
      input: input1,
    },
    {
      code: 'answer-operator',
      params: { floors: ['declared'], version: 3, proposed: true },
      input: input1,
    },
  ],
  'apply-stale': [
    { code: 'apply-stale', params: { reason: 'context', operator: true }, input: input1 },
    { code: 'apply-stale', params: { reason: 'base', operator: false, stops }, input: input1 },
  ],
  'apply-rejected': [
    { code: 'apply-rejected', params: { operator: true }, input: input1 },
    { code: 'apply-rejected', params: { operator: false }, input: input1 },
    {
      code: 'apply-rejected',
      params: { operator: false, operatorAnswers: true, proposed: false },
      input: input1,
    },
    {
      code: 'apply-rejected',
      params: { operator: true, operatorAnswers: true, proposed: true },
      input: input1,
    },
  ],
  'apply-claim': [
    { code: 'apply-claim', params: { stops: { ...stops, exhausted: false } }, input: input1 },
  ],
  'apply-saved': [
    { code: 'apply-saved', params: { state: 'answered', operator: false }, input: input1 },
    { code: 'apply-saved', params: { state: 'reviewed', operator: true }, input: input1 },
  ],
  'apply-moved': [
    { code: 'apply-moved', params: { operatorAnswers: true }, input: input1 },
    { code: 'apply-moved', params: { operatorAnswers: false, stops }, input: input1 },
  ],
  'apply-auto': [
    { code: 'apply-auto', params: { phase: 'reviewing', trigger: 'operator' }, input: input1 },
    {
      code: 'apply-auto',
      params: { phase: 'paused', trigger: 'operator', detail: 'operator' },
      input: input1,
    },
    {
      code: 'apply-auto',
      params: { phase: 'blocked', trigger: 'operator', detail: 'ATTEMPTS_EXHAUSTED: spent' },
      input: input1,
    },
    {
      code: 'apply-auto',
      params: { phase: 'failed', trigger: 'operator', detail: 'reviewer is down' },
      input: input1,
    },
    {
      code: 'apply-auto',
      params: { phase: 'blocked', trigger: 'operator', detail: 'graph changed' },
      input: input1,
    },
    {
      code: 'apply-auto',
      params: { phase: 'needs-lead', trigger: 'operator', detail: 'requirement-change' },
      input: input1,
    },
    {
      code: 'apply-auto',
      params: { phase: 'needs-lead', trigger: 'operator', detail: 'author-runtime', stops },
      input: input1,
    },
  ],
  'apply-carry': [
    { code: 'apply-carry', params: { order: 'draft' }, input: input1 },
    { code: 'apply-carry', params: { order: 'unreleased' }, input: input1 },
    { code: 'apply-carry', params: { order: 'now' }, input: input1 },
    { code: 'apply-carry', params: { order: 'now', active: ['R-1', 'R-2'] }, input: input1 },
    { code: 'apply-carry', params: { order: 'draft', active: ['R-1'] }, input: input1 },
    {
      code: 'apply-carry',
      params: { order: 'now', active: ['R-1'], pause: true },
      input: input1,
    },
    {
      code: 'apply-carry',
      params: { order: 'now', active: ['R-1'], userPause: true },
      input: input1,
    },
  ],
};

/**
 * Что текст передаёт как есть: JSON-объекты, команды и флаги CLI, операции
 * MCP и агентского API (snake_case), ссылки панели, коды блокеров.
 */
function verbatim(text: string) {
  return [
    ...(text.match(/\{"[^{}]*\}/g) ?? []),
    ...(text.match(/devcontour [a-z-]+/g) ?? []),
    ...(text.match(/--[a-z-]+/g) ?? []),
    ...(text.match(/\b[a-z]+_[a-z_]+\b/g) ?? []),
    ...(text.match(/\/\?view=[^\s)]+/g) ?? []),
    ...(text.match(/\b[A-Z]+_[A-Z_]+\b/g) ?? []),
    ...(text.match(/\bdocs\/[a-z.-]+/g) ?? []),
  ];
}

test('Подсказки шага: у каждого кода есть текст на каждом языке', () => {
  const codes = Object.keys(samples).sort();
  for (const locale of hintLocales)
    assert.deepEqual(Object.keys(hintCatalogs[locale]).sort(), codes, locale);
});

test('Подсказки шага: русский текст — по-русски, команды, JSON и id в нём как в английском', () => {
  for (const [code, steps] of Object.entries(samples))
    for (const step of steps as (HintSubject & HintOf)[]) {
      const en = hintDetail(step, 'en');
      const ru = hintDetail(step, 'ru');
      assert.ok(en && ru, code);
      assert.notEqual(ru, en, code);
      assert.match(ru, /[а-яё]{3}/i, `${code}: русский текст`);
      for (const token of verbatim(en))
        assert.ok(ru.includes(token), `${code}: «${token}» нет в русском тексте:\n${ru}`);
      for (const id of [step.boardId, step.input?.requestId, step.input?.taskId, step.job?.key])
        if (id && en.includes(id)) assert.ok(ru.includes(id), `${code}: ${id}`);
      // Английский текст шага — без кириллицы, кроме переданных как есть
      // параметров и отметки об усечённом списке.
      const own = en
        .replace(/\(… ещё \d+: [^)]+\)/g, '')
        .replace(String((step.params as { reason?: string }).reason ?? '\u0000'), '');
      assert.doesNotMatch(own, /[а-яё]/i, `${code}: английский текст`);
    }
});

test('Подсказки шага: без hintLocale — английский; ru — тот же код и параметры, русский текст', () => {
  assert.equal(hintLocaleOf(config()), 'en');
  assert.equal(configSchema.safeParse({ ...config(), hintLocale: 'de' }).success, false);
  const f = fixture();
  try {
    const at = (locale?: 'ru') => {
      const h = new DevContour(
        f.store,
        config({
          checkoutRoot: f.h.config.checkoutRoot,
          approvalMode: 'operator',
          ...(locale ? { hintLocale: locale } : {}),
        }),
      );
      return devcontourHandoff(h, {});
    };
    const board = f.h.createBoard('Board', '', 'main');
    f.h.addTask(board.id, input('Task'));
    f.h.approve(board.id);
    new LeadWorkflow(f.h).start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    const en = at();
    const ru = at('ru');
    assert.equal(en.host.next?.code, 'operator');
    assert.deepEqual(en.host.next.params, {});
    // Текст по умолчанию байтово прежний.
    assert.equal(
      en.host.next.detail,
      'approvalMode operator: lead workflow jobs do not run. The operator reviews plans and accepts boards in the panel, starts the queue (devcontour queue --start --workspace …) and retries failed tasks (devcontour retry --task ID --workspace …).',
    );
    const { detail: enDetail, ...enRest } = en.host.next;
    const { detail: ruDetail, ...ruRest } = ru.host.next!;
    assert.deepEqual(ruRest, enRest);
    assert.match(ruDetail, /^approvalMode operator: задания ведущего не исполняются/);
    assert.notEqual(ruDetail, enDetail);
    // Приложение Markdown — тот же текст шага.
    const md = handoffResponse(ru, 'md').markdown ?? '';
    assert.ok(md.includes(`- **Следующий шаг: operator** — ${ruDetail}`));
  } finally {
    f.cleanup();
  }
});

test('Подсказки шага: шаг доски в агентском режиме — по-русски, с JSON задания как есть', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board', '', 'main');
    f.h.addTask(board.id, input('Task'));
    f.h.approve(board.id);
    const at = (locale?: 'ru') =>
      devcontourHandoff(
        new DevContour(
          f.store,
          config({
            checkoutRoot: f.h.config.checkoutRoot,
            ...(locale ? { hintLocale: locale } : {}),
          }),
        ),
        { boardId: board.id },
      ).host.next!;
    const en = at();
    const ru = at('ru');
    assert.equal(en.action, 'workflow_start');
    assert.equal(en.code, 'board-start');
    assert.equal(ru.code, 'board-start');
    const json = `workflow_start {"kind": "board", "id": ${JSON.stringify(board.id)}, "authorRuntime": …}`;
    assert.ok(en.detail.includes(json), en.detail);
    assert.ok(ru.detail.includes(json), ru.detail);
    assert.match(ru.detail, /^У доски \S+ нет действующего задания ведущего/);
  } finally {
    f.cleanup();
  }
});

test('Подсказки шага: новая конфигурация setup пишет ru, digest политики исполнения прежний', async () => {
  const c = projectConfig('/tmp/example-repository', await profile('npm-project'));
  assert.equal(c.hintLocale, 'ru');
  assert.equal(hintLocaleOf(c), 'ru');
  const english = configSchema.parse({ ...c, hintLocale: undefined });
  assert.equal(english.hintLocale, undefined);
  assert.equal(approvalPolicyDigest(c), approvalPolicyDigest(english));
});

/**
 * Английский текст — прежний текст подсказок, и от текста `input-refused`
 * считается появление карточки «вход задания не построить»: изменение здесь
 * намеренное и требует заметки в docs/upgrade.md.
 * Образцы `pause-operator` с `by: lead` добавлены; прежние образцы байтово
 * прежние.
 * Образцы нового кода `job-cancelled-task` добавлены; прежние образцы байтово
 * прежние.
 * Образцы `job-cancelled-task` с `allCancelled` добавлены (второй путь — новая
 * ревизия доски); прежние образцы байтово прежние.
 * Образцы нового кода `apply-carry` добавлены (перенос ответа заменённого
 * вопроса); прежние образцы байтово прежние.
 * Образцы `apply-carry` с `active` добавлены (ожидание идущих попыток доски);
 * прежние образцы байтово прежние.
 * Образец `apply-carry` с `pause` добавлен (пауза очереди до ожидания);
 * прежние образцы байтово прежние.
 * Текст `apply-carry` с `pause` уточнён: пауза, которую снимет цикл задания,
 * не в счёт; прочие образцы байтово прежние.
 * Образец `apply-carry` с `userPause` добавлен (пауза человека до старта
 * задания); прежние образцы байтово прежние.
 * Текст `apply-carry` с `userPause` называет команду пользователя
 * `devcontour queue --pause` вместо панели; прочие образцы байтово прежние.
 * Образец `job-cancelled-task` с `allCancelled` от хоста без бюджета добавлен
 * (четвёртая фраза о владельце решения); прежние образцы байтово прежние.
 * Образцы нового кода `base-held` добавлены (удержанный перенос базы ждёт
 * подтверждения человека); прежние образцы байтово прежние.
 * Текст `answer-operator` (второе лицо) называет предложение ответа ведущего
 * (`input_propose`) вместо «ждите»; добавлены образцы с `version` и
 * `proposed`; добавлены образцы `apply-rejected` с `operatorAnswers` и
 * `proposed`; прочие образцы байтово прежние.
 * Намеренное изменение: добавлены образцы кода `apply-auto` (цепочку после
 * ответа оператора ведёт сервер: идёт, на паузе, остановлен — в том числе
 * исчерпанным бюджетом попыток); прочие образцы байтово прежние.
 * Намеренное изменение: добавлены образцы кода `apply-moved` (исходная
 * остановка вопроса не держится, F39); прочие образцы байтово прежние.
 */
const ENGLISH_SAMPLES_SHA256 = '748ea47c49ecb05f620e65dd30de87ef1366fd43d855b1743b953caead62779a';

test('Подсказки шага: английские тексты образцов закреплены', () => {
  assert.equal(
    hintDetail(samples['input-refused'][0], 'en'),
    'workflow_start for board board-1 would be refused: нет референсов. Fix that first (approvals in the panel, tasks of the board), then register the job.',
  );
  const all = Object.values(samples)
    .flat()
    .map((step) => hintDetail(step, 'en'))
    .join('\n');
  assert.equal(createHash('sha256').update(all).digest('hex'), ENGLISH_SAMPLES_SHA256);
});

test('Подсказки шага: job-cancelled-task не даёт ведущему команду повтора отмены человека', () => {
  for (const step of samples['job-cancelled-task'])
    for (const locale of hintLocales) {
      const text = hintDetail(step, locale);
      const lead = step.params.by === 'host' || step.params.by === 'graph';
      // Ведущему — только свой повтор (`--by host`, его проверяет сервис);
      // повтор отмены человека — действие пользователя в панели, без команды.
      for (const command of text.match(/devcontour retry[^,;)]*/g) ?? [])
        assert.match(command, /--by host/, `${locale} ${step.params.by}: ${command}`);
      if (!lead) assert.doesNotMatch(text, /devcontour retry/, `${locale} ${step.params.by}`);
      assert.doesNotMatch(text, /devcontour accept/, `${locale} ${step.params.by}`);
    }
});

test('Подсказки шага: host.next под маской секретов, длинная причина отказа усечена', () => {
  const SECRET = 'okapi-hint-secret-value-31337';
  const previous = process.env.DC_HINT_SECRET;
  process.env.DC_HINT_SECRET = SECRET;
  const f = fixture();
  const original = Object.getOwnPropertyDescriptor(LeadWorkflow.prototype, 'input')!
    .value as LeadWorkflow['input'];
  try {
    const h = new DevContour(
      f.store,
      config({
        checkoutRoot: f.h.config.checkoutRoot,
        hintLocale: 'ru',
        environment: { inherit: [], values: {}, secrets: { API_TOKEN: 'DC_HINT_SECRET' } },
      }),
    );
    const board = h.createBoard('Board', '', 'main');
    h.addTask(board.id, input('Task'));
    h.approve(board.id);
    let reason = '';
    LeadWorkflow.prototype.input = function (kind, id, s) {
      if (id === board.id) throw new DomainError(reason, 409);
      return original.call(this, kind, id, s);
    };
    // Предел — 1000 символов (999 и «…»): секрет в начале, у самой границы и
    // поперёк неё маскируется до усечения и не виден даже частью.
    for (const before of [6, 990, 995, 998, 999, 1000]) {
      reason = 'x'.repeat(before) + SECRET + ' rejected ' + 'y'.repeat(3000);
      const next = devcontourHandoff(h, { boardId: board.id }).host.next!;
      assert.equal(next.code, 'input-refused');
      const shown = JSON.stringify(next);
      for (let n = 4; n <= SECRET.length; n++)
        assert.ok(!shown.includes(SECRET.slice(0, n)), `${before}: часть секрета (${n})`);
      const { reason: got } = next.params;
      assert.ok([...got].length <= 1000 && got.endsWith('…'), `${before}: ${got.length}`);
      assert.ok(next.detail.includes(got));
    }
    // Усечение по символам: суррогатная пара не разрезается.
    reason = 'a' + '😀'.repeat(1500);
    const { params } = devcontourHandoff(h, { boardId: board.id }).host.next!;
    const got = (params as { reason: string }).reason;
    assert.equal([...got].length, 1000);
    assert.doesNotMatch(
      got,
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  } finally {
    LeadWorkflow.prototype.input = original;
    if (previous === undefined) delete process.env.DC_HINT_SECRET;
    else process.env.DC_HINT_SECRET = previous;
    f.cleanup();
  }
});

test('Описания команд harness пакета: без hintLocale — прежние английские, ru — русские с теми же ключами', () => {
  const { en, ru } = handoffHostCommandsByLocale;
  assert.equal(handoffHostCommands, en);
  assert.deepEqual(Object.keys(ru), Object.keys(en));
  // Английский текст по умолчанию закреплён байтово.
  assert.deepEqual(en, {
    'harness run':
      'Not a DevContour command. The running server holds the controller role but does not lift pauses itself: a board continues under its lead workflow job (workflow_start {"kind": "board", "id": BOARD, "authorRuntime": …}; workflow_status lists jobs). With approvalMode agent the job loop, at stage 1 (tasks), lifts the initial pause, the shutdown pause and an operator pause set before the job started, and checks a moved base itself (base-check); at stage 2 (acceptance) it lifts only the shutdown pause. It retries failed tasks within the repair budget and stops the job when the budget or the failure class allows no retry. With approvalMode operator jobs do not run: the operator starts the queue and retries. host.next names the step for this pack.',
    'harness resume':
      'queue_set {"paused": false}, or devcontour queue --start --workspace …; an operator pause is lifted only on the user\'s decision.',
  });
  // Команды, JSON и поля — как в английском.
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const verbatim = (t: string) =>
      [
        ...t.matchAll(
          /(\{[^}]*\}|devcontour [a-z-]+(?: --[a-z-]+)*|[a-z]+_[a-z]+|base-check|host\.next|approvalMode (?:agent|operator))/g,
        ),
      ].map((m) => m[0]);
    assert.ok(verbatim(en[key]).length > 0, key);
    assert.deepEqual(verbatim(ru[key]), verbatim(en[key]), key);
    assert.match(ru[key], /[а-я]/);
  }
  assert.match(ru['harness run'], /^Не команда DevContour\./);
  assert.match(ru['harness resume'], /паузу оператора снимают только по решению пользователя/);

  const f = fixture();
  try {
    const at = (locale?: 'ru') =>
      devcontourHandoff(
        new DevContour(
          f.store,
          config({
            checkoutRoot: f.h.config.checkoutRoot,
            ...(locale ? { hintLocale: locale } : {}),
          }),
        ),
        {},
      );
    const enValue = at();
    const ruValue = at('ru');
    assert.equal(enValue.locale, 'en');
    assert.equal(ruValue.locale, 'ru');
    assert.deepEqual(handoffResponse(enValue, 'json').commands, en);
    const json = handoffResponse(ruValue, 'json');
    assert.deepEqual(json.commands, ru);
    // Язык — не поле ответа.
    assert.deepEqual(Object.keys(json).sort(), ['commands', 'format', 'host', 'pack']);
    const md = handoffResponse(ruValue, 'md');
    assert.deepEqual(md.commands, ru);
    assert.ok(md.markdown?.includes(`- \`harness resume\` — ${ru['harness resume']}`));
    assert.ok(!md.markdown?.includes(en['harness resume']));
    // Значение без языка (собранное вручную) — по-английски.
    assert.deepEqual(
      handoffResponse({ pack: ruValue.pack, host: ruValue.host }, 'json').commands,
      en,
    );
  } finally {
    f.cleanup();
  }
});

test('Ревью плана и контракта: с hintLocale ru ревьюер пишет текст по-русски, машинные поля — как есть', async () => {
  const [line] = reviewLanguageInstructions('ru');
  assert.deepEqual(reviewLanguageInstructions('en'), []);
  assert.match(line, /in Russian/);
  assert.match(line, /summary, every finding message/);
  assert.match(line, /Keep JSON keys, the boolean approved, enum values \(severity, status\)/);
  assert.match(line, /report their state only in `previous`, by id, and do not restate them/);
  // Один fixture на все языки: промпты различаются только указанием языка.
  // Ревьюер записывает промпт и отказывает: ревью не закрепляется, и
  // следующий вызов — тот же первый раунд того же предмета.
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const board = f.h.createBoard('Board');
    f.h.addTask(board.id, input('Task'));
    const at = async (locale?: 'en' | 'ru') => {
      if (locale) f.h.config.hintLocale = locale;
      else delete f.h.config.hintLocale;
      const prompts: string[] = [];
      const refuse = (name: 'codex' | 'claude'): AgentAdapter => ({
        name,
        execute: (r: AgentRequest) => {
          prompts.push(r.prompt);
          return Promise.reject(new Error('Fixture reviewer refuses; no provider called'));
        },
      });
      const runtimes = { codex: refuse('codex'), claude: refuse('claude') };
      await assert.rejects(
        reviewContract(
          f.h,
          f.root,
          { title: 'Catalog API v1', content: 'GET /products returns a documented list.' },
          'codex',
          runtimes,
        ),
      );
      await assert.rejects(reviewPlan(f.h, f.root, board.id, 'codex', runtimes));
      assert.equal(prompts.length, 2);
      assert.match(prompts[0], /^Independently review this contract \/ architecture decision\./);
      assert.match(prompts[1], /^Independently review this task plan\./);
      return prompts;
    };
    const none = await at();
    const en = await at('en');
    const ru = await at('ru');
    // Без hintLocale и с en промпт байтово один и тот же.
    assert.deepEqual(en, none);
    assert.ok(none.every((p) => !p.includes('Language:')));
    // ru — тот же промпт с одной строкой языка.
    for (const [i, prompt] of ru.entries()) {
      assert.ok(prompt.includes(line + '\n\n'), 'указание языка в промпте');
      assert.equal(prompt.replace(line + '\n\n', ''), en[i]);
    }
  } finally {
    f.cleanup();
  }
});
