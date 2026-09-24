import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profile } from '../src/runner/packs.ts';
import { config, fixture, input } from './helpers.ts';
import { declaredRoles, requiresContract } from '../src/core/repositories.ts';
import { loadConfig, readComponentConfig } from '../src/runner/config.ts';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
    }) as { roles: Record<string, { runtime: string; title?: string }> };
    assert.equal(entry.roles.mobile.title, 'Мобильный разработчик', 'роль профиля сохранена');
    assert.equal(entry.roles.backend.runtime, 'codex', 'компонент уточняет свою роль');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A stack pack arrives on declaration, and a library that moved ahead is a decision', async () => {
  const { deliverContextPacks, outdatedContextPacks, adoptContextPack } = await import(
    '../src/runner/context-library.ts'
  );
  const repo = mkdtempSync(join(tmpdir(), 'devcontour-library-'));
  const pack = {
    id: 'design-system',
    version: '1.0.0',
    files: ['.agents/context/design-system.md'],
    references: [],
  };
  try {
    // Знание стека приезжает по объявлению, а не лежит в каждом проекте.
    assert.deepEqual(await deliverContextPacks(repo, [pack]), pack.files);
    const delivered = readFileSync(join(repo, pack.files[0]), 'utf8');
    assert.match(delivered, /Общий дизайн/);

    // Повторная доставка не трогает файл: продукт мог его дополнить, а пакет
    // закреплён по digest — молчаливая замена сделала бы закрепление ложью.
    writeFileSync(join(repo, pack.files[0]), delivered + '\n<!-- дополнение продукта -->\n');
    assert.deepEqual(await deliverContextPacks(repo, [pack]), []);
    assert.match(readFileSync(join(repo, pack.files[0]), 'utf8'), /дополнение продукта/);

    // Библиотека ушла вперёд — это видно и решается явно.
    const stale = await outdatedContextPacks(repo, [pack]);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, 'design-system');
    assert.notEqual(stale[0].library, pack.version);

    const adopted = await adoptContextPack(repo, pack);
    assert.equal(adopted.version, stale[0].library);
    assert.doesNotMatch(readFileSync(join(repo, pack.files[0]), 'utf8'), /дополнение продукта/);
    assert.deepEqual(await outdatedContextPacks(repo, [{ ...pack, version: adopted.version }]), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('A task whose write scope cannot meet its role is refused before dispatch', () => {
  const f = fixture();
  try {
    f.h.config.roles.engine = {
      runtime: 'claude',
      title: 'Разработчик ядра',
      writePaths: ['packages/engine/src'],
      reviewer: { runtime: 'codex' },
    };
    const b = f.h.createBoard('Board');
    // Область записи — пересечение роли и задачи. Когда они не пересекаются,
    // исполнитель не вправе изменить ни одного файла: прогон отработал бы,
    // потратил попытку и упёрся в «файлы вне области», хотя причина в
    // постановке и видна была до выдачи.
    assert.throws(
      () =>
        f.h.addTask(b.id, {
          ...input('Задача мимо роли'),
          role: 'engine',
          writePaths: ['apps/api'],
        }),
      /не пересекается с областью роли/,
    );
    const ok = f.h.addTask(b.id, {
      ...input('Задача внутри роли'),
      role: 'engine',
      writePaths: ['packages/engine/src/solve.ts'],
    });
    assert.equal(ok.role, 'engine');
  } finally {
    f.cleanup();
  }
});
