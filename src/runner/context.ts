import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BlockedError, type Config, type ContextPack, type Task, type Run } from '../core/model.ts';
import { digest } from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import { git } from './process.ts';

async function contents(config: Config, pack: ContextPack, revision: string) {
  const repo = repository(config, pack.repositoryId);
  const documents = [];
  // Справочные файлы входят в digest наравне с правилами: изменилась справка —
  // закрепление недействительно. В промпт они не вкладываются, но исполнитель
  // читает именно закреплённую редакцию.
  for (const file of [...pack.files, ...pack.references].sort()) {
    const entry = await git(repo.path, 'ls-tree', revision, '--', file);
    if (!/^100(644|755) blob /.test(entry) || entry.includes('\n'))
      throw new Error('Context требует обычный Git-файл: ' + file);
    const content = await git(repo.path, 'show', `${revision}:${file}`);
    if (content.length > 60000) throw new Error('Context файл слишком большой: ' + file);
    documents.push({ file, content });
  }
  return documents;
}
export async function pinContext(config: Config, ref = 'HEAD') {
  const packs: ContextPack[] = [];
  for (const pack of config.contextPacks) {
    const revision = await git(
      repository(config, pack.repositoryId).path,
      'rev-parse',
      '--verify',
      `${ref}^{commit}`,
    );
    const documents = await contents(config, pack, revision);
    packs.push({
      ...pack,
      revision,
      digest: digest({ id: pack.id, version: pack.version, documents }),
    });
  }
  return packs;
}
export async function lockContextFile(config: Config, path: string, ref = 'HEAD') {
  const previous = await readFile(path, 'utf8');
  const packs = await pinContext(config, ref);
  if ((await readFile(path, 'utf8')) !== previous)
    throw new Error('Конфигурация изменилась во время context-lock');
  const next = { ...JSON.parse(previous), contextPacks: packs };
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.context-' + process.pid;
  await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
  await rename(temp, path);
  return packs;
}
export async function taskContext(config: Config, task: Task) {
  const selected = config.contextPacks.filter(
    (pack) =>
      task.contextPacks?.includes(pack.id) ||
      (pack.repositoryId === task.repositoryId && pack.roles.includes(task.role)),
  );
  const snapshots: NonNullable<Run['context']> = [],
    sections: string[] = [];
  for (const pack of selected) {
    if (!pack.revision || !pack.digest)
      throw new BlockedError(
        `Context pack ${pack.id} не закреплён; выполните context-lock после bootstrap-коммита`,
      );
    const documents = await contents(config, pack, pack.revision);
    if (digest({ id: pack.id, version: pack.version, documents }) !== pack.digest)
      throw new Error('Context digest не совпадает: ' + pack.id);
    snapshots.push({
      id: pack.id,
      version: pack.version,
      repositoryId: pack.repositoryId,
      revision: pack.revision,
      digest: pack.digest,
    });
    // Правила вкладываются, справка — называется. Библиотека стандартов на
    // сотни килобайт в промпт не помещается, а выбросить её значит потерять
    // именно те детали, ради которых её писали. Исполнитель читает справку в
    // рабочем дереве, когда тема всплыла; её содержимое входит в digest, так
    // что читается закреплённая редакция, а не случайная.
    const inlined = documents.filter((d) => pack.files.includes(d.file));
    const named = pack.references.filter((file) => documents.some((d) => d.file === file));
    sections.push(
      `Context pack ${pack.id}@${pack.version}; source ${pack.repositoryId}@${pack.revision}; digest ${pack.digest}\n` +
        inlined.map((d) => `Document: ${d.file}\n${d.content}`).join('\n\n') +
        (named.length
          ? `\n\nReference documents of this pack, pinned at the same revision. They are not` +
            ` included above: read them from the worktree when the topic comes up, do not guess` +
            ` their content.\n` +
            named.map((file) => `- ${file}`).join('\n')
          : ''),
    );
  }
  const text = sections.join('\n\n');
  if (text.length > 160000)
    throw new Error('Слишком много контекста; выберите более узкие packs для задачи');
  return { snapshots, text };
}
