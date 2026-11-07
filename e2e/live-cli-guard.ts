import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Запрет живых CLI в e2e. Исполнитель и ревьюер сценариев — учебный runtime
// `demo` (fixture, не модель); `claude` и `codex` на PATH заменены
// заглушками, которые отказывают (код 97) и отмечают вызов. Регрессия, при
// которой demo-путь снова зовёт живой CLI, падает громко, а не тратит
// подписку молча. `--version` отвечает, чтобы проверка среды не менялась.

/** Каталог заглушек общего сервера e2e: задаётся playwright.config. */
export const sharedGuardEnv = 'DEVCONTOUR_E2E_CLI_GUARD';

/** Пишет заглушки `claude` и `codex` в `<dir>/bin`; вызовы — в `<dir>/live-runtime-called`. */
export function writeLiveCliGuard(dir: string) {
  const bin = join(dir, 'bin');
  const marker = join(dir, 'live-runtime-called');
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex'])
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${name} guard"; exit 0; fi\necho "${name} $*" >> '${marker}'\nexit 97\n`,
      { mode: 0o755 },
    );
  return { bin, marker, called: () => (existsSync(marker) ? readFileSync(marker, 'utf8') : '') };
}

/**
 * Подключает запрет к спецификации: общий сервер e2e уже запущен с
 * заглушками на PATH (playwright.config), серверы `startWorkspace` в процессе
 * теста получают их через PATH воркера. После каждого теста новых вызовов
 * живых CLI нет.
 */
export function useLiveCliGuard() {
  const dir = process.env[sharedGuardEnv];
  if (!dir) throw new Error(`${sharedGuardEnv} не задан: e2e запускаются через playwright.config`);
  const guard = writeLiveCliGuard(dir);
  let path: string | undefined;
  let seen = 0;
  test.beforeAll(() => {
    path = process.env.PATH;
    process.env.PATH = guard.bin + delimiter + (path ?? '');
  });
  test.afterAll(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  });
  test.beforeEach(() => {
    seen = guard.called().length;
  });
  test.afterEach(() => {
    expect(guard.called().slice(seen), 'живой CLI вызван в e2e').toBe('');
  });
}

/** Подменённый домашний каталог, автор Git и запрет живых CLI на время теста. */
export function isolate(home: string) {
  const guard = writeLiveCliGuard(home);
  mkdirSync(join(home, 'Library', 'Caches'), { recursive: true });
  mkdirSync(join(home, '.cache'), { recursive: true });
  const keys = [
    'HOME',
    'XDG_CACHE_HOME',
    'PATH',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    PATH: guard.bin + delimiter + (saved.PATH ?? ''),
    GIT_AUTHOR_NAME: 'Flow UI',
    GIT_AUTHOR_EMAIL: 'flow-ui@example.invalid',
    GIT_COMMITTER_NAME: 'Flow UI',
    GIT_COMMITTER_EMAIL: 'flow-ui@example.invalid',
  });
  return {
    called: guard.called,
    restore() {
      for (const k of keys)
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    },
  };
}
