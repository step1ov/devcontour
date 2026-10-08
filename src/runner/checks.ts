import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { arch, cpus, homedir, platform, tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/model.ts';
import { digest, type DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import { executionEnvironment, runSteps, withEnvironment } from './environment.ts';
import {
  CheckCorpus,
  MAX_CASE_BYTES,
  canonicalJson,
  localRoots,
  scrubLocalPaths,
  sha256,
  type CheckSuite,
} from '../core/check-store.ts';
import { obligationOf } from '../core/checks.ts';
import { assertArtifactsInBase, componentArtifacts } from './contract-artifacts.ts';
import { runCheck } from './gates.ts';
import { git } from './process.ts';

/**
 * Ограниченный эксперимент выполнимости (spike).
 *
 * Невыполнимые или неизмеримые обязательства обнаруживались после серии
 * попыток реализации. Для тяжёлого точного алгоритма или жёсткого времени до
 * реализации запускается короткий эксперимент: команда эталона или прототипа
 * на закреплённом SHA, seed и размеры входов, предел времени. Результат
 * сохраняется с версиями и пределами вывода. Таймаут — `inconclusive` для
 * выбранного способа и бюджета: он не доказывает трудность или
 * невозможность и не даёт права менять требование. Успех на выборке не
 * доказывает верхней границы на любом входе.
 */
export const spikeInput = z.strictObject({
  repositoryId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
  /** Commit эталона или прототипа; по умолчанию — HEAD компонента. */
  sha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  command: z.array(z.string().min(1)).min(1).max(50),
  sizes: z.array(z.number().int().min(0).max(1_000_000_000)).min(1).max(20),
  seed: z.number().int().min(0).max(4294967295).default(1),
  /** Предел на один размер. */
  timeoutMs: z.number().int().min(100).max(600000),
  /** Что исследуется: набор входов и вопрос эксперимента. */
  question: z.string().trim().min(10).max(2000),
});
export interface Spike {
  id: string;
  repositoryId: string;
  sha: string;
  command: string[];
  seed: number;
  sizes: number[];
  timeoutMs: number;
  question: string;
  results: {
    size: number;
    ms: number;
    outcome: 'ok' | 'timeout' | 'error';
    exitCode: number;
  }[];
  outcome: 'feasible' | 'inconclusive' | 'failed';
  /** Пределы вывода: что эксперимент показывает, а что — нет. */
  limits: string;
  environment: { platform: string; arch: string; node: string; cpus: number; isolation: string };
  at: string;
  digest: string;
}
const KIND = 'spikes';

export function spikesOf(h: DevContour, repositoryId: string) {
  return Object.values(h.store.localRecords<Spike>(KIND, repositoryId));
}
export function spikeRecord(h: DevContour, repositoryId: string, id: string) {
  return h.store.localRecords<Spike>(KIND, repositoryId)[id];
}

/** Каталоги, закрытые проверке: база контура и исходные checkout компонентов. */
export function controllerBoundary(h: DevContour, root: string) {
  const repos = repositories(h.config);
  return {
    hidden: [...new Set([root, ...repos.map((r) => r.path)])],
    readable: repos.map((r) => join(r.path, '.git')),
  };
}

export async function runSpike(h: DevContour, root: string, raw: unknown): Promise<Spike> {
  const input = spikeInput.parse(raw);
  const repo = repository(h.config, input.repositoryId ?? repositories(h.config)[0].id);
  const sha = input.sha ?? (await git(repo.path, 'rev-parse', 'HEAD'));
  await git(repo.path, 'cat-file', '-e', `${sha}^{commit}`).catch(() => {
    throw new DomainError(`Commit ${sha} недоступен в ${repo.id}`, 404);
  });
  const id = 'SP-' + randomUUID();
  const dir = join(root, 'spikes', id);
  await mkdir(join(root, 'spikes'), { recursive: true });
  await git(repo.path, 'worktree', 'add', '--detach', dir, sha);
  const results: Spike['results'] = [];
  try {
    const boundary = controllerBoundary(h, root);
    for (const size of input.sizes) {
      const environment = executionEnvironment([h.config.environment, repo.environment], {
        DEVCONTOUR_SPIKE_SIZE: String(size),
        DEVCONTOUR_SEED: String(input.seed),
      });
      const started = Date.now();
      const result = await runCheck(h, {
        argv: input.command,
        cwd: dir,
        env: environment.env,
        redact: environment.redact,
        timeoutMs: input.timeoutMs,
        signal: AbortSignal.timeout(input.timeoutMs + 60000),
        write: [dir],
        readable: boundary.readable,
        controller: boundary.hidden,
        settingsDir: join(root, 'spikes', `${id}-settings`),
      });
      const ms = Date.now() - started;
      results.push({
        size,
        ms,
        outcome: result.timedOut ? 'timeout' : result.code === 0 ? 'ok' : 'error',
        exitCode: result.code,
      });
      // После таймаута большие размеры ничего не добавят к выводу.
      if (result.timedOut) break;
    }
  } finally {
    await git(repo.path, 'worktree', 'remove', '--force', dir).catch(() => undefined);
  }
  const outcome = results.some((r) => r.outcome === 'timeout')
    ? 'inconclusive'
    : results.some((r) => r.outcome === 'error')
      ? 'failed'
      : 'feasible';
  const timeout = results.find((r) => r.outcome === 'timeout');
  const limits =
    outcome === 'inconclusive'
      ? `Таймаут ${input.timeoutMs} мс на размере ${timeout!.size}: для этого способа и бюджета вывод не сделан. Это не доказательство невыполнимости или трудности и не основание менять требование.`
      : outcome === 'failed'
        ? 'Команда эксперимента завершилась ошибкой: вывод о выполнимости не сделан.'
        : `Успех на размерах ${input.sizes.join(', ')} с seed ${input.seed} в указанной среде. Не доказывает верхней границы на любом входе и других размерах.`;
  const record = {
    id,
    repositoryId: repo.id,
    sha,
    command: input.command,
    seed: input.seed,
    sizes: input.sizes,
    timeoutMs: input.timeoutMs,
    question: input.question,
    results,
    outcome,
    limits,
    environment: {
      platform: platform(),
      arch: arch(),
      node: process.version,
      cpus: cpus().length,
      isolation: h.config.isolation.mode,
    },
    at: new Date().toISOString(),
  } satisfies Omit<Spike, 'digest'>;
  const spike: Spike = { ...record, digest: digest(record) };
  h.store.atomic(() => h.store.saveLocal(KIND, repo.id, id, spike));
  return spike;
}

/**
 * Быстрый маршрут: подтверждённый пример становится обязательным случаем.
 *
 * Пример ревьюера или ведущего — гипотеза. Контур сам запускает закреплённый
 * эталон на этом входе (режим одного случая того же checker, что исполняет
 * гейт), повторяет проверку реализации на исходном дефектном SHA и требует
 * воспроизводимого расхождения. Ответ эталона, а не слова ревьюера, становится
 * ожиданием. Команда из воспроизведения (`reproduction.command`) не
 * исполняется никогда; данные входа не интерпретируются как shell.
 *
 * Маршрут добавляет данные под тем же checker/oracle, той же областью и
 * правилами ответа. Удаление случая, замена ожидания, допуск, покрытие, новый
 * checker или команда идут обычным изменением договора проверки.
 */
export const fastPathChanges = [
  'add',
  'remove',
  'replace-expected',
  'tolerance',
  'coverage',
  'checker',
  'command',
] as const;
export const caseInput = z.strictObject({
  taskId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  property: z.string().min(1).max(200),
  /** Точный вход как JSON-текст. */
  input: z
    .string()
    .min(1)
    .max(64 * 1024),
  /** Утверждение источника; эталон его проверяет, но не наследует. */
  expected: z
    .string()
    .max(64 * 1024)
    .nullable()
    .optional(),
  actual: z
    .string()
    .max(64 * 1024)
    .nullable()
    .optional(),
  reproductionId: z.string().max(80).optional(),
  /** Дефектный SHA; по умолчанию — кандидат последней неуспешной попытки задачи. */
  sourceSha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  sourceRunId: z.string().max(80).optional(),
  /** Какие незавершённые задачи принимают новую версию; по умолчанию — эта. */
  adopt: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/))
    .max(30)
    .optional(),
  /** Ключ идемпотентности: повтор с тем же ключом возвращает прежний исход. */
  key: z.string().regex(/^[A-Za-z0-9_.:-]{8,120}$/),
  change: z.enum(fastPathChanges).default('add'),
  origin: z.enum(['review', 'lead', 'agent', 'operator']).default('agent'),
  runtime: z.string().max(40).optional(),
});
export type CaseRequest = z.input<typeof caseInput>;

