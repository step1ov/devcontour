import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './helpers.ts';
import {
  budgetChecks,
  workspaceDeclaration,
  type DoctorCall,
} from '../src/runner/budget-doctor.ts';
import { doctor, doctorState } from '../src/runner/doctor.ts';
import { DevContour, loadedDigest } from '../src/core/service.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { Store } from '../src/core/store.ts';
import type { Config } from '../src/core/model.ts';

const now = Date.parse('2026-11-01T00:00:00Z');
const price = (model: string, effectiveAt = '2026-10-01T00:00:00Z') => ({
  runtime: 'codex' as const,
  model,
  effectiveAt,
  input: 2,
  output: 10,
  cacheRead: 0.1,
  cacheWrite: 2.5,
});
/** Исполнители — codex с закреплённой моделью, ревьюеры — claude (стоимость сообщает провайдер). */
const codex = (overrides: Partial<Config> = {}) =>
  config({
    mode: 'local',
    roles: Object.fromEntries(
      ['architect', 'backend', 'frontend', 'qa'].map((r) => [
        r,
        { runtime: 'codex', model: 'gpt-x', reviewer: { runtime: 'claude' } },
      ]),
    ),
    reviewer: { runtime: 'claude' },
    ...overrides,
  });
const call = (over: Partial<DoctorCall> = {}): DoctorCall => ({
  runtime: 'codex',
  model: 'gpt-x',
  startedAt: '2026-10-30T00:00:00Z',
  costSource: 'unknown',
  outcome: 'returned',
  ...over,
});
const byId = (checks: { id: string; status: string; detail: string }[]) =>
  Object.fromEntries(checks.map((c) => [c.id, c]));

test('doctor lists prices with effectiveAt and budget limits; a priced setup has no warnings', () => {
  const checks = byId(
    budgetChecks(
      codex({
        prices: [price('gpt-x'), price('gpt-x', '2026-11-05T00:00:00Z')],
        budgets: { task: { usd: 25 }, workspace: { timeMs: 3600000 }, onUnknown: 'stop' },
      }),
      [
        call({ costSource: 'tariff-estimate' }),
        call({ runtime: 'claude', costSource: 'provider-reported' }),
      ],
      undefined,
      now,
    ),
  );
  assert.match(checks.prices.detail, /codex\/gpt-x с 2026-10-01T00:00:00Z: input 2, output 10/);
  assert.match(checks.prices.detail, /с 2026-11-05T00:00:00Z/);
  assert.equal(
    checks.budgets.detail,
    'задача: 25 USD; доска: нет; workspace: 3600000 мс; onUnknown: stop',
  );
  assert.deepEqual(Object.keys(checks).sort(), ['budgets', 'prices']);
});

test('doctor warns about roles and recent calls without a price and about onUnknown stop', () => {
  // Тариф ещё не вступил в силу — модели роли он не покрывает.
  const stop = byId(
    budgetChecks(
      codex({
        prices: [price('gpt-x', '2026-12-01T00:00:00Z')],
        budgets: { task: { usd: 25 }, onUnknown: 'stop' },
      }),
      [
        call({ model: 'gpt-old' }),
        call({ model: null }),
        call({ model: null }),
        // Старые, идущие и оценённые вызовы не в счёт.
        call({ model: 'gpt-ancient', startedAt: '2026-08-01T00:00:00Z' }),
        call({ model: 'gpt-running', outcome: 'active' }),
        call({ model: 'gpt-priced', costSource: 'provider-reported' }),
      ],
      undefined,
      now,
    ),
  );
  assert.equal(stop['prices:roles'].status, 'degraded');
  assert.match(stop['prices:roles'].detail, /codex\/gpt-x — main:architect, main:backend/);
  assert.doesNotMatch(stop['prices:roles'].detail, /ревьюер/);
  assert.match(stop['prices:calls'].detail, /codex\/gpt-old — 1; codex \(модель не сообщена\) — 2/);
  assert.doesNotMatch(stop['prices:calls'].detail, /ancient|running|priced/);
  assert.match(stop['budgets:on-unknown'].detail, /выдача в его области остановится/);
  assert.equal(stop['budgets:prices'], undefined);

  // continue: не остановка, а нижняя граница — пока у runtime нет ни одного тарифа.
  const lower = byId(
    budgetChecks(
      codex({ budgets: { board: { usd: 40 }, onUnknown: 'continue' } }),
      [],
      undefined,
      now,
    ),
  );
  assert.equal(lower['budgets:on-unknown'], undefined);
  assert.match(lower['budgets:prices'].detail, /тарифов для codex нет/);

  // Только бюджет времени: тарифы ему не нужны.
  const time = byId(
    budgetChecks(
      codex({ budgets: { task: { timeMs: 1000 }, onUnknown: 'stop' } }),
      [],
      undefined,
      now,
    ),
  );
  assert.equal(time['budgets:on-unknown'], undefined);
  assert.equal(time['budgets:prices'], undefined);
});

