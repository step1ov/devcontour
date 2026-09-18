// Generates only input documents. No provider, controller, Git push or model is invoked.
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'devcontour-pilot-2-'));
await mkdir(join(root, 'docs'));
await copyFile(new URL('../docs/pilot-2-spec.md', import.meta.url), join(root, 'docs/spec.md'));
await writeFile(
  join(root, 'pilot-limits.json'),
  JSON.stringify(
    {
      approved: false,
      leadModel: null,
      authorModel: null,
      reviewerModel: null,
      moneyBudgetUsd: null,
      maxCallsIncludingLead: 20,
      maxTasks: 5,
      maxAttempts: 1,
      concurrency: 1,
      attemptTimeoutMs: 240000,
      totalWallClockMinutes: 60,
      monetaryHardCapImplemented: false,
    },
    null,
    2,
  ) + '\n',
);
await writeFile(join(root, 'interventions.jsonl'), '');
await writeFile(
  join(root, 'README.md'),
  '# Подготовленный пилот\n\nМодели ещё не запускались. Файл pilot-limits.json — план наблюдения, не исполняемая политика DevContour. Перед запуском человек задаёт модели, бюджет и разрешение; агент переносит поддерживаемые ограничения в конфигурацию, проверяет sandbox и действует по docs/pilot-2-plan.md установленного DevContour.\n',
);
console.log(JSON.stringify({ root, status: 'prepared-not-started', modelCalls: 0 }, null, 2));