/** Точка после записи версии и до принятия: тест моделирует в ней сбой. */
export const caseHooks = { afterRecord: (): void => undefined };

const caseResult = z.object({
  property: z.string(),
  valid: z.boolean().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  equal: z.boolean().optional(),
  oracleError: z.string().optional(),
  error: z.string().optional(),
});

export async function submitCase(h: DevContour, root: string, raw: unknown) {
  const input = caseInput.parse(raw);
  if (input.change !== 'add')
    throw new DomainError(
      `Быстрый маршрут только добавляет подтверждённые случаи. Изменение «${input.change}» — обычное изменение договора проверки (contract-change с независимым ревью); если меняется продуктовый смысл, нужно утверждение пользователем. Принятые версии корпуса не переписываются.`,
      409,
    );
  const corpus = new CheckCorpus(h);
  const state = h.store.read();
  const task = state.tasks.find((t) => t.id === input.taskId);
  if (!task) throw new DomainError('Задача не найдена', 404);
  const origin = { kind: input.origin, ...(input.runtime ? { runtime: input.runtime } : {}) };
  // Корпус и его договор: свойство должно быть объявлено, расширение
  // корпуса — утверждено договором, механизм — включён для задачи.
  const found = obligationOf(task, state.contracts, input.property);
  const ref = found
    ? corpus.suiteFor(task, input.property)
    : corpus.suiteFor(
        task,
        // Неизвестное свойство не подбирается по тексту: решение «отклонено»
        // записывается в корпус первого договора проверки задачи.
        state.contracts
          .filter((c) => task.contracts.includes(c.id) && c.checks)
          .flatMap((c) => c.checks!.obligations.map((o) => o.property))[0] ??
          (() => {
            throw new DomainError('У задачи нет договора проверки с корпусом', 409);
          })(),
      );
  const started = corpus.begin(ref, input.key);
  if (started.done) {
    const done = started.done;
    const suite = corpus.get(ref.suite.id);
    for (const p of suite.pending.filter(
      (x) => x.status === 'waiting' && !x.awaitingOperator && x.version === done.version,
    ))
      corpus.adopt(suite.id, p.id);
    return view(corpus.get(suite.id), done.id, true);
  }
  const token = started.token;
  let source: { sha: string; runId?: string; taskId?: string };
  try {
    source = sourceOf(state, task, input);
  } catch (error) {
    corpus.end(ref.suite.id, input.key, token);
    throw error;
  }
  const heartbeat = setInterval(
    () => {
      try {
        corpus.heartbeat(ref.suite.id, input.key, token);
      } catch {
        /* Утраченное владение увидит запись решения. */
      }
    },
    Math.max(1000, h.config.leaseMs / 2),
  );
  heartbeat.unref();
  try {
    const decided = await decide(h, root, task, ref, input, source);
    // Диагностика решения уходит в Git: локальные каталоги из исключений
    // реализации заменяются меткой до записи.
    const roots = localRoots(h, [root, repository(h.config, task.repositoryId).path]);
    const verdict = {
      ...decided,
      reason: scrubLocalPaths(decided.reason, roots),
      ...(decided.observed
        ? {
            observed: {
              ...decided.observed,
              ...(decided.observed.actual !== undefined
                ? { actual: scrubLocalPaths(decided.observed.actual, roots) }
                : {}),
            },
          }
        : {}),
    };
    const recorded = corpus.record(
      corpus.get(ref.suite.id),
      input.key,
      token,
      {
        key: input.key,
        property: input.property,
        input: verdict.input,
        inputHash: sha256(verdict.input),
        outcome: verdict.outcome,
        reason: verdict.reason,
        claimed: {
          expected: input.expected ?? null,
          actual: input.actual ?? null,
          ...(input.reproductionId ? { reproduction: input.reproductionId } : {}),
        },
        source,
        ...(verdict.observed ? { observed: verdict.observed } : {}),
        ...(verdict.method ? { method: verdict.method } : {}),
        origin,
      },
      (content) =>
        execFileSync('git', ['hash-object', '-w', '--stdin'], {
          cwd: repository(h.config, task.repositoryId).path,
          input: content,
        })
          .toString()
          .trim(),
      {
        tasks: input.adopt ?? [task.id],
        actor: `${origin.kind}${origin.runtime ? ':' + origin.runtime : ''}`,
        // operator mode: данные корпуса записываются, принятие задачей ждёт
        // ручного технического подтверждения.
        manual: h.config.approvalMode === 'operator',
      },
    );
    caseHooks.afterRecord();
    if (recorded.pending && !recorded.pending.awaitingOperator)
      corpus.adopt(ref.suite.id, recorded.pending.id);
    return view(corpus.get(ref.suite.id), recorded.decision.id, false);
  } finally {
    clearInterval(heartbeat);
  }
}

