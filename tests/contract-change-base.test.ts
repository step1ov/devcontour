import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractChanges, type ContractChange } from '../src/runner/contract-change.ts';
import { contractImpact } from '../src/runner/contract-impact.ts';
import { type AgentAdapter } from '../src/runner/adapters.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { busyWork } from '../src/runner/reconfigure.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { gitCommand, stage } from './contract-change-fixture.ts';

test('A redaction committed after review makes the operation stale and moves nothing', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Ревью одобрило схему number; после него в тот же файл закоммитили boolean.
    const stopped = await s
      .changes((step) => {
        if (step === 'review') throw new Error('stop after review');
      })
      .advance(operation.id);
    assert.equal(stopped.next, 'rebind');
    const base = s.sh('rev-parse', 'devcontour/accepted');
    await writeFile(join(s.repo, 'schema.json'), '{"price":"boolean"}\n');
    s.sh('commit', '-qam', 'boolean after review');
    const resumed = await s.changes().advance(operation.id);
    assert.equal(resumed.status, 'stale', resumed.error);
    assert.equal(s.sh('rev-parse', 'devcontour/accepted'), base, 'база не сдвинута');
    assert.equal(s.task(s.api.id).hold?.operation, operation.id, 'удержание сохранено');
    assert.deepEqual(s.task(s.api.id).contracts, [s.c1.id], 'перепривязки не было');
  } finally {
    await s.remove();
  }
});

test('A review answer that arrives after the operation was taken over registers nothing', async () => {
  const s = await stage();
  try {
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    // Первый владелец зависает в ревью контракта дольше своего lease.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const slow = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      async execute() {
        entered();
        await held;
        return {
          data: { approved: true, summary: 'Late', findings: [], discoveries: [] },
          log: 'fixture',
          command: ['fixture'],
        };
      },
    });
    const first = new ContractChanges(s.h, s.root, {
      codex: slow('codex'),
      claude: slow('claude'),
    });
    const late = first.advance(operation.id);
    await started;
    s.store.atomic(() =>
      s.store.saveLocal('contract-change', operation.owner, operation.id, {
        ...first.get(operation.id),
        leaseUntil: Date.now() - 1,
      }),
    );
    // Второй владелец штатно перехватывает и завершает операцию.
    const second = await s.changes().advance(operation.id);
    assert.equal(second.status, 'completed', second.error);
    const c2 = s.store.read().contracts.at(-1)!;
    // Запоздавший ответ первого владельца приходит после этого.
    release();
    await late;
    assert.equal(s.store.read().contracts.length, 2, 'запоздавшее ревью не создало редакцию');
    assert.deepEqual(s.task(s.api.id).contracts, [c2.id]);
    assert.equal(s.changes().get(operation.id).status, 'completed');
  } finally {
    await s.remove();
  }
});

test('Operator mode keeps contract changes with the operator', async () => {
  const s = await stage();
  try {
    s.h.config.approvalMode = 'operator';
    await assert.rejects(s.changes().start(s.proposal, 'codex'), /оператор/);
  } finally {
    await s.remove();
  }
});

