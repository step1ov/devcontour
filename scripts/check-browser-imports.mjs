// The panel bundle must not reach Node-only modules.
//
// A production build tree-shakes an unused `import { createHash } from
// 'node:crypto'` away, but Vite dev (`serve --dev`, `demo --dev`) serves every
// module unbundled: the browser then evaluates the externalized stub and the
// panel dies before rendering. ESLint only sees direct imports from src/web, so
// this check walks the graph the way the dev server does — through Vite's own
// resolver and transforms, with type-only imports already erased — and fails
// on any module Vite externalized for the browser, any file from a server-only
// layer, and any devcontour-harness module except its browser-safe subpaths.
//
// Covered: static and dynamic imports, `?worker`/`?sharedworker` imports and
// `new Worker(new URL('./w.ts', import.meta.url))` (followed through the
// worker file Vite serves). Not covered: other packages' internals — Vite
// pre-bundles them in dev, where a builtin becomes a stub that throws only
// when used — and URLs built at runtime, which no static walk can see.
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const external = '__vite-browser-external';
const serverOnly = /^src\/(?:runner\/|server\/|cli(?:[.\-/]))/;
// The harness root and most subpaths load Node modules at top level (the root
// reaches lib/environment through createRequire); only these entries are pure.
const harness = '/node_modules/devcontour-harness/';
const harnessBrowserSafe =
  /\/node_modules\/devcontour-harness\/lib\/(?:contracts|projections)\/index\.js$/;
// Vite rewrites worker URLs to the worker file it serves.
const workerFile = /["'`](\/[^"'`]*[?&]worker_file\b[^"'`]*)["'`]/g;

/**
 * @param {{ root: string; entry: string; configFile?: string | false; cacheDir?: string }} options
 * @returns {Promise<{ modules: number; violations: { module: string; chain: string[] }[] }>}
 */
export async function browserNodeImports({ root, entry, configFile, cacheDir }) {
  // Vite reports real paths (/tmp is /private/tmp on macOS).
  const base = realpathSync(root);
  const server = await createServer({
    root,
    configFile,
    // Its own cache per checkout: the shared node_modules/.vite would
    // invalidate the optimized deps of a running dev server, and worktrees
    // sharing node_modules would race on one directory.
    cacheDir:
      cacheDir ??
      join(
        tmpdir(),
        'devcontour-browser-imports-' +
          createHash('sha256').update(base).digest('hex').slice(0, 12),
      ),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const client = server.environments.client;
    /** @type {Map<string, string | undefined>} url -> importer url */
    const parent = new Map([[entry, undefined]]);
    const queue = [entry];
    const violations = [];
    // Paths relative to the checkout, without Vite's ?v= cache-busting hash.
    const label = (raw) => {
      const id = raw.replace(/[?&]v=[0-9a-f]+$/, '');
      return id.startsWith(base + sep)
        ? relative(base, id).split(sep).join('/')
        : id.replace(/^\0/, '');
    };
    const chainOf = (url) => {
      const chain = [];
      for (let at = url; at !== undefined; at = parent.get(at))
        chain.unshift(label(client.moduleGraph.urlToModuleMap.get(at)?.id ?? at));
      return chain;
    };
    const visit = (url, from) => {
      if (parent.has(url)) return;
      parent.set(url, from);
      queue.push(url);
    };
    while (queue.length) {
      const url = queue.shift();
      if (/\.css($|\?)/.test(url)) continue;
      // An imported module is already resolved; the entry and worker files
      // are resolved by their own transform.
      let result = client.moduleGraph.urlToModuleMap.get(url)
        ? undefined
        : await client.transformRequest(url);
      const node = client.moduleGraph.urlToModuleMap.get(url);
      const id = (node?.id ?? url).split('?')[0];
      const path = label(id);
      if (
        id.includes(external) ||
        serverOnly.test(path) ||
        (id.includes(harness) && !harnessBrowserSafe.test(id))
      ) {
        violations.push({ module: path, chain: chainOf(url) });
        continue;
      }
      // Packages are pre-bundled in dev; see the header for this limit.
      if (id.includes('/node_modules/')) continue;
      result ??= await client.transformRequest(url);
      for (const imported of node?.importedModules ?? []) visit(imported.url, url);
      for (const [, worker] of result?.code.matchAll(workerFile) ?? []) visit(worker, url);
    }
    return { modules: parent.size, violations };
  } finally {
    await server.close();
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { modules, violations } = await browserNodeImports({ root, entry: '/src/web/main.tsx' });
  if (violations.length) {
    console.error('The panel (src/web) reaches Node-only modules; Vite dev mode cannot load it:');
    for (const v of violations) console.error('  ' + v.chain.join(' -> '));
    console.error(
      'Move the browser-safe part (types, pure helpers) into a module without node:*;',
      'from devcontour-harness the panel may import only /contracts and /projections.',
    );
    process.exit(1);
  }
  console.log(`Browser imports: ${modules} panel modules, none reach Node-only code.`);
}