function sourceOf(
  state: ReturnType<DevContour['store']['read']>,
  task: { id: string },
  input: z.infer<typeof caseInput>,
) {
  if (input.sourceSha) return { sha: input.sourceSha, runId: input.sourceRunId, taskId: task.id };
  const run = input.sourceRunId
    ? state.runs.find((r) => r.id === input.sourceRunId && r.taskId === task.id)
    : state.runs.findLast((r) => r.taskId === task.id && r.candidateSha && r.status !== 'active');
  if (!run?.candidateSha)
    throw new DomainError('Не указан дефектный SHA и у задачи нет завершённого кандидата', 409);
  return { sha: run.candidateSha, runId: run.id, taskId: task.id };
}

function view(suite: CheckSuite, decisionId: string, repeated: boolean) {
  const decision = suite.decisions.find((d) => d.id === decisionId)!;
  const head = suite.versions.at(-1);
  return {
    suite: suite.id,
    repeated,
    decision,
    version: head ? { number: head.number, digest: head.digest, cases: head.cases.length } : null,
    adoption: suite.pending
      .filter((p) => p.version === decision.version)
      .map(({ id, status, results, awaitingOperator }) => ({
        id,
        status,
        results,
        ...(awaitingOperator ? { awaitingOperator } : {}),
      })),
  };
}

