import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScratch, removeScratch } from './test-scratch.mjs';

/** A disposable user environment inherited by test workers and their subprocesses. */
export function testEnvironment(base = process.env) {
  const originalHome = (process.platform === 'win32' ? base.USERPROFILE : base.HOME) || homedir();
  const originalCache =
    process.platform === 'darwin'
      ? join(originalHome, 'Library', 'Caches')
      : process.platform === 'win32'
        ? base.LOCALAPPDATA || join(originalHome, 'AppData', 'Local')
        : base.XDG_CACHE_HOME || join(originalHome, '.cache');
  // Browser installations are executable tooling, not disposable test data.
  // Match Playwright's effective override, including the special value "0".
  const browserOverride =
    base.PLAYWRIGHT_BROWSERS_PATH ??
    base.npm_config_playwright_browsers_path ??
    base.npm_package_config_playwright_browsers_path;
  const browsers = browserOverride || join(originalCache, 'ms-playwright');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-suite-home-')));
  const scratch = createScratch('dr-');
  const cache = join(home, '.cache');
  const config = join(home, '.config');
  for (const dir of [cache, config, join(home, 'Library', 'Caches')])
    mkdirSync(dir, { recursive: true });
  // Some fixtures intentionally forward only PATH/HOME/TMPDIR to Git children.
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = DevContour test\n\temail = test@example.invalid\n[commit]\n\tgpgSign = false\n',
  );
  const npmrc = join(home, '.npmrc');
  writeFileSync(npmrc, '');
  // Docker Desktop installs CLI plugins beside its user config. Keep executable
  // discovery and the selected endpoint, without copying registry credentials.
  const dockerConfig = join(home, '.docker');
  mkdirSync(dockerConfig);
  writeFileSync(
    join(dockerConfig, 'config.json'),
    JSON.stringify({
      cliPluginsExtraDirs: [
        join(base.DOCKER_CONFIG || join(base.HOME || homedir(), '.docker'), 'cli-plugins'),
      ],
    }),
  );
  const context = spawnSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    {
      env: base,
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  const dockerHost = base.DOCKER_HOST || (context.status === 0 ? context.stdout.trim() : '');
  return {
    home,
    env: {
      ...base,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: scratch,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      PLAYWRIGHT_BROWSERS_PATH: browsers,
      DOCKER_CONFIG: dockerConfig,
      DOCKER_CONTEXT: '',
      ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}),
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
      GIT_AUTHOR_NAME: 'DevContour test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'DevContour test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      npm_config_cache: join(cache, 'npm'),
      NPM_CONFIG_CACHE: join(cache, 'npm'),
      npm_config_userconfig: npmrc,
      NPM_CONFIG_USERCONFIG: npmrc,
    },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      removeScratch(scratch, 'dr-');
    },
  };
}
