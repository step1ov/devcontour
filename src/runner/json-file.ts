import { open } from 'node:fs/promises';
import { DomainError } from '../core/model.ts';

/**
 * Предел файла, который написал агент: результат runtime и `--file` команд.
 * Вход агентского API ограничен 100 000 байт; 4 MiB оставляют запас в 40 раз и
 * совпадают с пределом checkpoint.
 */
export const agentFileBytes = 4 * 1024 * 1024;

/** Читает файл агента целиком, только если он укладывается в предел. */
export async function readAgentFile(path: string) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size > agentFileBytes)
      throw new DomainError(`Файл ${path}: ${size} байт при пределе ${agentFileBytes}`, 413);
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
export const readAgentJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readAgentFile(path));