type Verdict = {
  input: string;
  outcome: 'confirmed' | 'refuted' | 'inconclusive' | 'rejected';
  reason: string;
  observed?: NonNullable<import('../core/check-store.ts').CaseDecision['observed']>;
  method?: NonNullable<import('../core/check-store.ts').CaseDecision['method']>;
};

async function decide(
  h: DevContour,
  root: string,
  task: import('../core/model.ts').Task,
  ref: ReturnType<CheckCorpus['suiteFor']>,
  input: z.infer<typeof caseInput>,
  source: { sha: string },
): Promise<Verdict> {
  const reject = (reason: string, text = input.input): Verdict => ({
    input: text,
    outcome: 'rejected',
    reason,
  });
  let text: string;
  try {
    text = canonicalJson(JSON.parse(input.input));
  } catch {
    return reject('вход не JSON');
  }
  // Замаскированный вход непригоден: настоящего значения уже нет, и
  // подтверждать пришлось бы другой вход.
  if (text.includes('[REDACTED]')) return reject('вход замаскирован redaction и непригоден', text);
  if (Buffer.byteLength(text) + Buffer.byteLength(input.expected ?? '') > MAX_CASE_BYTES)
    return reject(`случай больше ${MAX_CASE_BYTES} байт`, text);
  const s = h.store.read();
  const found = obligationOf(task, s.contracts, input.property);
  if (!found) return reject(`свойство ${input.property} не объявлено в договорах задачи`, text);
  const declaration = found.contract.checks!;
  if (!declaration.corpus?.extensible || !found.obligation.coverage.corpus)
    return reject('договор проверки не разрешает пополнять корпус этого свойства', text);
  if (!task.properties?.includes(input.property))
    return reject(
      'механизм договора проверки для задачи не включён или свойство вне её области: включение проходит ревью плана',
      text,
    );
  const repo = repository(h.config, task.repositoryId);
  const gate = repo.gates.find((g) => g.id === declaration.gate);
  if (!gate?.property) return reject(`гейт ${declaration.gate} не настроен как генеративный`, text);
  const artifacts = componentArtifacts([found.contract], repo.id);
  const method = {
    gate: gate.id,
    command: gate.command,
    artifacts: artifacts.map((a) => ({ path: a.path, blob: a.blob })),
    contract: found.contract.id,
    basis: ref.suite.basis,
  };
  try {
    await git(repo.path, 'cat-file', '-e', `${source.sha}^{commit}`);
  } catch {
    return {
      input: text,
      outcome: 'inconclusive',
      reason: `исходный SHA ${source.sha} недоступен`,
      method,
    };
  }
  // Checker на исходном SHA — закреплённая редакция: иначе ответ дал бы
  // другой эталон, чем утверждён договором.
  const stale = await assertArtifactsInBase(repo.path, source.sha, artifacts);
  if (stale.length)
    return {
      input: text,
      outcome: 'inconclusive',
      reason: `на исходном SHA checker не совпадает с закреплённым: ${stale.join(', ')}`,
      method,
    };
  const runs: z.infer<typeof caseResult>[] = [];
  const durations: number[] = [];
  const dir = join(root, 'case-checks', randomUUID());
  await mkdir(join(root, 'case-checks'), { recursive: true });
  await git(repo.path, 'worktree', 'add', '--detach', dir, source.sha);
  const io = await realpath(await mkdtemp(join(tmpdir(), 'dc-case-')));
  try {
    const execution = executionEnvironment([h.config.environment, repo.environment], {
      DEVCONTOUR_REPOSITORY_ID: repo.id,
      DEVCONTOUR_TASK_ID: task.id,
      DEVCONTOUR_PHASE: 'case',
    });
    const signal = AbortSignal.timeout(gate.timeoutMs * 3 + 120000);
    await withEnvironment(
      repo.lifecycle,
      dir,
      join(dir, '..', `${basename(dir)}-env`),
      execution,
      signal,
      async () => {
        await runSteps(repo.prepare ?? [], dir, join(io, 'prepare'), execution, signal);
        const request = join(io, 'case.json');
        await writeFile(
          request,
          JSON.stringify({ property: input.property, input: JSON.parse(text) as unknown }),
        );
        const boundary = controllerBoundary(h, root);
        for (let i = 0; i < 2; i++) {
          const out = join(io, `result-${i}.json`);
          const started = Date.now();
          const result = await runCheck(h, {
            argv: gate.command,
            cwd: gate.cwd ? join(dir, gate.cwd) : dir,
            env: { ...execution.env, DEVCONTOUR_CASE: request, DEVCONTOUR_CASE_RESULT: out },
            redact: execution.redact,
            timeoutMs: gate.timeoutMs,
            signal,
            write: [dir, io],
            readable: boundary.readable,
            controller: boundary.hidden,
            settingsDir: join(io, `settings-${i}`),
          });
          durations.push(Date.now() - started);
          if (result.timedOut) {
            runs.push({ property: input.property, error: 'timeout' });
            break;
          }
          const parsed = caseResult.safeParse(
            JSON.parse(await readFile(out, 'utf8').catch(() => 'null')),
          );
          runs.push(
            parsed.success ? parsed.data : { property: input.property, error: 'нет результата' },
          );
        }
      },
    );
  } catch (error) {
    return {
      input: text,
      outcome: 'inconclusive',
      reason:
        'проверка не выполнилась: ' +
        (error instanceof Error ? error.message : String(error)).slice(0, 300),
      method,
    };
  } finally {
    await git(repo.path, 'worktree', 'remove', '--force', dir).catch(() => undefined);
    await rm(io, { recursive: true, force: true }).catch(() => undefined);
  }
  const observed = (r: z.infer<typeof caseResult>) => ({
    ...(r.expected !== undefined ? { expected: canonicalJson(r.expected) } : {}),
    ...(r.actual !== undefined ? { actual: canonicalJson(r.actual) } : {}),
    ...(r.equal !== undefined ? { equal: r.equal } : {}),
    repeats: runs.length,
    durationsMs: durations,
  });
  const first = runs[0];
  if (!first || first.error)
    return {
      input: text,
      outcome: 'inconclusive',
      reason:
        first?.error === 'timeout'
          ? 'эталон или реализация не уложились в предел гейта'
          : `проверка не дала ответа: ${first?.error ?? 'нет результата'}`,
      method,
      observed: { repeats: runs.length, durationsMs: durations },
    };
  if (first.valid === false)
    return { ...reject('вход вне объявленной области свойства', text), method };
  if (first.oracleError)
    return {
      input: text,
      outcome: 'inconclusive',
      reason: `ошибка эталона: ${first.oracleError.slice(0, 300)}`,
      method,
      observed: observed(first),
    };
  if (runs.length < 2 || runs[1].error || canonicalJson(runs[1]) !== canonicalJson(first))
    return {
      input: text,
      outcome: 'inconclusive',
      reason: 'результат не воспроизвёлся при повторе',
      method,
      observed: observed(first),
    };
  const expected = canonicalJson(first.expected);
  if (input.expected != null) {
    let claimed: string | undefined;
    try {
      claimed = canonicalJson(JSON.parse(input.expected));
    } catch {
      claimed = undefined;
    }
    if (claimed !== expected)
      return {
        input: text,
        outcome: 'refuted',
        reason: `ожидание источника ${(input.expected ?? '').slice(0, 200)} опровергнуто эталоном: ${expected.slice(0, 200)}`,
        method,
        observed: observed(first),
      };
  }
  if (first.equal)
    return {
      input: text,
      outcome: 'refuted',
      reason: 'на исходном SHA реализация совпадает с эталоном: расхождения нет',
      method,
      observed: observed(first),
    };
  return {
    input: text,
    outcome: 'confirmed',
    reason: `эталон дал ${expected.slice(0, 200)}, реализация на ${source.sha.slice(0, 12)} — ${canonicalJson(first.actual).slice(0, 200)}; расхождение воспроизведено дважды`,
    method,
    observed: observed(first),
  };
}

