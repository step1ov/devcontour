// Таблица digest копий руководств из прежних релизов DevContour.
//
// Копии, поставленные до меток (guides.ts), не несут digest. Текст такой
// копии, совпадающий с текстом какого-либо релиза, доказывает, что продукт её
// не правил, и guides-refresh заменяет её без --replace-unmarked. Релиз —
// коммит, менявший версию в package.json, не позже LAST_UNMARKED; текст копии
// строится тем же renderGuideBodies, что и в setup.
//
// Таблица заморожена: начиная со следующего релиза каждая копия несёт метку,
// и описывать нужно только релизы до меток. После релизов запускать не нужно;
// перегенерация после изменения renderGuideBodies переписала бы историю
// digest, которых старые релизы не писали. Повторный запуск (тот же результат):
//   node --import tsx scripts/guide-history.ts
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guideDigest, renderGuideBodies } from '../src/runner/guides.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Последний релиз, копии которого не несли метку (0.4.0-alpha.38). */
const LAST_UNMARKED = '8fe1512';
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const releases = git('log', '--format=%H', `-G"version":`, LAST_UNMARKED, '--', 'package.json')
  .split('\n')
  .filter(Boolean);
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
