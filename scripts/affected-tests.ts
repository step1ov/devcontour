// Test selection for one fix: which tests/*.test.ts can observe a change.
//
// A test file is selected when its static dependency closure contains a changed
// file. The closure follows relative imports, `new URL(x, import.meta.url)`,
// the `@/` alias and path literals that name files under src/ or tests/ (a
// test that spawns `src/cli.ts` or walks `src/` depends on them). Sources are
// parsed with the TypeScript compiler, a dev dependency: the lexer that pins
// acceptance artifacts (src/runner/artifact-closure.ts) does not read JSX and
// refuses some of DevContour's own files, which would always force the full
// suite. Strings and comments never count as imports.
//
// The selection only ever narrows towards the full suite. Every change outside
// src/ and tests/ (package.json, lockfile, tsconfig, scripts, vendor/harness,
// packs, templates, docs...) runs everything, as does a deletion and a
// non-source file no test is seen to reach. A source file
// under src/ that no test reaches selects nothing and is reported as such:
// typecheck, lint and e2e still cover it. The release check never uses this.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface Change {
  /** Repository-relative POSIX path. */
  path: string;
  /** Git name-status letter after --no-renames: A, M, D, T, U... */
  status: string;
}
export interface Repo {
  /** Every existing file under src/ and tests/, repository-relative. */
  files: string[];
  read(path: string): string;
}
export interface Selection {
  /** Run the whole suite: `reason` says which change forced it. */
  full: boolean;
  reason: string;
  /** Selected test files, repository-relative, sorted. Empty when full. */
  tests: string[];
  /** Per changed file: the tests that reach it or why it widens the run. */
  changes: { path: string; effect: string }[];
}

const OWN = /^(src|tests)(\/|$)/;
/** Tests that read every file under src/ (layer boundaries): any src change selects them. */
export const WHOLE_TREE = ['tests/boundaries.test.ts'];
const TEST = /^tests\/[^/]+\.test\.ts$/;
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const isSource = (path: string) => SOURCE.test(path) && !path.endsWith('.d.ts');
const RESOLVE = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