/**
 * Самопроверка исполнителя: тот же закреплённый checker, полный активный
 * корпус, генератор с воспроизводимым seed и селектор свойств задачи. Код
 * проверяется рабочий, незакоммиченный — результат диагностический и не
 * заменяет evidence контура на commit SHA.
 */
export async function writeSelfCheck(
  h: DevContour,
  task: import('../core/model.ts').Task,
  dir: string,
  seed: number,
  binding?: { suite: string; number: number; digest: string },
) {
  const s = h.store.read();
  const repo = repository(h.config, task.repositoryId);
  const gates = new Map<string, { command: string[]; cwd?: string; properties: string[] }>();
  for (const id of task.properties ?? []) {
    const found = obligationOf(task, s.contracts, id);
    const gate = found && repo.gates.find((g) => g.id === found.gate && g.property);
    if (!gate) continue;
    const entry = gates.get(gate.id) ?? { command: gate.command, cwd: gate.cwd, properties: [] };
    entry.properties.push(id);
    gates.set(gate.id, entry);
  }
  if (!gates.size) return undefined;
  await mkdir(dir, { recursive: true });
  let cases = 0;
  if (binding) {
    const corpus = new CheckCorpus(h).snapshot(binding);
    cases = corpus.cases.length;
    await writeFile(join(dir, 'corpus.json'), corpus.content);
  }
  const plan = {
    task: task.id,
    seed,
    corpus: binding ? join(dir, 'corpus.json') : null,
    gates: [...gates].map(([id, g]) => ({ id, ...g })),
  };
  await writeFile(join(dir, 'selfcheck.mjs'), selfCheckSource(plan));
  return {
    command: ['node', join(dir, 'selfcheck.mjs')],
    corpus: binding ? join(dir, 'corpus.json') : undefined,
    cases,
    seed,
    properties: [...gates.values()].flatMap((g) => g.properties),
  };
}

