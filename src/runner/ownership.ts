import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Config } from '../core/model.ts';
import { repositories } from '../core/repositories.ts';
import { git } from './process.ts';

export async function reserveRepositories(config: Config, dataRoot: string) {
  await mkdir(dataRoot, { recursive: true });
  const owner = await realpath(dataRoot);
  const commonDirs = new Set<string>();
  const claims: { path: string; content: string }[] = [];
  for (const repo of repositories(config)) {
    if (
      (await realpath(await git(repo.path, 'rev-parse', '--show-toplevel'))) !==
      (await realpath(repo.path))
    )
      throw new Error(`repository должен указывать на корень Git: ${repo.id}`);
    const common = await realpath(
      resolve(repo.path, await git(repo.path, 'rev-parse', '--git-common-dir')),
    );
    if (commonDirs.has(common)) throw new Error('Один Git-репозиторий зарегистрирован дважды');
    commonDirs.add(common);
    const path = join(common, 'devcontour-owner.json');
    const content = JSON.stringify({
      owner,
      repositoryId: repo.id,
      targetBranch: repo.targetBranch,
    });
    try {
      if ((await readFile(path, 'utf8')) !== content)
        throw new Error(
          `Репозиторием ${repo.id} управляет другая конфигурация DevContour: ${path}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    claims.push({ path, content });
  }
  for (const { path, content } of claims) {
    try {
      await writeFile(path, content, { flag: 'wx' });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(path, 'utf8')) !== content
      )
        throw new Error(`Репозиторий уже зарезервирован другим workspace: ${path}`);
    }
  }
}
