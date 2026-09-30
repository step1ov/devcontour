import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DomainError, type Contract, type ContractArtifact } from '../core/model.ts';
import { digest } from '../core/service.ts';
import { git } from './process.ts';

/** Предел текста артефактов, передаваемого ревьюеру вместе с контрактом. */
const MAX_ARTIFACT_TEXT = 400000;

/**
 * Закрепить нормативные артефакты контракта: схему, файлы приёмки, эталон.
 *
 * Реестр закреплял только документ контракта. Правка схемы, на которую он
 * ссылался, отвечала «уже утверждено» и не проходила ревью, а задачи
 * выполнялись уже по другому договору. Артефакт закрепляется закоммиченной
 * ревизией: путь, blob и digest содержимого на HEAD компонента. Незакоммиченная
 * правка, symlink, выход из репозитория и неотслеживаемый файл — отказ с
 * причиной: закреплять то, чего нет в истории, значит закреплять ничто.
 */
export async function pinArtifacts(
  repo: { id: string; path: string },
  declared: { path: string; purpose: string }[],
) {
  if (!declared.length) return { artifacts: [], contents: [] };
  const seen = new Set<string>();
  const base = await realpath(repo.path);
  const revision = await git(repo.path, 'rev-parse', 'HEAD');
  const artifacts: ContractArtifact[] = [];
  const contents: { path: string; purpose: string; content: string }[] = [];
  let total = 0;
  for (const { path, purpose } of declared) {
    if (seen.has(path)) throw new DomainError('Артефакт указан дважды: ' + path, 400);
    seen.add(path);
    const file = resolve(base, path);
    if (!file.startsWith(base + sep))
      throw new DomainError('Артефакт вне репозитория: ' + path, 400);
    const stat = await lstat(file).catch(() => undefined);
    if (!stat) throw new DomainError('Артефакт не найден: ' + path, 400);
    // Symlink подменил бы содержимое чужим файлом при том же пути в дереве.
    if (stat.isSymbolicLink()) throw new DomainError('Артефакт — symlink: ' + path, 400);
    if (!stat.isFile()) throw new DomainError('Артефакт не файл: ' + path, 400);
    if ((await realpath(file)) !== file)
      throw new DomainError('Путь артефакта проходит через symlink: ' + path, 400);
    const tracked = await git(repo.path, 'ls-files', '--full-name', '--', path);
    if (!tracked) throw new DomainError('Артефакт не в Git: ' + path, 400);
    if (await git(repo.path, 'status', '--porcelain', '--', path))
      throw new DomainError(
        'Артефакт изменён после коммита — закоммитьте его до ревью контракта: ' + path,
        400,
      );
    const blob = await git(repo.path, 'rev-parse', `${revision}:${tracked}`);
    const content = await git(repo.path, 'cat-file', 'blob', blob);
    total += content.length;
    if (total > MAX_ARTIFACT_TEXT)
      throw new DomainError('Артефакты контракта слишком велики для ревью', 400);
    artifacts.push({
      repositoryId: repo.id,
      path: tracked,
      purpose,
      revision,
      blob,
      digest: digest(content),
    });
    contents.push({ path: tracked, purpose, content });
  }
  return { artifacts, contents };
}

/** Артефакты контрактов задачи, которые лежат в данном компоненте. */
export function componentArtifacts(contracts: Contract[], repositoryId: string) {
  return contracts.flatMap((c) =>
    (c.artifacts ?? []).filter((a) => a.repositoryId === repositoryId),
  );
}

/**
 * База прогона содержит именно закреплённые редакции артефактов. Иначе гейт
 * читал бы файл рабочего дерева — ту редакцию, которую ревью не видело, или
 * ещё не перенесённую в базу.
 */
export async function assertArtifactsInBase(
  repoPath: string,
  base: string,
  artifacts: ContractArtifact[],
) {
  const stale: string[] = [];
  for (const a of artifacts) {
    const blob = await git(repoPath, 'rev-parse', `${base}:${a.path}`).catch(() => '');
    if (blob !== a.blob) stale.push(a.path);
  }
  return stale;
}