function selfCheckSource(plan: unknown) {
  return `// Самопроверка DevContour: закреплённый checker, полный корпус, seed и
// свойства задачи. Диагностика рабочего кода: контур всё равно исполняет
// гейты на commit SHA. Ненулевой код — свойство, точный вход и причина.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const plan = ${JSON.stringify(plan, null, 2)};
let failed = 0;
for (const gate of plan.gates) {
  const scratch = mkdtempSync(join(tmpdir(), 'dc-self-'));
  const report = join(scratch, 'property.json');
  const result = spawnSync(gate.command[0], gate.command.slice(1), {
    cwd: gate.cwd ? join(process.cwd(), gate.cwd) : process.cwd(),
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      DEVCONTOUR_SEED: String(plan.seed),
      DEVCONTOUR_PROPERTIES: gate.properties.join(','),
      ...(plan.corpus ? { DEVCONTOUR_CORPUS: plan.corpus } : {}),
      DEVCONTOUR_PROPERTY_REPORT: report,
      DEVCONTOUR_REPORT_PATH: join(scratch, 'junit.xml'),
    },
  });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(report, 'utf8'));
  } catch {}
  rmSync(scratch, { recursive: true, force: true });
  if (!parsed) {
    failed++;
    console.log('FAIL ' + gate.id + ': отчёт свойств не записан (код выхода ' + result.status + ')');
    continue;
  }
  for (const p of parsed.properties) {
    if (p.status === 'passed') continue;
    failed++;
    const c = p.counterexample;
    const input = c ? (c.reduced ?? c.original) : p.current;
    const reason = p.error ?? (c ? 'ожидалось ' + JSON.stringify(c.expected) + ', получено ' + JSON.stringify(c.actual) : 'не завершилось');
    console.log('FAIL ' + p.testId + (c && c.case ? ' [случай корпуса ' + c.case + ']' : '') + ': input=' + JSON.stringify(input) + ' — ' + reason);
  }
  for (const f of parsed.corpus?.failed ?? [])
    console.log('CORPUS ' + f.property + ' [' + f.id + ']: ожидалось ' + JSON.stringify(f.expected) + ', получено ' + JSON.stringify(f.actual));
  if (result.status && !parsed.properties.some((p) => p.status !== 'passed')) {
    failed++;
    console.log('FAIL ' + gate.id + ': код выхода ' + result.status);
  }
}
console.log(failed ? 'self-check: ' + failed + ' failing (seed ' + plan.seed + ')' : 'self-check: all task properties hold (seed ' + plan.seed + '); diagnostic only — the controller runs the gates on your commit');
process.exit(failed ? 1 : 0);
`;
}
