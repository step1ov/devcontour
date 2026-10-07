import { createHash, randomUUID } from 'node:crypto';
import type { FailureKind } from './failure.ts';
import type { DevContourState, Run, Task } from './model.ts';

/**
 * Ограниченное восстановление по повторяющемуся свойству.
 *
 * Бюджет попыток уходил на одно и то же свойство: каждая попытка чинила
 * контрпример прошлого ревью, следующее ревью находило новый вход того же
 * класса, и только исчерпание бюджета останавливало цикл. Здесь два
 * последовательных содержательных отказа одной задачи по одному объявленному
 * свойству в одном эпизоде запрещают третью автоматическую выдачу до
 * разбора. Это не отмена задачи: ведущий получает ограниченный разбор и
 * одно из разрешённых действий.
 *
 * Правила последовательности:
 * - считаются отдельные завершённые попытки: несколько находок и обе фазы
 *   одной попытки — один отказ;
 * - отказ провайдера или окружения не увеличивает и не обнуляет счёт;
 * - эпизод завершает проверенное прохождение свойства (его гейт прошёл и
 *   ревью не связало отказ с ним) либо утверждённое изменение основания —
 *   постановки или контрактов. Новый текст находки, seed, повтор, рестарт и
 *   добавление случая в корпус эпизод не завершают.
 *
 * Свойство отказа берётся только из объявленных property ID: свободная
 * строка ревьюера нового ID не создаёт и счётчик не выбирает.
 */
export const RECOVERY_THRESHOLD = 2;
export const recoveryActions = [
  'add-cases',
  'new-approach',
  'strengthen-checker',
  'split-task',
  'clarify-obligation',
  'environment',
] as const;
export type RecoveryAction = (typeof recoveryActions)[number];
export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  evidence: string[];
  hypothesis?: string;
  plan?: string;
  cases?: { input: string; expected?: string | null }[];
  proposal?: string;
  conflict?: string;
  source: { kind: 'lead' | 'operator'; runtime?: string; model?: string };
  decidedAt: string;
}
export interface PropertyRecovery {
  id: string;
  property: string;
  /** Основание эпизода: утверждённая постановка и контракты. */
  basis: string;
  /** Две содержательные попытки, открывшие эпизод. */
  runs: string[];
  openedAt: string;
  /**
   * `awaiting-lead` — нужен разбор ведущего; `analyzing` — разбор идёт (вызов
   * учтён до него); `applying` — действие исполняется; `retry` — разрешена
   * одна попытка; `retrying` — она выдана; `awaiting-user` — нужно решение
   * пользователя; `stopped` — автоматического действия нет; `closed` —
   * эпизод завершён.
   */
  status:
    | 'awaiting-lead'
    | 'analyzing'
    | 'applying'
    | 'retry'
    | 'retrying'
    | 'awaiting-user'
    | 'stopped'
    | 'closed';
  /** Разборов ведущего, учтённых в эпизоде: один автоматический. */
  calls: number;
  decision?: RecoveryDecision;
  retryRun?: string;
  reason?: string;
  history: { at: string; event: string; detail?: string }[];
  /** Версия записи: CAS для ручного решения через API. */
  version: number;
}

/** Задачу с незавершённым разбором автоматическая выдача пропускает. */
export const blocksClaim = (t: Pick<Task, 'recovery'>) =>
  !!t.recovery && !['retry', 'closed'].includes(t.recovery.status);

export const episodeBasis = (t: Pick<Task, 'approvedDigest' | 'contractDigests'>) =>
  createHash('sha256')
    .update(JSON.stringify({ spec: t.approvedDigest ?? null, contracts: t.contractDigests }))
    .digest('hex');

/** Отказы, ничего не говорящие о свойстве: не увеличивают и не обнуляют счёт. */
const neutral: FailureKind[] = [
  'provider-auth',
  'environment',
  'timeout',
  'stale-base',
  'merge',
  'cancelled',
  'unknown',
  'empty-result',
  'scope-violation',
];
const substantive = (r: Run) => r.failureKind === 'gate' || r.failureKind === 'review';

