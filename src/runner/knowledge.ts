import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { relativePath } from '../core/model.ts';
import { git } from './process.ts';

export async function importKnowledge(
  workspace: string,
  source: string,
  files: string[],
  ref = 'HEAD',
) {
  if (!files.length || files.length > 30) throw new Error('Выберите 1–30 документов донора');
  const root = await git(source, 'rev-parse', '--show-toplevel');
  const revision = await git(root, 'rev-parse', '--verify', `${ref}^{commit}`);
  const selected = files.map((file) => {
    relativePath.parse(file);
    if (!/\.(md|mdx|txt)$/.test(file))
      throw new Error('Импортируются только выбранные текстовые документы');
    return file;
  });
  const docs = [];
  for (const path of selected) {
    const content = await git(root, 'show', `${revision}:${path}`);
    if (Buffer.byteLength(content) > 200000) throw new Error('Документ слишком большой: ' + path);
    docs.push({ path, content, digest: createHash('sha256').update(content).digest('hex') });
  }
  const id = createHash('sha256')
    .update(JSON.stringify({ root, revision, files: selected }))
    .digest('hex')
    .slice(0, 16);
  const destination = join(workspace, 'docs', 'donors', id);
  await mkdir(destination, { recursive: true });
  for (const doc of docs) {
    const file = join(destination, doc.path);
    await mkdir(join(file, '..'), { recursive: true });
    if (!(await realpath(join(file, '..'))).startsWith((await realpath(workspace)) + sep))
      throw new Error('Импорт выходит из workspace');
    await writeFile(file, doc.content, { flag: 'wx' }).catch(async (e) => {
      if (e.code !== 'EEXIST') throw e;
      if ((await readFile(file, 'utf8')) !== doc.content)
        throw new Error('Импортированный документ изменён: ' + file);
    });
  }
  const manifest = {
    status: 'unreviewed',
    source: root,
    revision,
    files: docs.map(({ path, digest }) => ({ path, digest })),
    instruction:
      'Сверить с текущим кодом. Переносить только подтверждённые правила в context packs компонентов; затем commit и context-lock. Очередь и инструменты донора не запускаются.',
  };
  await writeFile(join(destination, 'provenance.json'), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
  }).catch((e) => {
    if (e.code !== 'EEXIST') throw e;
  });
  return { destination, ...manifest };
}
