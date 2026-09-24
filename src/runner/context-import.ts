import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { git } from './process.ts';

// Чужая библиотека инструкций входит в контур вендорингом на закреплённый
// коммит, а не загрузкой во время прогона. Причины две и обе неустранимые.
//
// Закрепление: договор DevContour держится на том, что прочитанное исполнителем
// закреплено по digest и записано в прогоне. Сетевой источник это ломает.
//
// Доверие: текст из чужого репозитория попадает агенту, который пишет код и
// запускает команды. Это канал внедрения, и открывать его вживую нельзя.
// Импорт — отдельное действие человека, а принесённое проходит ревью, как
// любое другое изменение.

const libraryRoot = fileURLToPath(new URL('../../packs/context/', import.meta.url));
const registryFile = fileURLToPath(new URL('../../packs/sources.json', import.meta.url));

const sourceSchema = z.strictObject({
  repository: z.string().url(),
  commit: z.string().regex(/^[0-9a-f]{40}$/, 'Источник закрепляется полным SHA коммита'),
  license: z.string().min(1),
  licenseFile: z.string().min(1).optional(),
  /** Префиксы путей апстрима, из которых вообще разрешено брать файлы. */
  allow: z.array(z.string().min(1)).min(1),
});
const registrySchema = z.strictObject({
  version: z.literal(1),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,40}$/), sourceSchema),
});

const MAX_FILE_BYTES = 200_000;

export async function contextSources() {
  return registrySchema.parse(JSON.parse(await readFile(registryFile, 'utf8'))).sources;
}

/**
 * Перенести файлы источника в библиотеку.
 *
 * Берутся только Markdown-файлы из разрешённых префиксов: исполняемое и
 * конфигурационное из чужого репозитория в контур не попадает. Рядом кладётся
 * происхождение — репозиторий, коммит, лицензия и исходный путь каждого файла,
 * — чтобы позже было видно, откуда это и на чём закреплено.
 */
export async function importContextSource(
  id: string,
  options: { paths?: string[] } = {},
): Promise<{ id: string; commit: string; license: string; files: string[] }> {
  const source = (await contextSources())[id];
  if (!source) throw new Error('Неизвестный источник: ' + id);
  const checkout = await mkdtemp(join(tmpdir(), 'devcontour-import-'));
  try {
    await git(checkout, 'init', '--quiet');
    await git(checkout, 'remote', 'add', 'origin', source.repository);
    await git(checkout, 'fetch', '--quiet', '--depth', '1', 'origin', source.commit);
    await git(checkout, 'checkout', '--quiet', 'FETCH_HEAD');

    const listed = (await git(checkout, 'ls-tree', '-r', '--name-only', 'HEAD'))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const wanted = listed.filter(
      (file) =>
        file.endsWith('.md') &&
        source.allow.some((prefix) => file.startsWith(prefix)) &&
        (!options.paths?.length || options.paths.some((prefix) => file.startsWith(prefix))),
    );
    if (!wanted.length) throw new Error('Под указанные пути не подошёл ни один документ');

    const target = join(libraryRoot, '.agents', 'context', 'vendor', id);
    await rm(target, { recursive: true, force: true });
    const imported: { file: string; upstream: string }[] = [];
    for (const upstream of wanted) {
      const content = await readFile(join(checkout, upstream), 'utf8');
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) continue;
      // Путь уплощается: чужая раскладка каталогов в наш продукт не приезжает.
      const name = upstream.replace(/\.md$/, '').split('/').filter(Boolean).join('--') + '.md';
      const file = join(target, name);
      if (!resolve(file).startsWith(resolve(target) + sep)) continue;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
      imported.push({ file: posix.join('.agents/context/vendor', id, name), upstream });
    }
    if (source.licenseFile)
      await writeFile(
        join(target, 'LICENSE'),
        await readFile(join(checkout, source.licenseFile), 'utf8'),
      );
    await writeFile(
      join(target, 'PROVENANCE.json'),
      JSON.stringify(
        {
          source: id,
          repository: source.repository,
          commit: source.commit,
          license: source.license,
          importedAt: new Date().toISOString(),
          files: imported,
        },
        null,
        2,
      ) + '\n',
    );
    return {
      id,
      commit: source.commit,
      license: source.license,
      files: imported.map((f) => f.file),
    };
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
