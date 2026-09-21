import { repositories } from '../core/repositories.ts';
import { mkdirSync, writeFileSync, renameSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DevContour } from '../core/service.ts';
import type { DevContourState, AuditEvent } from '../core/model.ts';
import { changeSnapshot } from '../core/workspace.ts';

const line = (text: string) => text.replace(/[\r\n|]/g, ' ');
export function renderJournal(state: DevContourState, id: string, events: AuditEvent[]) {
  const c = state.changeSets.find((c) => c.id === id);
  if (!c) throw new Error('ChangeSet не найден');
  const accepted = c.verifications.find((v) => v.id === c.acceptance?.verificationId);
  const snapshot = accepted ?? changeSnapshot(state, c);
  const acceptedEvent = events.find(
    (e) =>
      e.type === 'changeset.accepted' && (e.data as { changeSetId?: string })?.changeSetId === id,
  );
  const rows = [
    `# ${c.id} · ${line(c.title)}`,
    '',
    '> Автоматическая проекция SQLite. Ручные правки будут заменены командой journal.',
    '',
    c.description,
    '',
    `Статус: ${c.acceptance ? 'принят' : 'в работе'}. Создан: ${c.createdAt}.`,
    ...(c.releaseId ? [`Продуктовый релиз INTENT: ${c.releaseId}.`] : []),
    ...(c.supersedes ? [`Продолжает: ${c.supersedes}.`] : []),
    '',
    '## Состав',
    '',
    ...snapshot.boards.map((b) => `- ${b.id} · ${line(b.title)} · r${b.revision}`),
    '',
    '| Задача | Репозиторий | Результат | SHA |',
    '| --- | --- | --- | --- |',
    ...snapshot.tasks.map(
      (t) =>
        `| ${t.id} · ${line(t.title)} | ${t.repositoryId} | ${t.status} | ${t.resultSha ?? '—'} |`,
    ),
    '',
  ];
  for (const v of c.verifications) {
    rows.push(
      `## Проверка ${v.id}`,
      '',
      `${v.startedAt} · ${v.status}`,
      '',
      `Policy: ${v.policyDigest}`,
      `Manifest: ${v.manifestDigest ?? 'не закреплён'}`,
      ...(v.productRelease
        ? [
            `Карта продукта: ${v.productRelease.intentDigest}`,
            `Сквозные gates фич: ${v.productRelease.gateIds.join(', ')}`,
          ]
        : []),
      ...(v.impact
        ? [
            `Impact: ${v.impact.mode} · ${line(v.impact.reason)}`,
            `Изменены: ${v.impact.changed.join(', ') || 'нет'}`,
            `Потребители: ${v.impact.affected.join(', ')}`,
            `Обязательные gates: ${v.impact.gateIds.join(', ')}`,
          ]
        : []),
      '',
      ...Object.entries(v.manifest ?? {}).map(([id, m]) => `- ${id}: SHA ${m.sha}, tree ${m.tree}`),
      '',
      ...v.evidence.flatMap((e) => [
        `- ${e.gate}: ${e.passed ? 'PASS' : 'FAIL'} · ${line(e.summary)}`,
        `  Лог: ${e.log} · digest ${e.digest}`,
        ...e.artifacts.map((a) => `  Артефакт: ${a.path} · sha256 ${a.digest}`),
      ]),
      ...(v.error ? ['', `Ошибка: ${line(v.error)}`] : []),
      '',
    );
  }
  for (const d of c.deliveries ?? [])
    rows.push(
      `## Доставка ${d.id}`,
      '',
      `${d.startedAt} · ${d.status}`,
      `Проверка: ${d.verificationId}`,
      `Manifest: ${d.manifestDigest}`,
      '',
      ...Object.entries(d.components).map(
        ([id, r]) =>
          `- ${id}: ${r.state} · SHA ${r.sha} · PR/MR ${r.url ?? '—'} · merge ${r.mergedSha ?? '—'} · ${(r.checks ?? []).map((c) => `${c.name}: ${c.status} (${c.sha})`).join(', ')}`,
      ),
      ...(d.error ? [`Ошибка: ${line(d.error)}`] : []),
      '',
    );
  if (c.acceptance)
    rows.push(
      '## Приёмка',
      '',
      `${c.acceptance.at} · ${c.acceptance.approval.actor}`,
      '',
      `Receipt: ${c.acceptance.digest}`,
      '',
      'Принята только указанная комбинация SHA. Последующие изменения требуют нового ChangeSet.',
      '',
    );
  rows.push(
    '## События',
    '',
    ...events
      .filter((e) => {
        const data = e.data as { changeSetId?: string; id?: string } | null;
        return (
          (data?.changeSetId === id || data?.id === id) &&
          (!acceptedEvent || e.id <= acceptedEvent.id)
        );
      })
      .map((e) => `- #${e.id} · ${e.at} · ${e.type}`),
    '',
  );
  return rows.join('\n');
}
export function attachJournal(h: DevContour) {
  if (!h.config.workspaceRoot) return;
  const root = realpathSync(h.config.workspaceRoot);
  h.store.onCommit = () =>
    h.store.project((state, events) => {
      let dir = root;
      for (const name of h.config.workspaceMode === 'embedded'
        ? ['.devcontour-local', 'journal']
        : ['docs', 'journal']) {
        dir = join(dir, name);
        mkdirSync(dir, { recursive: true });
        if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir))
          throw new Error('Journal не пишет через symlink');
      }
      if (h.config.storage === 'component')
        for (const repo of repositories(h.config)) {
          const localDir = join(realpathSync(repo.path), '.devcontour-local', 'journal');
          mkdirSync(localDir, { recursive: true });
          if (realpathSync(localDir) !== resolve(localDir))
            throw new Error('Локальный журнал не пишет через symlink');
          const tasks = state.tasks.filter(
            (t) => t.repositoryId === repo.id && t.scope !== 'workspace',
          );
          const rows = [
            `# ${repo.name}: журнал работ`,
            '',
            '> Автоматическая проекция локальной базы задач.',
            '',
          ];
          for (const task of tasks) {
            rows.push(
              `## ${task.id}: ${line(task.title)}`,
              '',
              task.description,
              '',
              `Статус: ${task.status}. Зависимости: ${task.dependsOn.join(', ') || 'нет'}.`,
              '',
              ...task.acceptance.map((a) => '- ' + a),
              '',
            );
            for (const run of state.runs.filter((r) => r.taskId === task.id))
              rows.push(
                `- Попытка ${run.attempt}: ${run.status}; ${run.runtime} / ${run.model ?? 'default'}; SHA ${run.integrationSha ?? run.candidateSha ?? '—'}`,
                ...run.evidence.map(
                  (e) => `  - ${e.gate}: ${e.passed ? 'PASS' : 'FAIL'}; ${e.sha}; ${e.log}`,
                ),
                ...(run.error ? [`  - Ошибка: ${line(run.error)}`] : []),
              );
          }
          const destination = join(localDir, 'activity.md'),
            temp = destination + '.' + randomUUID() + '.tmp';
          writeFileSync(temp, rows.join('\n'), { flag: 'wx' });
          renameSync(temp, destination);
        }
      for (const c of state.changeSets) {
        if (!/^CHG-[A-Za-z0-9_-]{1,76}$/.test(c.id)) throw new Error('Некорректный ID журнала');
        const destination = join(dir, c.id + '.md');
        const temporary = destination + '.' + randomUUID() + '.tmp';
        writeFileSync(temporary, renderJournal(state, c.id, events), { flag: 'wx' });
        renameSync(temporary, destination);
      }
    });
  h.store.refreshProjection();
}
