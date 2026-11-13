// Таблица digest копий руководств из прежних релизов DevContour.
//
// Копии, поставленные до меток (guides.ts), не несут digest. Текст такой
// копии, совпадающий с текстом какого-либо релиза, доказывает, что продукт её
// не правил, и guides-refresh заменяет её без --replace-unmarked. Релиз —
// коммит `build: release …` этого репозитория; текст копии строится тем же
// renderGuideBodies, что и в setup (код переноса не менялся с первого
// релиза). Запуск после релиза:
//   node --import tsx scripts/guide-history.ts
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guideDigest, renderGuideBodies } from '../src/runner/guides.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const releases = git('log', '--format=%H', '--grep=^build: release').split('\n').filter(Boolean);
const digests = new Map<string, Set<string>>();
for (const commit of releases) {
  const bodies = await renderGuideBodies(async (source) => {
    try {
      return git('show', `${commit}:${source}`);
    } catch {
      return undefined;
    }
  });
  for (const [name, body] of bodies) {
    if (!digests.has(name)) digests.set(name, new Set());
    digests.get(name)!.add(guideDigest(body));
  }
}
const lines = [...digests.keys()].sort().map(
  (name) =>
    `  '${name}': [\n${[...digests.get(name)!]
      .sort()
      .map((d) => `    '${d}',\n`)
      .join('')}  ],`,
);
writeFileSync(
  fileURLToPath(new URL('../src/runner/guide-history.ts', import.meta.url)),
  `// Сгенерировано scripts/guide-history.ts по ${releases.length} релизам; не правьте вручную.\n` +
    `// Digest текстов копий руководств прежних релизов (без метки, LF).\n` +
    `export const PAST_GUIDE_DIGESTS: Readonly<Record<string, readonly string[]>> = {\n${lines.join('\n')}\n};\n`,
);
console.log(
  `${releases.length} релизов, ${[...digests.values()].reduce((n, s) => n + s.size, 0)} digest`,
);