/** Свойство прошло проверку в попытке: его гейт зелёный, отказа по нему нет. */
function verifiedPass(r: Run, property: string) {
  if (r.properties?.includes(property)) return false;
  return r.evidence.some(
    (e) =>
      e.kind === 'test' &&
      e.property?.level === 'manifest' &&
      !e.property.coverage?.length &&
      e.property.report?.properties.some((p) => p.testId === property && p.status === 'passed'),
  );
}

/**
 * Сколько последовательных содержательных отказов по свойству в текущем
 * эпизоде и какие это попытки, от последней к первой.
 */
export function propertyStreak(s: DevContourState, task: Task, property: string) {
  const basis = episodeBasis(task);
  const runs: string[] = [];
  const own = s.runs.filter((r) => r.taskId === task.id && r.status !== 'active');
  for (let i = own.length - 1; i >= 0; i--) {
    const r = own[i];
    if (r.episodeBasis !== basis) break;
    if (r.status === 'succeeded') break;
    if (verifiedPass(r, property)) break;
    if (r.blocked || (r.failureKind && neutral.includes(r.failureKind))) continue;
    if (substantive(r) && r.properties?.includes(property)) runs.push(r.id);
    else if (substantive(r)) continue;
  }
  return { basis, runs };
}

/**
 * Обновить эпизод после записи отказа попытки — в той же транзакции.
 * Возвращает изменённую запись или undefined.
 */
export function afterFailure(s: DevContourState, task: Task, run: Run) {
  const at = new Date().toISOString();
  const current = task.recovery;
  // Разрешённый повтор завершился: повторный провал по тому же свойству
  // останавливает цикл; инфраструктурный отказ возвращает право на повтор.
  if (current && current.status === 'retrying' && current.retryRun === run.id) {
    if (run.blocked || (run.failureKind && neutral.includes(run.failureKind))) {
      current.status = 'retry';
      current.retryRun = undefined;
      current.history.push({ at, event: 'retry-returned', detail: run.failureKind });
    } else if (run.properties?.includes(current.property)) {
      current.status = 'stopped';
      current.reason = `Повторный отказ по свойству ${current.property} после разрешённого повтора: автоматических действий больше нет. Решение — за ведущим или пользователем.`;
      current.history.push({ at, event: 'stopped', detail: run.id });
    } else if (verifiedPass(run, current.property)) close(task, at, 'свойство прошло проверку');
    current.version++;
    return current;
  }
  if (current && current.status !== 'closed') {
    if (current.basis !== episodeBasis(task)) close(task, at, 'основание задачи изменилось');
    else return undefined;
  }
  for (const property of run.properties ?? []) {
    const streak = propertyStreak(s, task, property);
    if (streak.runs.length < RECOVERY_THRESHOLD) continue;
    // Тот же эпизод уже разбирался: повторная регистрация бюджета не даёт.
    const previous = task.recoveryHistory?.find(
      (r) =>
        r.property === property && r.basis === streak.basis && r.runs.includes(streak.runs.at(-1)!),
    );
    if (previous) continue;
    task.recovery = {
      id: 'RC-' + randomUUID(),
      property,
      basis: streak.basis,
      runs: streak.runs.slice(0, RECOVERY_THRESHOLD).reverse(),
      openedAt: at,
      status: 'awaiting-lead',
      calls: 0,
      history: [
        {
          at,
          event: 'opened',
          detail: `${streak.runs.length} содержательных отказа по свойству ${property} подряд`,
        },
      ],
      version: 1,
    };
    return task.recovery;
  }
  return undefined;
}

/** Попытка прошла: эпизод по её свойствам завершён. */
export function afterSuccess(task: Task) {
  if (task.recovery && task.recovery.status !== 'closed')
    close(task, new Date().toISOString(), 'задача принята');
}

function close(task: Task, at: string, reason: string) {
  const r = task.recovery!;
  r.status = 'closed';
  r.reason = reason;
  r.history.push({ at, event: 'closed', detail: reason });
  task.recoveryHistory = [...(task.recoveryHistory ?? []), structuredClone(r)].slice(-20);
  task.recovery = undefined;
}
