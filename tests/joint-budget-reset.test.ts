import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command } from '../src/runner/process.ts';
import { WorkspaceRunner } from '../src/runner/workspace.ts';
import { agentOperations } from '../src/application/agent.ts';
import { jointFixture } from './joint-fixture.ts';

type Fixture = Awaited<ReturnType<typeof jointFixture>>;

/**
 * Совместная проверка, остановленная хостом до первого gate: остановка
 * сразу после начала (начало синхронно, gates ещё не начались).
 */
async function stopped(f: Fixture) {
  const runner = new WorkspaceRunner(f.h, f.root);
  const run = runner.verify(f.change.id);
  assert.equal(f.verifications().at(-1)!.status, 'active');
  await runner.stop();
  await run.catch(() => undefined);
  return f.verifications().at(-1)!;
}

test('Остановка хоста прерывает проверку с отметкой interrupted; предел ChangeSet такие проверки не тратят', async () => {
  const f = await jointFixture({ gateMs: 120_000, maxAttempts: 2, start: false });
  try {
    for (let i = 0; i < 2; i++) {
      const v = await stopped(f);
      assert.equal(v.status, 'failed');
      assert.equal(v.evidence.length, 0);
      // Сигнал остановки хоста дошёл до движка: проверка — прерывание.
      assert.equal(v.interrupted, true, JSON.stringify(v));
    }
    // Две прерванные проверки при пределе 2: ChangeSet начинает третью.
    const third = f.workspace.start(f.change.id);
    assert.equal(third.status, 'active');
  } finally {
    await f.cleanup();
  }
});

test('Сброс бюджета оператором снимает проверки без результата gates; отказ называет команду; агенту и --by host он недоступен', async () => {
  const f = await jointFixture({ gateMs: 120_000, maxAttempts: 2, start: false });
  try {
    await stopped(f);
    await stopped(f);
    // Проверки, прерванные прежними версиями, отметки не имеют и предел тратят.
    f.store.change('fixture.legacy', (s) => {
      for (const v of s.changeSets[0].verifications) delete v.interrupted;
    });
    assert.throws(
      () => f.workspace.start(f.change.id),
      (e: Error) =>
        e.message.startsWith(
          'Исчерпан лимит попыток ChangeSet (2): засчитано проверок набора 2 из 2',
        ) &&
        e.message.includes('Без результата gates — 2') &&
        // Ведущему — просьба к пользователю, а не готовая команда.
        e.message.includes('попросите пользователя снять предел командой оператора') &&
        !/devcontour\s+changeset-budget-reset|changeset-budget-reset\s+--/.test(e.message),
    );
    // Решение человека: в каталоге агента операции нет, CLI отклоняет --by host.
    assert.ok(!agentOperations.some((op) => /budget/i.test(op)));
    const cli = (...extra: string[]) =>
      command(
        [
          'node',
          '--import',
          'tsx',
          'src/cli.ts',
          'changeset-budget-reset',
          '--changeset',
          f.change.id,
          '--data',
          f.root,
          ...extra,
        ],
        process.cwd(),
      );
    const host = await cli('--reason', 'restart', '--by', 'host');
    assert.notEqual(host.code, 0);
    assert.match(host.stderr + host.stdout, /решение оператора/);
    const noReason = await cli();
    assert.notEqual(noReason.code, 0);
    assert.match(noReason.stderr + noReason.stdout, /--reason/);
    assert.throws(() => f.workspace.budgetReset(f.change.id, '  '), /причину/);
    const reset = f.workspace.budgetReset(f.change.id, 'Stopped by a server restart');
    assert.equal(reset.actor, 'operator');
    assert.deepEqual(
      [...reset.settledVerificationIds].sort(),
      f
        .verifications()
        .map((v) => v.id)
        .sort(),
    );
    // Нечего снимать — сброс отклоняется и не записывается.
    assert.throws(() => f.workspace.budgetReset(f.change.id, 'again'));
    const next = f.workspace.start(f.change.id);
    assert.equal(next.status, 'active');
  } finally {
    await f.cleanup();
  }
});
