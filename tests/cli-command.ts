import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// How tests start the DevContour CLI in a child process.
//
// By default from source through the tsx loader: it works in any checkout,
// with or without a build. `npm run check` builds lib/ before the Node suite
// and sets DEVCONTOUR_TEST_CLI=lib for it: the built CLI skips the TypeScript
// transform and starts about 0.17 s sooner, and the suite starts the CLI
// hundreds of times. A lib/ older than src/ is refused, never used: it would
// test an earlier CLI. Tests that check the source entry itself (its launch
// hint) or the build keep their own command line.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const built = join(root, 'lib', 'cli.js');
export const CLI_MODE_ENV = 'DEVCONTOUR_TEST_CLI';

/** Newest modification time of the sources the build compiles (src/web is not built). */
function newestSource(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== join(root, 'src', 'web')) latest = Math.max(latest, newestSource(path));
    } else if (entry.name.endsWith('.ts')) latest = Math.max(latest, statSync(path).mtimeMs);
  }
  return latest;
}

let checkedBuild: string | undefined;
function builtCli() {
  if (checkedBuild) return checkedBuild;
  let builtAt: number;
  try {
    builtAt = statSync(built).mtimeMs;
  } catch {
    throw new Error(`${CLI_MODE_ENV}=lib, but ${built} is missing: run npm run build:lib`);
  }
  if (newestSource(join(root, 'src')) > builtAt)
    throw new Error(
      `${CLI_MODE_ENV}=lib, but ${built} is older than src/: run npm run build:lib or unset ${CLI_MODE_ENV}`,
    );
  return (checkedBuild = built);
}

/** Node arguments that run the CLI (loader and script), without the node executable. */
export function cliArgs(): string[] {
  const mode = process.env[CLI_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'src')
    return ['--import', import.meta.resolve('tsx'), source];
  if (mode === 'lib') return [builtCli()];
  throw new Error(`${CLI_MODE_ENV} must be src or lib, got ${mode}`);
}

/** The whole command line of the CLI: the node executable, then {@link cliArgs}. */
export function cliCommand(): string[] {
  return [process.execPath, ...cliArgs()];
}