test('A base move cannot happen after the operation was abandoned inside the base step', async () => {
  const s = await stage();
  const other = new Store(join(s.root, 'state.sqlite'));
  const second = new ContractChanges(
    new DevContour(other, { ...s.h.config, mode: 'demo' }),
    s.root,
  );
  const realSpawn = cp.spawn;
  try {
    const before = s.sh('rev-parse', 'devcontour/accepted');
    let armed = false;
    const held: { operation?: ContractChange } = {};
    let abandoned: string | undefined;
    // Окно — внутри переноса базы, после проверки входа и до сдвига ref:
    // lease истекает, и другой процесс штатно отменяет операцию.
    cp.spawn = function (this: unknown, command: string, args: string[], options: unknown) {
      if (
        armed &&
        command === 'git' &&
        gitCommand(args)[0] === 'rev-parse' &&
        gitCommand(args)[1] === 'refs/heads/devcontour/accepted'
      ) {
        armed = false;
        other.atomic(() =>
          other.saveLocal('contract-change', held.operation!.owner, held.operation!.id, {
            ...second.get(held.operation!.id),
            leaseUntil: Date.now() - 1,
          }),
        );
        abandoned = second.abandon(held.operation!.id).status;
      }
      return realSpawn.call(this, command, args, options as never);
    } as typeof cp.spawn;
    syncBuiltinESMExports();
    const changes = s.changes((step) => {
      if (step === 'rebind') armed = true;
    });
    const { operation } = (await changes.start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    held.operation = operation;
    await changes.advance(operation.id);
    assert.equal(abandoned, 'abandoned');
    assert.equal(s.sh('rev-parse', 'devcontour/accepted'), before, 'база не сдвинута после отмены');
    assert.equal(s.changes().get(operation.id).status, 'abandoned');
  } finally {
    cp.spawn = realSpawn;
    syncBuiltinESMExports();
    other.close();
    await s.remove();
  }
});

test('The base ref move inside the transaction runs no repository hooks', async () => {
  const s = await stage();
  try {
    // Hook reference-transaction, который ждёт ту же базу, — взаимное
    // ожидание, пока транзакция держит её на время git update-ref.
    const marker = join(s.root, 'hook-ran');
    const hook = join(s.repo, '.git', 'hooks', 'reference-transaction');
    // Срабатывает только на сдвиге ветки интеграции: Git передаёт
    // обновляемые ref на stdin.
    await writeFile(
      hook,
      `#!/bin/sh\nif grep -q 'refs/heads/devcontour/accepted'; then touch ${JSON.stringify(marker)}; sleep 5; fi\n`,
    );
    await chmod(hook, 0o755);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    let worst = 0;
    let last = Date.now();
    const probe = setInterval(() => {
      worst = Math.max(worst, Date.now() - last);
      last = Date.now();
    }, 20);
    const done = await s.changes().advance(operation.id);
    clearInterval(probe);
    assert.equal(done.status, 'completed', done.error);
    assert.equal(existsSync(marker), false, 'hook внутри транзакции не запускался');
    assert.ok(worst < 4000, `event loop стоял ${worst} мс`);
    assert.equal(
      s.sh('rev-parse', 'devcontour/accepted:schema.json'),
      s.sh('rev-parse', 'HEAD:schema.json'),
    );
  } finally {
    await s.remove();
  }
});

test('A hung git update-ref inside the transaction is stopped by its time limit', async () => {
  const s = await stage();
  const shim = await mkdtemp(join(tmpdir(), 'devcontour-git-shim-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const path = process.env.PATH;
  const limit = ContractChanges.refMoveTimeoutMs;
  // Тест ставит свой короткий предел; рабочий предел должен быть конечным
  // и короче lease, иначе зависший Git держал бы базу контура без срока.
  assert.ok(
    Number.isFinite(limit) && limit > 0 && limit <= 60000,
    `рабочий предел сдвига ref: ${limit} мс`,
  );
  try {
    // Git, который зависает только на сдвиге ref; остальное — настоящий Git.
    await writeFile(
      join(shim, 'git'),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = update-ref ] && exec sleep 60; done\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    await chmod(join(shim, 'git'), 0o755);
    const { operation } = (await s.changes().start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    const before = s.sh('rev-parse', 'devcontour/accepted');
    ContractChanges.refMoveTimeoutMs = 1500;
    // Обёртка действует только на шаге переноса базы: замер не зависит от
    // скорости предыдущих шагов под нагрузкой.
    let baseStarted = 0;
    const failed = await s
      .changes((step) => {
        if (step === 'rebind') {
          process.env.PATH = `${shim}:${path}`;
          baseStarted = Date.now();
        }
      })
      .advance(operation.id);
    const baseTook = Date.now() - baseStarted;
    process.env.PATH = path;
    // Без предела шаг ждал бы зависший Git целиком (60 с).
    assert.ok(baseTook < 30000, `шаг переноса базы занял ${baseTook} мс`);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.next, 'base');
    assert.equal(s.sh('rev-parse', 'devcontour/accepted'), before, 'база не сдвинута');
    // Операция продолжается после устранения причины.
    const done = await s.changes().advance(operation.id);
    assert.equal(done.status, 'completed', done.error);
  } finally {
    process.env.PATH = path;
    ContractChanges.refMoveTimeoutMs = limit;
    await rm(shim, { recursive: true, force: true });
    await s.remove();
  }
});

test('A contract file registered under another component is named, not treated as a new contract', async () => {
  const s = await stage();
  try {
    // Контракт зарегистрирован как общий; предложение называет компонент.
    const other = { ...s.proposal, repositoryId: 'main' };
    const impact = (await contractImpact(s.h, other)) as {
      status: string;
      warning?: string;
      registeredUnder?: string[];
    };
    assert.equal(impact.status, 'new');
    assert.deepEqual(impact.registeredUnder, ['(общий)']);
    assert.match(impact.warning ?? '', /уже зарегистрирован как контракт/);
    await assert.rejects(s.changes().start(other, 'codex'), /уже зарегистрирован/);
    assert.equal(s.store.read().contracts.length, 1, 'параллельный контракт не заведён');
  } finally {
    await s.remove();
  }
});

test('C-F05b: идущая поставка и preview держат применение конфигурации так же, как попытки', async () => {
  const s = await stage();
  try {
    const live = Date.now() + 60_000;
    s.store.change('fixture.busy', (st) => {
      st.changeSets.push({
        id: 'CHG-busy',
        title: 'Busy change',
        description: 'Идёт поставка набора',
        boardIds: [],
        createdAt: new Date().toISOString(),
        verifications: [],
        deliveries: [
          {
            id: 'D-live',
            verificationId: 'V-none',
            manifestDigest: 'a'.repeat(64),
            policyDigest: 'b'.repeat(64),
            token: 'delivery-token-00000000000000001',
            leaseUntil: live,
            status: 'active',
            startedAt: new Date().toISOString(),
            components: {},
          },
        ],
      });
      st.previewLock = { token: 'preview-token-0001', kind: 'deploy', leaseUntil: live };
    });
    assert.deepEqual(busyWork(s.h).sort(), ['D-live', 'preview']);
    s.h.requestReconfigure('CC-busy', s.h.configDigest);
    assert.equal(
      s.h.settleReconfigure('CC-busy', s.h.configDigest, 'server'),
      undefined,
      'поставка и preview держат применение',
    );
    assert.equal(s.store.read().reconfigure?.appliedAt, undefined);
    s.store.change('fixture.idle', (st) => {
      st.changeSets.find((c) => c.id === 'CHG-busy')!.deliveries![0].status = 'delivered';
      st.previewLock = undefined;
    });
    assert.deepEqual(busyWork(s.h), []);
    assert.ok(s.h.settleReconfigure('CC-busy', s.h.configDigest, 'server'));
    assert.ok(s.store.read().reconfigure?.appliedAt, 'после окончания работ — применено');
  } finally {
    await s.remove();
  }
});

test('Перенос базы операцией — ровно проверенный SHA, а не HEAD рабочей ветки; ветки и подсказки DevContour', async () => {
  const s = await stage();
  try {
    const reviewed = s.sh('rev-parse', 'HEAD');
    await writeFile(join(s.repo, 'later.txt'), 'появилось после проверки\n');
    s.sh('add', '.');
    s.sh('commit', '-qm', 'later');
    const branch = s.h.config.targetBranch;
    const moved = await updateBase(s.h.config, s.root, { main: reviewed });
    assert.equal(s.sh('rev-parse', `refs/heads/${branch}`), reviewed, 'перенесён проверенный SHA');
    assert.equal(moved.updated[0]?.to, reviewed);
    assert.equal(moved.updated[0]?.branch, branch);
    assert.equal(moved.updated[0]?.kind, 'fast-forward');
    // Без ограничения — до HEAD рабочей ветки.
    const all = await updateBase(s.h.config, s.root);
    assert.equal(all.updated[0]?.to, s.sh('rev-parse', 'HEAD'));
    assert.match(all.next, /База обновлена/);
  } finally {
    await s.remove();
  }
});

test('Утрата владения операцией перед самым сдвигом ref — сдвига нет: проверка владения и update-ref в одной транзакции', async () => {
  const s = await stage();
  const other = new Store(join(s.root, 'state.sqlite'));
  const second = new ContractChanges(
    new DevContour(other, { ...s.h.config, mode: 'demo' }),
    s.root,
  );
  const realSpawn = cp.spawn;
  try {
    const before = s.sh('rev-parse', 'devcontour/accepted');
    let armed = false;
    let expired = false;
    const held: { operation?: ContractChange } = {};
    // Окно — после всех чтений переноса базы, непосредственно перед сдвигом:
    // последний `rev-list` перед update-ref. Срок владения истекает.
    cp.spawn = function (this: unknown, command: string, args: string[], options: unknown) {
      if (
        armed &&
        command === 'git' &&
        gitCommand(args)[0] === 'rev-list' &&
        String(gitCommand(args)[2] ?? '').endsWith('..refs/heads/devcontour/accepted')
      ) {
        armed = false;
        other.atomic(() =>
          other.saveLocal('contract-change', held.operation!.owner, held.operation!.id, {
            ...second.get(held.operation!.id),
            leaseUntil: Date.now() - 1,
          }),
        );
        expired = true;
      }
      return realSpawn.call(this, command, args, options as never);
    } as typeof cp.spawn;
    syncBuiltinESMExports();
    const changes = s.changes((step) => {
      if (step === 'rebind') armed = true;
    });
    const { operation } = (await changes.start(s.proposal, 'codex')) as {
      operation: ContractChange;
    };
    held.operation = operation;
    const result = await changes.advance(operation.id);
    assert.ok(expired, 'владение истекло внутри переноса базы');
    assert.match(result.error ?? '', /Владение операцией изменения контракта утрачено/);
    assert.equal(s.sh('rev-parse', 'devcontour/accepted'), before, 'база не сдвинута');
  } finally {
    cp.spawn = realSpawn;
    syncBuiltinESMExports();
    other.close();
    await s.remove();
  }
});
