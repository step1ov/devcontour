// The panel bundle must not reach Node-only modules.
//
// A production build tree-shakes an unused `import { createHash } from
// 'node:crypto'` away, but Vite dev (`serve --dev`, `demo --dev`) serves every
// module unbundled: the browser then evaluates the externalized stub and the
// panel dies before rendering. ESLint only sees direct imports from src/web, so
// this check walks the graph the way the dev server does — through Vite's own
// resolver and transforms, with type-only imports already erased — and fails
// on any module Vite externalized for the browser or any file from a
// server-only layer.
import { createServer } from 'vite';
import { realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const external = '__vite-browser-external';
const serverOnly = ['src/runner/', 'src/server/', 'src/cli'];

/**
 * @param {{ root: string; entry: string; configFile?: string | false }} options
 * @returns {Promise<{ modules: number; violations: { module: string; chain: string[] }[] }>}
 */
export async function browserNodeImports({ root, entry, configFile }) {
  const server = await createServer({
    root,
    configFile,
    // Its own cache: the shared node_modules/.vite would invalidate the
    // optimized deps of a dev server that is running at the same time.
    cacheDir: join(root, 'node_modules/.vite-browser-imports'),
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
    // Vite reports real paths (/tmp is /private/tmp on macOS).
    const base = realpathSync(root);
    const label = (id) =>
      id.startsWith(base + sep) ? relative(base, id).split(sep).join('/') : id.replace(/^\0/, '');
    const chainOf = (url) => {
      const chain = [];
      for (let at = url; at !== undefined; at = parent.get(at))
        chain.unshift(label(client.moduleGraph.urlToModuleMap.get(at)?.id ?? at));
      return chain;
    };
    while (queue.length) {
      const url = queue.shift();
      const node = client.moduleGraph.urlToModuleMap.get(url);
      const id = node?.id ?? url;
      const path = label(id);
      if (id.includes(external) || serverOnly.some((prefix) => path.startsWith(prefix))) {
        violations.push({ module: path, chain: chainOf(url) });
        continue;
      }
      // CSS goes through Tailwind and never reaches Node modules from here.
      // Packages are pre-bundled in dev, where the optimizer turns a builtin
      // into a stub that throws only when used; which harness subpaths the
      // panel may import is the ESLint boundary's job (eslint.config.mjs).
      if (/\.css($|\?)/.test(url) || url.includes('/node_modules/')) continue;
      await client.transformRequest(url);
      const transformed = client.moduleGraph.urlToModuleMap.get(url);
      for (const imported of transformed?.importedModules ?? []) {
        if (parent.has(imported.url)) continue;
        parent.set(imported.url, url);
        queue.push(imported.url);
      }
    }
    return { modules: parent.size, violations };
  } finally {
    await server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { modules, violations } = await browserNodeImports({ root, entry: '/src/web/main.tsx' });
  if (violations.length) {
    console.error('The panel (src/web) reaches Node-only modules; Vite dev mode cannot load it:');
    for (const v of violations) console.error('  ' + v.chain.join(' -> '));
    console.error('Move the browser-safe part (types, pure helpers) into a module without node:*.');
    process.exit(1);
  }
  console.log(`Browser imports: ${modules} panel modules, none reach Node-only code.`);
}
