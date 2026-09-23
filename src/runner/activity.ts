import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeEvents } from './runtime-events.ts';
import type { Run } from '../core/model.ts';

// «Чем агент занят прямо сейчас» — вопрос, на который фаза отвечает грубо:
// `running` одинаков и через минуту после выдачи, и на десятом инструменте.
// Ответ уже есть в потоке событий runtime; он просто никуда не попадал.

/** Что именно делает runtime: вызов инструмента или его собственная реплика. */
function describe(event: Record<string, unknown>, worktree?: string): string | undefined {
  const type = String(event.type ?? '');
  // claude: ход агента приходит блоками content с tool_use и text.
  const message = event.message as { content?: unknown[] } | undefined;
  for (const block of message?.content ?? []) {
    const part = block as {
      type?: string;
      name?: string;
      text?: string;
      input?: Record<string, unknown>;
    };
    // Одно имя инструмента мало что говорит: «Read» одинаков для схемы и для
    // чужого файла. Цель берётся из входа — путь, шаблон или команда.
    if (part.type === 'tool_use' && part.name) {
      const target = ['file_path', 'path', 'pattern', 'command', 'query']
        .map((key) => part.input?.[key])
        .find((value) => typeof value === 'string' && value.trim());
      return [part.name, relative(target, worktree)].filter(Boolean).join(' ');
    }
    if (part.type === 'text' && part.text?.trim()) return part.text.trim();
  }
  // codex: завершённые элементы с собственным типом.
  const item = event.item as { type?: string; text?: string; command?: string } | undefined;
  if (item?.command) return item.command;
  if (item?.text?.trim()) return item.text.trim();
  if (type === 'assistant' || type === 'user') return undefined;
  return undefined;
}

// Путь внутри worktree читается сам по себе; полный путь до временного
// каталога прогона занимает всю строку и ничего не добавляет.
const relative = (target: unknown, worktree?: string) =>
  typeof target === 'string' && worktree && target.startsWith(worktree + '/')
    ? target.slice(worktree.length + 1)
    : target;

const phaseDirectories = [
  ['implementation', 'implementation'],
  ['candidate/review', 'ревью кандидата'],
  ['integration/review', 'ревью интеграции'],
] as const;

/**
 * Последние действия прогона: короткие строки в порядке появления.
 * Читается лог самого runtime, поэтому ничего дополнительно хранить не нужно.
 */
export async function runActivity(
  scheduler: { runRoot: (repositoryId?: string) => string },
  run: Run,
  limit = 12,
): Promise<{ phase: string; at?: string; text: string }[]> {
  const root = join(scheduler.runRoot(run.repositoryId), 'artifacts', run.id);
  const lines: { phase: string; at?: string; text: string }[] = [];
  for (const [directory, label] of phaseDirectories) {
    let log: string;
    try {
      log = await readFile(join(root, directory, 'runtime.log'), 'utf8');
    } catch {
      continue;
    }
    // Лог перемежается строками `[время поток] {json}`: событие достаётся из
    // хвоста строки, отметка времени — из её начала.
    for (const raw of log.split('\n')) {
      const stamp = /^\[(\S+) std(?:out|err)\]\s?/.exec(raw);
      const body = stamp ? raw.slice(stamp[0].length) : raw;
      const [event] = runtimeEvents(body).events;
      const text = event && describe(event, run.worktree);
      if (text) lines.push({ phase: label, at: stamp?.[1], text: text.slice(0, 300) });
    }
  }
  return lines.slice(-limit);
}
