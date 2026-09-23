import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profile } from '../src/runner/packs.ts';
import { config, fixture, input } from './helpers.ts';
import { declaredRoles, requiresContract } from '../src/core/repositories.ts';
import { loadConfig, readComponentConfig } from '../src/runner/config.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('Every pinned profile has an executable test gate and mobile limits concurrency', async () => {
  for (const id of [
    'react-vite-admin',
    'next-product',
    'go-api',
    'mobile-maestro',
    'python-api',
    'nest-api',
    'react-native',
    'expo-mobile',
  ]) {
    const pack = await profile(id);
    assert.equal(pack.id, id);
    assert.equal(pack.digest.length, 64);
    assert.ok(pack.gates.some((g) => g.kind === 'test' && g.report?.type === 'junit'));
    if (['mobile-maestro', 'react-native', 'expo-mobile'].includes(id))
      assert.equal(pack.concurrency, 1);
  }
  await assert.rejects(profile('../secret'));
});
test('Local config rejects same-runtime self-review, demo adapters and escaping reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-config-'));
  try {
    const file = join(root, 'config.json');
    let c = config({ repository: root, mode: 'local' });
    writeFileSync(file, JSON.stringify(c));
    assert.throws(() => loadConfig(file), /Demo/);
    c = config({ repository: root });
    c.gates[0].report!.path = '../outside.xml';
    writeFileSync(file, JSON.stringify(c));
    assert.throws(() => loadConfig(file), /внутри worktree/);
    c = config({
      repository: root,
      mode: 'local',
      roles: {
        architect: { runtime: 'codex' },
        backend: { runtime: 'codex' },
        frontend: { runtime: 'codex' },
        qa: { runtime: 'codex' },
      },
      reviewer: { runtime: 'codex' },
    });
    writeFileSync(file, JSON.stringify(c));
    assert.throws(() => loadConfig(file), /другой runtime/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A workspace declares its own roles, and a task cannot name one that is not declared', () => {
  const f = fixture();
  try {
    // Продукт с мобильным приложением не укладывается в четыре встроенные роли:
    // у мобильной разработки своя область записи, а тестировщик приложения и
    // тестировщик веба гоняют разные прогоны.
    f.h.config.roles.mobile = {
      runtime: 'claude',
      title: 'Мобильный разработчик',
      requiresContract: true,
      writePaths: ['apps/mobile'],
      reviewer: { runtime: 'codex' },
    };
    f.h.config.roles['qa-mobile'] = {
      runtime: 'codex',
      title: 'Тестировщик приложения',
      writePaths: ['apps/mobile'],
      reviewer: { runtime: 'claude' },
    };
    assert.deepEqual(
      declaredRoles(f.h.config).sort(),
      ['architect', 'backend', 'frontend', 'mobile', 'qa', 'qa-mobile'],
    );

    const b = f.h.createBoard('Board');
    const mobile = f.h.addTask(b.id, { ...input('Экран тренировки'), role: 'mobile' });
    assert.equal(mobile.role, 'mobile');

    // Незнакомая роль отклоняется: у неё нет ни области записи, ни runtime,
    // ни ревьюера — исполнителя для неё не существует.
    assert.throws(
      () => f.h.addTask(b.id, { ...input('Чужая роль'), role: 'designer' }),
      /не объявлена/,
    );

    // Требование контракта — свойство роли, а не список из двух имён: мобильная
    // разработка реализует тот же общий API.
    assert.equal(requiresContract(f.h.config, 'mobile'), true);
    assert.equal(requiresContract(f.h.config, 'qa-mobile'), false);
    assert.equal(requiresContract(f.h.config, 'backend'), true);
    assert.throws(() => f.h.approve(b.id), /контракт/);
  } finally {
    f.cleanup();
  }
});

test('A component keeps the roles its own profile brought, across a config reload', () => {
  // Роли профиля принадлежат компоненту, чей это профиль. Перезагрузка
  // component config заменяла объект ролей целиком, и mobile с qa-mobile
  // исчезали у того самого компонента, который их объявил.
  const root = mkdtempSync(join(tmpdir(), 'devcontour-component-'));
  try {
    writeFileSync(
      join(root, 'devcontour.component.json'),
      JSON.stringify({ roles: { backend: { runtime: 'codex', reviewer: { runtime: 'claude' } } } }),
    );
    const entry = readComponentConfig({
      id: 'mobile-app',
      name: 'Mobile',
      kind: 'product',
      path: root,
      configFile: 'devcontour.component.json',
      roles: {
        mobile: { runtime: 'claude', title: 'Мобильный разработчик' },
        backend: { runtime: 'claude' },
      },
    } as never) as { roles: Record<string, { runtime: string; title?: string }> };
    assert.equal(entry.roles.mobile.title, 'Мобильный разработчик', 'роль профиля сохранена');
    assert.equal(entry.roles.backend.runtime, 'codex', 'компонент уточняет свою роль');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
