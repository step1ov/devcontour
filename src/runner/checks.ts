import {
  CorpusStore,
  caseHooks,
  submitCase as confirmCase,
  type ConfirmContext,
} from 'devcontour-harness';
import { randomUUID } from 'node:crypto';
import { arch, cpus, platform } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/model.ts';
import { digest, type DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import { executionEnvironment } from './environment.ts';
import { CheckCorpus, localRoots } from '../core/check-store.ts';
import { obligationOf } from '../core/checks.ts';
import { runCheck } from 'devcontour-harness';
import { git } from './process.ts';
import { executionOf, toDomain } from '../harness/execution.ts';

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

/**
 * Точка после записи версии и до принятия: тест моделирует в ней сбой. Она
 * общая с подтверждением пакета harness — одна подмена обрывает любой путь.
 */
export { caseHooks };

export async function submitCase(h: DevContour, root: string, raw: unknown) {
  const input = caseInput.parse(raw);
  if (input.change !== 'add')
    throw new DomainError(
      `Быстрый маршрут только добавляет подтверждённые случаи. Изменение «${input.change}» — обычное изменение договора проверки (contract-change с независимым ревью); если меняется продуктовый смысл, нужно утверждение пользователем. Принятые версии корпуса не переписываются.`,
      409,
    );
  const task = h.store.read().tasks.find((t) => t.id === input.taskId);
  if (!task) throw new DomainError('Задача не найдена', 404);
  const { engine } = executionOf(h);
  // Подтверждение — правило harness: закреплённый эталон на дефектном SHA,
  // запись решения и версии под владением, принятие версии задачами. Здесь
  // только продуктовые входы: задача, корни очистки диагностики, каталоги
  // компонентов и граница, закрытая проверке.
  const ctx: ConfirmContext = {
    corpus: new CorpusStore(
      engine,
      localRoots(h, [root, repository(h.config, task.repositoryId).path]),
    ),
    policy: engine.policy,
    stateDir: root,
    repoPath: (repo) => repository(h.config, repo.id).path,
    boundary: () => controllerBoundary(h, root),
  };
  const { taskId, ...rest } = input;
  try {
    return await confirmCase(ctx, { ...rest, workId: taskId });
  } catch (error) {
    throw toDomain(error);
  }
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
