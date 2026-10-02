import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type Contract } from '../core/model.ts';
import { contractDigest, digest, type DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import {
  contractContent,
  contractProposal,
  defaultOwner,
  reviewContract,
  reviewPlan,
} from './agent-control.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import { pinArtifacts } from './contract-artifacts.ts';
import { contractImpact } from './contract-impact.ts';
import { updateBase } from './base-update.ts';
import { git } from './process.ts';

/**
 * Изменение контракта как сохраняемая операция.
 *
 * Раньше это была цепочка ручных команд ведущего: ревью, перепривязка задач,
 * повторное ревью плана, перенос базы. Ошибка в порядке останавливала
 * очередь или запускала задачу на старой редакции, а прерывание оставляло
 * неизвестно какое состояние. Здесь каждый шаг идемпотентен и выполняется
 * только действующим владельцем операции (lease и token); прогресс
 * сохраняется после каждого шага, и после сбоя операция продолжается с того
 * же места, не повторяя необратимого. У Git, SQLite и внешнего ревью нет общей
 * транзакции — согласованность держат ожидаемые digest и SHA, а не атомарность.
 */
const steps = ['hold', 'drain', 'review', 'rebind', 'plan', 'base', 'release'] as const;
type Step = (typeof steps)[number];

export type ContractChange = {
  id: string;
  /** Контракт, который меняется: компонент и источник. Одна операция на него. */
  key: string;
  owner: string;
  proposal: z.infer<typeof contractProposal>;
  authorRuntime: 'codex' | 'claude';
  expected: { head: string; proposedDigest: string; current: string | null };
  step: number;
  status: 'queued' | 'running' | 'waiting' | 'failed' | 'completed' | 'stale' | 'abandoned';
  waitingFor?: string[];
  token?: string;
  leaseUntil?: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  contractId?: string;
  held: string[];
  rebound: string[];
  boards: string[];
  /** Принятые задачи прежней редакции: их меняет корректировка, а не операция. */
  corrections: string[];
  history: { at: string; step: Step | 'start'; event: string; detail?: string }[];
};

const KIND = 'contract-change';
const active = (op: ContractChange) =>
  ['queued', 'running', 'waiting', 'failed'].includes(op.status);

export class ContractChanges {
  /** Предел git update-ref внутри транзакции: зависший Git не держит базу контура. */
  static refMoveTimeoutMs = 15000;
  constructor(
    readonly h: DevContour,
    readonly root: string,
    readonly runtimes: Record<'codex' | 'claude', AgentAdapter> = adapters,
    /** Точка после шага: тест моделирует в ней сбой процесса. */
    readonly afterStep: (step: Step) => void = () => {},
  ) {}
  private all() {
    return repositories(this.h.config).flatMap((r) =>
      Object.values(this.h.store.localRecords<ContractChange>(KIND, r.id)),
    );
  }
  get(id: string) {
    const op = this.all().find((x) => x.id === id);
    if (!op) throw new DomainError('Операция изменения контракта не найдена', 404);
    return op;
  }
  private save(op: ContractChange) {
    this.h.store.saveLocal(KIND, op.owner, op.id, op);
  }
  private log(
    op: ContractChange,
    step: ContractChange['history'][number]['step'],
    event: string,
    detail?: string,
  ) {
    op.history.push({ at: new Date().toISOString(), step, event, ...(detail ? { detail } : {}) });
    op.history = op.history.slice(-100);
  }
  /** Внешнее представление: без token и lease. */
  view(op: ContractChange) {
    const { token, leaseUntil, ...rest } = op;
    void token;
    void leaseUntil;
    return { ...rest, next: steps[op.step] ?? null };
  }

  /** Начать операцию или вернуть уже идущую по тому же предложению. */
  async start(input: unknown, authorRuntime: 'codex' | 'claude') {
    if (this.h.config.approvalMode === 'operator')
      throw new DomainError(
        'В режиме operator изменение контракта проводит оператор: ревью ждёт его подтверждения',
        409,
      );
    const proposal = contractProposal.parse(input);
    const impact = await contractImpact(this.h, proposal);
    if (impact.status === 'unchanged') return { status: 'unchanged' as const, impact };
    // Операция не заводит параллельный контракт для файла, который уже
    // зарегистрирован под другим компонентом: задачи прежнего остались бы
    // привязаны к нему.
    if ('registeredUnder' in impact && impact.registeredUnder?.length)
      throw new DomainError(impact.warning!, 409);
    const owner = impact.repositoryId;
    const key = digest({ owner, source: proposal.file ?? `title:${proposal.title}` });
    return this.h.store.atomic(() => {
      const existing = this.all().find((x) => x.key === key && active(x));
      if (existing) {
        if (existing.expected.proposedDigest !== impact.proposed.digest)
          throw new DomainError(
            `Контракт уже меняет операция ${existing.id} по другой редакции; продолжите или отмените её`,
            409,
          );
        return { status: 'existing' as const, operation: existing };
      }
      const op: ContractChange = {
        id: 'CC-' + randomUUID(),
        key,
        owner,
        proposal,
        authorRuntime,
        expected: {
          head: impact.proposed.revision,
          proposedDigest: impact.proposed.digest,
          current: impact.current?.id ?? null,
        },
        step: 0,
        status: 'queued',
        startedAt: new Date().toISOString(),
        held: [],
        rebound: [],
        boards: [],
        corrections: [],
        history: [],
      };
      this.log(
        op,
        'start',
        'queued',
        `${impact.tasks.direct.length} прямых, ${impact.tasks.transitive.length} зависимых задач`,
      );
      this.save(op);
      return { status: 'started' as const, operation: op };
    });
  }

  private claim(id: string) {
    return this.h.store.atomic(() => {
      const op = this.get(id);
      // Упавшая операция продолжается с того же шага: шаги идемпотентны, и
      // повтор после исправления причины — штатное продолжение.
      if (!['queued', 'running', 'waiting', 'failed'].includes(op.status)) return undefined;
      if (op.status === 'running' && op.leaseUntil! > Date.now()) return undefined;
      op.status = 'running';
      op.token = randomUUID();
      op.leaseUntil = Date.now() + this.h.config.leaseMs;
      op.waitingFor = undefined;
      op.error = undefined;
      this.save(op);
      return op;
    });
  }
  private guard(op: ContractChange) {
    const current = this.get(op.id);
    if (
      current.status !== 'running' ||
      current.token !== op.token ||
      current.leaseUntil! <= Date.now()
    )
      throw new DomainError('Владение операцией изменения контракта утрачено');
    return current;
  }
  private heartbeat(op: ContractChange) {
    this.h.store.atomic(() => {
      const current = this.guard(op);
      current.leaseUntil = Date.now() + this.h.config.leaseMs;
      this.save(current);
    });
  }
  /** Сохранить результат шага под действующим владением и перейти к следующему. */
  private advanceStep(op: ContractChange, effect: (current: ContractChange) => void = () => {}) {
    return this.h.store.atomic(() => {
      const current = this.guard(op);
      effect(current);
      this.log(current, steps[current.step], 'done');
      current.step++;
      if (current.step >= steps.length) {
        current.status = 'completed';
        current.finishedAt = new Date().toISOString();
        current.token = undefined;
        current.leaseUntil = undefined;
      }
      this.save(current);
      return current;
    });
  }
  private settle(
    op: ContractChange,
    status: 'waiting' | 'failed' | 'stale',
    message: string,
    waitingFor?: string[],
  ) {
    this.h.store.atomic(() => {
      const current = this.get(op.id);
      if (current.token !== op.token || current.status !== 'running') return;
      current.status = status;
      current.error = status === 'waiting' ? undefined : message.slice(0, 1000);
      current.waitingFor = waitingFor;
      current.token = undefined;
      current.leaseUntil = undefined;
      this.log(current, steps[current.step], status, message.slice(0, 500));
      this.save(current);
    });
  }

  /** Продолжить операцию с сохранённого шага, пока она не ждёт, не упала или не завершилась. */
  async advance(id: string) {
    const claimed = this.claim(id);
    if (!claimed) return this.view(this.get(id));
    let op = claimed;
    const heartbeat = setInterval(
      () => {
        try {
          this.heartbeat(op);
        } catch {
          /* Утраченное владение обнаружит следующий guard. */
        }
      },
      Math.max(1000, this.h.config.leaseMs / 3),
    );
    heartbeat.unref();
    try {
      while (op.status === 'running' && op.step < steps.length) {
        const step = steps[op.step];
        // Вход сверяется перед каждым шагом, а не только до ревью: редакция,
        // появившаяся после ревью, иначе ушла бы в базу под чужим одобрением.
        await this.assertInputs(op);
        const outcome = await this.run(step, op);
        if (outcome.wait) {
          this.settle(op, 'waiting', outcome.wait, outcome.waitingFor);
          break;
        }
        op = { ...this.get(op.id), token: op.token };
        this.afterStep(step);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settle(op, error instanceof StaleChange ? 'stale' : 'failed', message);
    } finally {
      clearInterval(heartbeat);
    }
    return this.view(this.get(id));
  }

  /** Отменить операцию: снять удержание. Перепривязанные задачи остаются черновиками. */
  abandon(id: string) {
    return this.h.store.atomic(() => {
      const op = this.get(id);
      if (op.status === 'running' && op.leaseUntil! > Date.now())
        throw new DomainError('Операция выполняется; дождитесь окончания шага', 409);
      if (!active(op) && op.status !== 'stale') return this.view(op);
      this.h.release(op.id);
      op.status = 'abandoned';
      op.token = undefined;
      op.leaseUntil = undefined;
      op.finishedAt = new Date().toISOString();
      this.log(op, steps[op.step] ?? 'release', 'abandoned');
      this.save(op);
      return this.view(op);
    });
  }

  private revisions(op: ContractChange) {
    const p = op.proposal;
    return this.h.store
      .read()
      .contracts.filter(
        (c: Contract) =>
          (c.repositoryId ?? undefined) === (p.repositoryId ?? undefined) &&
          (p.file ? c.source === p.file : !c.source && c.title === p.title),
      );
  }

  private async run(
    step: Step,
    op: ContractChange,
  ): Promise<{ wait?: string; waitingFor?: string[] }> {
    const repo = repository(this.h.config, op.owner);
    switch (step) {
      case 'hold': {
        const impact = await contractImpact(this.h, op.proposal);
        const held = [...impact.tasks.direct, ...impact.tasks.transitive]
          .filter((t) => !['done', 'cancelled'].includes(t.status))
          .map((t) => t.id);
        this.advanceStep(op, (current) => {
          this.h.hold(held, op.id, 'Меняется контракт ' + (op.proposal.file ?? op.proposal.title));
          current.held = held;
          current.corrections = impact.tasks.direct
            .filter((t) => t.status === 'done')
            .map((t) => t.id);
        });
        return {};
      }
      case 'drain': {
        // Идущие попытки дожидаются: операция не отменяет работу, которую
        // запустил кто-то другой.
        const s = this.h.store.read();
        const busy = s.tasks
          .filter((t) => op.held.includes(t.id) && t.activeRunId)
          .map((t) => t.id);
        if (busy.length) return { wait: 'Ждёт окончания идущих попыток', waitingFor: busy };
        this.advanceStep(op);
        return {};
      }
      case 'review': {
        // Регистрация редакции — под проверкой владения в той же транзакции:
        // ответ ревью, пришедший после перехвата операции, ничего не создаёт.
        const result = await reviewContract(
          this.h,
          this.root,
          op.proposal,
          op.authorRuntime,
          this.runtimes,
          () => this.guard(op),
          op.expected.head,
        );
        if (!('contract' in result) || !result.contract)
          throw new DomainError('Ревью контракта не зарегистрировало редакцию: ' + result.status);
        const contractId = result.contract.id;
        this.advanceStep(op, (current) => {
          current.contractId = contractId;
        });
        return {};
      }
      case 'rebind': {
        const s = this.h.store.read();
        const from = this.revisions(op)
          .map((c) => c.id)
          .filter((id) => id !== op.contractId);
        const direct = s.tasks.filter(
          (t) => op.held.includes(t.id) && t.contracts.some((c) => from.includes(c)),
        );
        this.advanceStep(op, (current) => {
          const rebound = this.h.rebind(
            direct.map((t) => t.id),
            from,
            op.contractId!,
          );
          const state = this.h.store.read();
          current.rebound = [...new Set([...current.rebound, ...rebound])];
          current.boards = [
            ...new Set(
              current.rebound
                .map((id) => state.boards.find((b) => b.revisions.at(-1)!.taskIds.includes(id))?.id)
                .filter((id): id is string => Boolean(id)),
            ),
          ];
        });
        return {};
      }
      case 'plan': {
        for (const boardId of op.boards) {
          const s = this.h.store.read();
          const drafts = op.rebound.filter(
            (id) => s.tasks.find((t) => t.id === id)?.status === 'draft',
          );
          const onBoard = drafts.filter((id) =>
            s.boards
              .find((b) => b.id === boardId)
              ?.revisions.at(-1)!
              .taskIds.includes(id),
          );
          if (!onBoard.length) continue;
          const result = await reviewPlan(
            this.h,
            this.root,
            boardId,
            op.authorRuntime,
            this.runtimes,
            () => this.guard(op),
            onBoard,
          );
          if (result.status === 'awaiting-operator')
            throw new DomainError('Ревью плана ждёт оператора: ' + boardId);
          this.heartbeat(op);
        }
        this.advanceStep(op);
        return {};
      }
      case 'base': {
        // Перенос ограничен изменением контракта: рабочая ветка, несущая и
        // другую работу, переносится явно, а не заодно.
        const target = `refs/heads/${repo.targetBranch}`;
        const allowed = new Set([
          ...(op.proposal.file ? [op.proposal.file] : []),
          ...(op.proposal.artifacts ?? []).map((a) => a.path),
        ]);
        // Переносится ровно проверенный commit и только в компоненте
        // контракта: подготовка других компонентов остаётся за ведущим.
        const reviewed = op.expected.head;
        const paths = (
          await git(repo.path, 'log', '--format=', '--name-only', `${target}..${reviewed}`)
        )
          .split('\n')
          .filter(Boolean);
        const extra = [...new Set(paths.filter((p) => !allowed.has(p)))];
        if (extra.length)
          throw new DomainError(
            `Рабочая ветка несёт изменения вне контракта: ${extra.slice(0, 20).join(', ')}. Перенесите базу явно (base-update) и продолжите операцию`,
          );
        // Перенос базы — внешний эффект: сдвиг ref выполняется синхронно в той
        // же транзакции, что проверка владения. Отмена или перехват операции
        // либо видны проверке, либо происходят уже после сдвига — окна между
        // ними нет. Слияние до этого шага ничего не публикует.
        const updated = await updateBase(
          this.h.config,
          this.root,
          { [repo.id]: reviewed },
          (repoPath, target, to, from) =>
            this.h.store.atomic(() => {
              this.guard(op);
              // Внутри транзакции не исполняется чужой код: hook
              // reference-transaction, пишущий в ту же базу, ждал бы её, а
              // она — его. Ветка интеграции принадлежит контуру, и её
              // слияние уже идёт без hooks; срок ограничен на случай
              // зависшего Git.
              execFileSync(
                'git',
                ['-c', 'core.hooksPath=/dev/null', 'update-ref', target, to, from],
                { cwd: repoPath, timeout: ContractChanges.refMoveTimeoutMs },
              );
            }),
        );
        this.advanceStep(op, (current) => {
          if (updated.updated.length)
            this.log(
              current,
              'base',
              'moved',
              updated.updated.map((u) => `${u.repositoryId}:${u.to}`).join(', '),
            );
        });
        return {};
      }
      case 'release': {
        this.advanceStep(op, () => {
          this.h.release(op.id);
        });
        return {};
      }
    }
  }

  /**
   * Вход операции не изменился: ревью и перепривязка относятся к той
   * редакции, с которой операцию начали. Сдвинутая рабочая ветка или другой
   * документ — устаревшая операция, а не повод продолжать по новому тексту.
   */
  private async assertInputs(op: ContractChange) {
    const repo = repository(this.h.config, op.proposal.repositoryId ?? defaultOwner(this.h));
    const head = await git(repo.path, 'rev-parse', 'HEAD');
    if (head !== op.expected.head)
      throw new StaleChange(
        `Рабочая ветка сдвинулась (${op.expected.head.slice(0, 12)} → ${head.slice(0, 12)}): начните операцию заново по текущей редакции`,
      );
    const content = await contractContent(this.h, op.proposal, op.expected.head);
    const pinned = await pinArtifacts(repo, op.proposal.artifacts ?? [], op.expected.head);
    if (contractDigest(content, pinned.artifacts, 2) !== op.expected.proposedDigest)
      throw new StaleChange('Предложение изменилось после начала операции');
  }
}

class StaleChange extends DomainError {}
