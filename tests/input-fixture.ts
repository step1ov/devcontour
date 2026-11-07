// Общая обстановка тестов вопросов исполнителя: demo-workspace, задача с
// demo-вопросом и управляемый reviewer ответа. Модели не вызываются.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoPool, testDemo } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { DEMO_ASK, adapters, type AgentAdapter } from '../src/runner/adapters.ts';
import { InputService } from '../src/application/input.ts';

/** Пул demo-workspace; файл теста закрывает его в `after`. */
export const inputDemos = demoPool(testDemo);

export async function inputFixture(
  runtimes: Record<string, AgentAdapter> = adapters,
  options: {
    approvalMode?: 'agent' | 'operator';
    /** Правка config.json demo до загрузки (порог, окружение, бюджет восстановлений). */
    edit?: (raw: Record<string, unknown>) => void;
  } = {},
) {
  const seed = await inputDemos.acquire();
  const root = seed.root;
  const store = new Store(join(root, 'state.sqlite'));
  const path = join(root, 'config.json');
  if (options.approvalMode || options.edit) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (options.approvalMode) raw.approvalMode = options.approvalMode;
    options.edit?.(raw);
    writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
  }
  const h = new DevContour(store, loadConfig(path));
  const scheduler = new Scheduler(h, root, runtimes);
  await scheduler.init();
  const role = store.read().tasks[0].role;
  const fixture = {
    root,
    store,
    h,
    scheduler,
    service: new InputService(h, root, runtimes),
    /** Доска с задачей, demo-исполнитель которой спрашивает (`[demo:ask]`). */
    askingTask(title = 'Asking task', extra: { dependsOn?: string[]; boardId?: string } = {}) {
      const boardId = extra.boardId ?? h.createBoard('Input board').id;
      const task = h.addTask(boardId, {
        title,
        description: `An observable outcome that needs a decision ${DEMO_ASK}.`,
        role,
        acceptance: ['The artifact exists.'],
        ...(extra.dependsOn ? { dependsOn: extra.dependsOn } : {}),
      });
      return { boardId, taskId: task.id };
    },
    /** Обычная задача demo (без вопроса). */
    plainTask(boardId: string, title: string, dependsOn: string[] = []) {
      return h.addTask(boardId, {
        title,
        description: 'An observable independent outcome of the demo.',
        role,
        acceptance: ['The artifact exists.'],
        dependsOn,
      }).id;
    },
    /** Снять копию demo (хранилище и планировщик закрыты вызывающим). */
    release: () => seed.release(),
    // Поля читаются в момент вызова: тест мог заменить процесс (новые
    // хранилище и планировщик над тем же каталогом).
    cleanup: async () => {
      await fixture.scheduler.stop();
      fixture.store.close();
      seed.release();
    },
  };
  return fixture;
}
export type InputFixture = Awaited<ReturnType<typeof inputFixture>>;

/** Ответ reviewer без модели: ревью ответа одобряется или отклоняется по флагу. */
export function controlled(
  options: {
    verdict?: { approve: boolean };
    prompts?: string[];
    /** Вопрос demo-исполнителя называет критическую область (минимум `declared`). */
    critical?: boolean;
    /** Готовый demo-исполнитель записывает решение, затрагивающее API (follow-up при пороге 11). */
    assume?: boolean;
    /** Вопрос demo-исполнителя пересказывает значение этой переменной окружения вызова. */
    leak?: string;
    /** Исполнитель задач с этим словом в заголовке отвечает «готово», ничего не изменив. */
    idleTitle?: string;
  } = {},
): Record<string, AgentAdapter> {
  const verdict = options.verdict ?? { approve: true };
  const planReview: AgentAdapter['execute'] = () =>
    Promise.resolve({
      data: {
        execution: { commands: [], noCommandsReason: 'Fixture review of an answer' },
        approved: verdict.approve,
        summary: verdict.approve
          ? 'Fixture: the answer clarifies'
          : 'Fixture: the answer changes the spec',
        discoveries: [],
        findings: verdict.approve
          ? []
          : [{ severity: 'blocking', message: 'Ответ меняет утверждённую приёмку' }],
        previous: [],
      },
      log: 'Fixture only; no provider called',
      command: ['fixture'],
    });
  const demo: AgentAdapter = {
    ...adapters.demo,
    execute: (request) => {
      options.prompts?.push((request.review ? 'review:' : 'writer:') + request.prompt);
      // Ревью плана (ответа) идёт без задачи: demo-ревьюер артефакта его не умеет.
      if (request.review && !request.task?.id) return planReview(request);
      if (!request.review && options.idleTitle && request.task.title.includes(options.idleTitle))
        return Promise.resolve({
          data: { completed: true, summary: 'Fixture: nothing changed', discoveries: [] },
          log: 'Fixture writer; no model invoked',
          command: ['fixture'],
        });
      const result = adapters.demo.execute(request);
      if (request.review) return result;
      return result.then((r) => {
        const data = r.data as {
          completed: boolean;
          inputRequest?: { affects: string[]; question: string } | null;
          assumptions?: unknown[];
        };
        if (options.critical && data.inputRequest) data.inputRequest.affects = ['api'];
        if (options.leak && data.inputRequest)
          data.inputRequest.question += ` (token seen: ${request.execution?.env[options.leak] ?? ''})`;
        if (options.assume && data.completed)
          data.assumptions = [
            {
              question: 'Which response field name for the artifact list?',
              chosen: 'items',
              rationale: 'Fixture decision of the demo writer',
              severity: 4,
              affects: ['api'],
            },
          ];
        return r;
      });
    },
  };
  return {
    ...adapters,
    demo,
    codex: { name: 'codex', execute: planReview },
    claude: { name: 'claude', execute: planReview },
  };
}

/** Довести задачу до вопроса: утвердить доску и выполнить очередь. */
export async function untilQuestion(f: InputFixture, boardId: string) {
  f.h.approve(boardId);
  f.h.pause(false);
  await f.scheduler.drain();
}

/** Ответить, построить снимок, провести ревью и предложить цель. */
export async function prepared(
  f: InputFixture,
  requestId: string,
  actor: 'operator' | 'lead' = 'operator',
) {
  const request = f.service.show({ requestId });
  const answered = f.service.answer(
    { requestId, text: 'Use JSON as now.', optionId: 'json', expectedVersion: request.version },
    actor,
  );
  const context = await f.service.context({ requestId });
  const review = await f.service.review({
    requestId,
    contextDigest: context.contextDigest,
    authorRuntime: 'codex',
  });
  const target = f.service.target({ requestId, contextDigest: context.contextDigest });
  return {
    answered,
    context,
    review,
    target,
    apply: {
      requestId,
      answerDigest: answered.answerDigest,
      expectedVersion: target.version,
      contextDigest: context.contextDigest,
      targetDigest: target.targetDigest!,
    },
  };
}