test('doctor names a divergence of config.json from the workspace.json declaration', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-budget-doctor-'));
  try {
    const budgets = { task: { usd: 25 }, onUnknown: 'continue' as const };
    writeFileSync(
      join(root, 'workspace.json'),
      JSON.stringify({ budgets: { task: { usd: 25 }, onUnknown: 'continue' } }),
    );
    const declared = workspaceDeclaration(codex({ workspaceRoot: root }));
    assert.deepEqual(declared, { budgets });
    const same = byId(budgetChecks(codex({ budgets }), [], declared, now));
    assert.equal(same['budgets:declaration'], undefined);
    const local = byId(
      budgetChecks(
        codex({ budgets: { task: { usd: 100 }, onUnknown: 'continue' } }),
        [],
        declared,
        now,
      ),
    );
    assert.match(
      local['budgets:declaration'].detail,
      /расходится с объявлением workspace\.json: budgets/,
    );
    // Необъявленные prices — только локальные: расхождения нет.
    assert.doesNotMatch(local['budgets:declaration'].detail, /prices/);
    // Нечитаемый реестр расхождение не проверяет и doctor не роняет.
    writeFileSync(join(root, 'workspace.json'), '{');
    assert.equal(workspaceDeclaration(codex({ workspaceRoot: root })), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor names a divergence of inputPolicy from the workspace.json declaration', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-budget-doctor-'));
  try {
    writeFileSync(
      join(root, 'workspace.json'),
      JSON.stringify({ inputPolicy: { threshold: 9, criticalPaths: ['db/migrations'] } }),
    );
    const declared = workspaceDeclaration(codex({ workspaceRoot: root }));
    const inputPolicy = { threshold: 9, criticalPaths: ['db/migrations'] };
    assert.deepEqual(declared, { inputPolicy });
    const same = byId(budgetChecks(codex({ inputPolicy }), [], declared, now));
    assert.equal(same['budgets:declaration'], undefined);
    const local = byId(budgetChecks(codex({ inputPolicy: { threshold: 3 } }), [], declared, now));
    assert.equal(local['budgets:declaration'].status, 'degraded');
    assert.match(
      local['budgets:declaration'].detail,
      /расходится с объявлением workspace\.json: inputPolicy/,
    );
    // Локальный файл без порога при объявленном — тоже расхождение.
    const absent = byId(budgetChecks(codex(), [], declared, now));
    assert.match(absent['budgets:declaration'].detail, /inputPolicy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid inputPolicy in workspace.json is reported and does not switch off the budgets comparison', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-budget-doctor-'));
  try {
    const budgets = { task: { usd: 25 }, onUnknown: 'continue' as const };
    writeFileSync(
      join(root, 'workspace.json'),
      JSON.stringify({ budgets, inputPolicy: { threshold: 12 } }),
    );
    const declared = workspaceDeclaration(codex({ workspaceRoot: root }));
    assert.deepEqual(declared, { budgets, invalid: ['inputPolicy'] });
    const checks = byId(
      budgetChecks(
        codex({ budgets: { task: { usd: 100 }, onUnknown: 'continue' } }),
        [],
        declared,
        now,
      ),
    );
    assert.match(
      checks['budgets:declaration'].detail,
      /расходится с объявлением workspace\.json: budgets\./,
    );
    assert.equal(checks['budgets:declaration-invalid'].status, 'degraded');
    assert.match(checks['budgets:declaration-invalid'].detail, /неверное значение: inputPolicy\./);
    // Совпадающие budgets: расхождения нет, неверный ключ назван.
    const same = byId(budgetChecks(codex({ budgets }), [], declared, now));
    assert.equal(same['budgets:declaration'], undefined);
    assert.ok(same['budgets:declaration-invalid']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctorState reads call records for the price check without a writer', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-budget-doctor-'));
  try {
    const store = new Store(join(root, 'state.sqlite'));
    store.atomic(() =>
      store.saveLocal('usage', undefined, 'U1', {
        id: 'U1',
        stage: 'implementation',
        runtime: 'codex',
        model: 'gpt-old',
        runtimeVersion: null,
        startedAt: '2026-10-30T00:00:00Z',
        outcome: 'returned',
        promptBytes: 1,
        promptDigest: 'd',
        usage: {},
        costUsd: null,
        costSource: 'unknown',
      }),
    );
    store.close();
    const { calls } = doctorState(codex(), root);
    assert.deepEqual(calls, [
      {
        runtime: 'codex',
        model: 'gpt-old',
        startedAt: '2026-10-30T00:00:00Z',
        costSource: 'unknown',
        outcome: 'returned',
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor itself reports prices, budgets, unpriced calls and a config not yet applied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-budget-doctor-'));
  try {
    // Роли demo: остальные проверки doctor не зовут внешних runtime.
    const c = config({
      prices: [price('gpt-x')],
      budgets: { task: { usd: 25 }, onUnknown: 'continue' },
    });
    const live = { owner: 'server', leaseUntil: Date.now() + 60000 };
    const report = async (digest?: string) =>
      byId(
        (
          await doctor(
            c,
            root,
            false,
            {
              leader: live,
              runs: [],
              ...(digest ? { appliedConfig: { digest, at: '2026-11-01T00:00:00Z', by: 's' } } : {}),
            },
            undefined,
            [call({ model: 'gpt-old', startedAt: new Date().toISOString() })],
          )
        ).checks,
      );
    let checks = await report(loadedDigest(c));
    assert.match(checks.prices?.detail ?? '', /codex\/gpt-x с 2026-10-01T00:00:00Z/);
    assert.equal(
      checks.budgets?.detail,
      'задача: 25 USD; доска: нет; workspace: нет; onUnknown: continue',
    );
    assert.equal(checks['prices:calls']?.status, 'degraded');
    assert.match(checks['prices:calls'].detail, /codex\/gpt-old — 1/);
    // Файл совпадает с применённой конфигурацией — замечания нет.
    assert.equal(checks['budgets:applied'], undefined);
    // Применена другая конфигурация: показанное из файла ещё не действует.
    checks = await report('f'.repeat(64));
    assert.equal(checks['budgets:applied']?.status, 'degraded');
    assert.match(
      checks['budgets:applied'].detail,
      /Не применено — выполните devcontour config-apply --keys budgets,prices/,
    );
    // Контур не запускался — сравнивать не с чем.
    assert.equal((await report())['budgets:applied'], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('after context-lock doctor names the re-pinned keys instead of budgets:applied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-budget-doctor-'));
  try {
    const repo = join(root, 'repo'),
      data = join(root, 'data');
    mkdirSync(repo);
    mkdirSync(data);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'guide.md'), 'v1');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      'g',
    ]);
    const pack = {
      id: 'guide',
      version: '1',
      repositoryId: 'main',
      roles: ['qa'],
      files: ['guide.md'],
      references: [],
    };
    const c = config({
      repository: repo,
      contextPacks: [pack],
      budgets: { task: { usd: 25 }, onUnknown: 'continue' },
    });
    // Сервер применил конфигурацию и запомнил digest её ключей.
    const store = new Store(join(data, 'state.sqlite'));
    const scheduler = new Scheduler(new DevContour(store, c), data);
    await scheduler.init();
    await scheduler.tick();
    await scheduler.stop();
    store.close();
    const report = async (next: Config) => {
      const { state, check, calls, newState, appliedKeys } = doctorState(next, data);
      assert.ok(state, check?.detail);
      assert.equal(appliedKeys?.digest, state.appliedConfig?.digest);
      return byId(
        (await doctor(next, data, false, { ...state, appliedKeys }, check, calls, newState)).checks,
      );
    };
    // context-lock меняет только contextPacks: бюджеты действуют.
    const locked = {
      ...c,
      contextPacks: [{ ...pack, revision: 'a'.repeat(40), digest: 'b'.repeat(64) }],
    };
    let checks = await report(locked);
    assert.equal(checks['budgets:applied'], undefined);
    assert.equal(checks['config:applied']?.status, 'passed');
    assert.match(checks['config:applied'].detail, /ключами contextPacks; prices и budgets те же/);
    assert.match(checks['config:applied'].detail, /Следующий запуск serve/);
    // Правка бюджета вместе с перезакреплением — budgets:applied с ключами.
    checks = await report({ ...locked, budgets: { task: { usd: 50 }, onUnknown: 'continue' } });
    assert.equal(checks['budgets:applied']?.status, 'degraded');
    assert.match(checks['budgets:applied'].detail, /\(ключи budgets, contextPacks\)/);
    assert.equal(checks['config:applied'], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