class Graph {
  private readonly files: Set<string>;
  private readonly sorted: string[];
  private readonly edges = new Map<string, string[]>();
  constructor(private readonly repo: Repo) {
    this.files = new Set(repo.files);
    this.sorted = [...repo.files].sort();
  }
  /** Files under a directory path (no trailing slash), or [] if none. */
  private under(dir: string) {
    const prefix = dir === '' ? '' : dir + '/';
    return this.sorted.filter((f) => f.startsWith(prefix));
  }
  /** A module specifier relative to `from`: file, TS twin, extension or index. */
  private module(path: string): string[] {
    if (this.files.has(path)) return [path];
    const ext = posix.extname(path);
    for (const twin of JS_TO_TS[ext] ?? []) {
      const candidate = path.slice(0, -ext.length) + twin;
      if (this.files.has(candidate)) return [candidate];
    }
    for (const suffix of [...RESOLVE, ...RESOLVE.map((e) => '/index' + e)])
      if (this.files.has(path + suffix)) return [path + suffix];
    return [];
  }
  /**
   * A path literal or URL: the file itself or everything under a directory.
   * `src`, `tests` and the root are not expanded: as literals they are mostly
   * product paths of fixtures (`writePaths: ['src/']`), and tests that do walk
   * the whole tree are listed in WHOLE_TREE.
   */
  private path(path: string): string[] {
    const clean = path.replace(/\/+$/, '');
    if (!OWN.test(clean)) return [];
    if (this.files.has(clean)) return [clean];
    return clean.includes('/') ? this.under(clean) : [];
  }
  private join(from: string, specifier: string) {
    return posix.normalize(posix.join(posix.dirname(from), specifier));
  }
  dependencies(file: string): string[] {
    const known = this.edges.get(file);
    if (known) return known;
    const out = new Set<string>();
    if (isSource(file)) {
      const source = ts.createSourceFile(file, this.repo.read(file), ts.ScriptTarget.Latest);
      const module = (spec: string) => {
        spec = spec.split(/[?#]/)[0];
        if (spec.startsWith('@/')) return this.module('src/web/' + spec.slice(2));
        if (spec.startsWith('./') || spec.startsWith('../'))
          return this.module(this.join(file, spec));
        return [];
      };
      const text = (node: ts.Node | undefined) =>
        node && ts.isStringLiteralLike(node) ? node.text : undefined;
      const isMetaUrl = (node: ts.Node | undefined) =>
        !!node &&
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'url' &&
        ts.isMetaProperty(node.expression);
      const visit = (node: ts.Node) => {
        let found: string[] = [];
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          text(node.moduleSpecifier)
        )
          found = module(text(node.moduleSpecifier)!);
        else if (ts.isCallExpression(node) && text(node.arguments[0]) !== undefined) {
          const callee = node.expression;
          // import('x'), require('x'), require.resolve('x'), import.meta.resolve('x')
          if (
            callee.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(callee) && callee.text === 'require') ||
            (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve')
          )
            found = module(text(node.arguments[0])!);
        } else if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'URL' &&
          text(node.arguments?.[0]) !== undefined &&
          isMetaUrl(node.arguments?.[1])
        ) {
          const spec = text(node.arguments![0])!;
          if (!/^[a-z][a-z0-9+.-]*:/i.test(spec)) found = this.path(this.join(file, spec));
        } else if (file.startsWith('tests/') && ts.isStringLiteralLike(node)) {
          // A path literal in a test: `resolve('src/cli.ts')`, `join(here, '../src/x.ts')`.
          // Product code names product paths, not its own files, so only tests count.
          const value = node.text;
          if (OWN.test(value)) found = this.path(posix.normalize(value));
          else if (value.startsWith('./') || value.startsWith('../'))
            found = this.path(this.join(file, value));
        }
        found.forEach((d) => out.add(d));
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    out.delete(file);
    const list = [...out];
    this.edges.set(file, list);
    return list;
  }
  /** Every file the entry reaches, with the fewest import hops to it. */
  closure(entry: string): Map<string, number> {
    const seen = new Map([[entry, 0]]);
    const queue = [entry];
    for (let i = 0; i < queue.length; i++)
      for (const dep of this.dependencies(queue[i]))
        if (!seen.has(dep)) {
          seen.set(dep, seen.get(queue[i])! + 1);
          queue.push(dep);
        }
    return seen;
  }
}

const full = (reason: string, changes: Selection['changes']): Selection => ({
  full: true,
  reason,
  tests: [],
  changes,
});

export interface SelectOptions {
  /**
   * Keep only tests within this many import hops of a changed file. Not fail
   * safe: a quick look at the nearest tests, never a substitute for the run.
   */
  depth?: number;
}

export function selectTests(repo: Repo, changed: Change[], options: SelectOptions = {}): Selection {
  const depth = options.depth ?? Infinity;
  const changes: Selection['changes'] = [];
  const paths = [...new Set(changed.map((c) => c.path))].sort();
  for (const change of changed)
    if (!OWN.test(change.path))
      return full(`${change.path} is outside src/ and tests/`, [
        { path: change.path, effect: 'full suite' },
      ]);
  for (const change of changed)
    if (change.status.startsWith('D'))
      return full(`${change.path} was deleted`, [{ path: change.path, effect: 'full suite' }]);
  if (!paths.length) return { full: false, reason: 'no changes', tests: [], changes };

  const graph = new Graph(repo);
  const reach = new Map<string, Map<string, number>>();
  for (const test of repo.files.filter((f) => TEST.test(f)).sort())
    reach.set(test, graph.closure(test));
  const selected = new Set<string>();
  for (const path of paths) {
    const tests = [...reach]
      .filter(
        ([test, closure]) =>
          (closure.has(path) && closure.get(path)! <= depth) ||
          (path.startsWith('src/') && WHOLE_TREE.includes(test)),
      )
      .map(([test]) => test);
    if (tests.length) {
      tests.forEach((t) => selected.add(t));
      changes.push({ path, effect: `${tests.length} test file(s)` });
    } else if (path.startsWith('src/') && isSource(path)) {
      changes.push({ path, effect: 'no node test reaches it (typecheck/lint/e2e only)' });
    } else {
      changes.push({ path, effect: 'full suite' });
      return full(`no test is seen to reach ${path}`, changes);
    }
  }
  return {
    full: false,
    reason: `${selected.size} test file(s) reach ${paths.length} changed file(s)`,
    tests: [...selected].sort(),
    changes,
  };
}

const git = (root: string, args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Changes since the merge base with `base`: commits, index, worktree, untracked. */
export function workingChanges(root: string, base: string) {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const changes: Change[] = [];
  const diff = git(root, ['diff', '--name-status', '--no-renames', '-z', mergeBase]).split('\0');
  for (let i = 0; i + 1 < diff.length; i += 2)
    if (diff[i]) changes.push({ status: diff[i], path: diff[i + 1] });
  for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'))
    if (path) changes.push({ status: 'A', path });
  return { mergeBase, changes };
}

export function workingRepo(root: string): Repo {
  const files = git(root, ['ls-files', '-co', '--exclude-standard', '-z', '--', 'src', 'tests'])
    .split('\0')
    .filter((f) => f && existsSync(posix.join(root, f)));
  return {
    files: [...new Set(files)],
    read: (path) => readFileSync(posix.join(root, path), 'utf8'),
  };
}

/** Selection for this checkout; a missing base ref fails safe to the full suite. */
export function affected(base = 'master', options: SelectOptions = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let changes: Change[], mergeBase: string;
  try {
    ({ changes, mergeBase } = workingChanges(root, base));
  } catch (error) {
    const reason = `no merge base with ${base}: ${(error as Error).message.split('\n')[0]}`;
    return { root, base, mergeBase: undefined, selection: full(reason, []) };
  }
  return { root, base, mergeBase, selection: selectTests(workingRepo(root), changes, options) };
}
