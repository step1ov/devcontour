import { mkdirSync, writeFileSync, renameSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DevContourState } from '../core/model.ts';
import type { ProductChange } from '../core/preparation-model.ts';

const line = (text: string) => text.replace(/[\r\n|]/g, ' ');
const names = {
  draft: 'черновик агента',
  'in-review': 'ожидает решения пользователя',
  approved: 'утверждено',
  'changes-requested': 'возвращено на доработку',
};

// The brief is what the operator approves and every later task is bound to.
// Keeping it only in SQLite made it unreadable without a running server, so it
// is projected next to the specification it came from.
export function renderProduct(change: ProductChange) {
  const product = change.product.at(-1);
  const architecture = change.architecture.at(-1);
  const rows = [
    `# ${change.id} · ${line(change.title)}`,
    '',
    '> Автоматическая проекция состояния. Правьте постановку в панели: ручные изменения будут заменены.',
    '',
    `Создано: ${change.createdAt}.`,
    '',
  ];
  if (product) {
    const content = product.content;
    rows.push(
      `## Продукт · версия ${product.number} · ${names[product.status]}`,
      '',
      `Причина версии: ${line(product.reason)}`,
      ...(product.decision
        ? [
            '',
            `Решение пользователя ${product.decision.at}: ${line(product.decision.comment) || 'без замечаний'}`,
          ]
        : []),
      '',
      '### Проблема',
      '',
      content.problem,
      '',
      '### Ожидаемый результат',
      '',
      content.outcome,
      '',
      '### Каналы',
      '',
      ...content.channels.map((c) => `- **${line(c.title)}** (\`${c.id}\`) — ${line(c.purpose)}`),
      '',
      '### Релизы',
      '',
      '| Версия | Релиз | Граница объёма |',
      '| --- | --- | --- |',
      ...content.releases.map(
        (r) => `| ${r.version} | ${line(r.title)} (\`${r.id}\`) | ${line(r.goal)} |`,
      ),
      '',
    );
    if (content.personas.length)
      rows.push(
        '### Персоны',
        '',
        ...content.personas.flatMap((persona) => [
          `#### ${line(persona.name)} — ${line(persona.role)} (\`${persona.id}\`)`,
          '',
          'Цели:',
          ...persona.goals.map((g) => `- ${line(g)}`),
          '',
          'Боли:',
          ...persona.pains.map((g) => `- ${line(g)}`),
          '',
        ]),
      );
    rows.push('### Фичи', '');
    for (const feature of content.features) {
      const channels = feature.channels
        .map((id) => content.channels.find((c) => c.id === id)?.title ?? id)
        .join(', ');
      rows.push(
        `#### ${line(feature.title)} (\`${feature.id}\`)`,
        '',
        feature.outcome,
        '',
        `Каналы: ${channels}`,
        '',
        'Сценарии:',
        ...feature.scenarios.map((s) => {
          const persona = content.personas.find((x) => x.id === s.personaId);
          return `- ${persona ? '**' + line(persona.name) + '** — ' : ''}${line(s.text)}`;
        }),
        '',
        'Критерии приёмки:',
        ...feature.acceptance.map((a) => {
          const release = content.releases.find((r) => r.id === a.releaseId);
          return `- \`${release?.version ?? a.releaseId}\` ${line(a.text)}`;
        }),
        '',
      );
    }
    rows.push(
      '### За пределами изменения',
      '',
      ...content.exclusions.map((x) => `- ${line(x)}`),
      '',
      '### Материалы',
      '',
      ...content.references.map((x) => `- ${line(x)}`),
      '',
    );
  }
  if (architecture)
    rows.push(
      `## Архитектура · версия ${architecture.number} · ${names[architecture.status]}`,
      '',
      `Причина версии: ${line(architecture.reason)}`,
      '',
      architecture.content.summary,
      '',
      '| Область | Выбор | Почему | Альтернативы |',
      '| --- | --- | --- | --- |',
      ...architecture.content.stack.map(
        (s) =>
          `| ${line(s.area)} | ${line(s.choice)} | ${line(s.rationale)} | ${line(s.alternatives)} |`,
      ),
      '',
      ...architecture.content.decisions.map((d) => `- ${line(d)}`),
      '',
      ...architecture.content.risks.map((d) => `- Риск: ${line(d)}`),
      '',
      architecture.content.testStrategy,
      '',
    );
  const questions = change.questions ?? [];
  if (questions.length)
    rows.push(
      '## Вопросы пользователю',
      '',
      ...questions.flatMap((q) => [
        `- **${line(q.text)}** — ${q.status === 'answered' ? 'отвечено' : q.status === 'open' ? 'ждёт ответа' : 'снят'}`,
        ...(q.why ? [`  На что влияет: ${line(q.why)}`] : []),
        ...(q.answer ? [`  Ответ ${q.answer.at}: ${line(q.answer.text)}`] : []),
      ]),
      '',
    );
  const decisions = change.decisions ?? [];
  if (decisions.length)
    rows.push(
      '## Принятые решения',
      '',
      ...decisions.flatMap((d) => [`- **${line(d.statement)}**`, `  ${line(d.rationale)}`]),
      '',
    );
  rows.push(
    '## История версий',
    '',
    ...(['product', 'architecture'] as const).flatMap((stage) =>
      change[stage].map(
        (r) =>
          `- ${stage === 'product' ? 'Продукт' : 'Архитектура'} v${r.number} · ${names[r.status]} · ${r.createdAt} · ${line(r.reason)}`,
      ),
    ),
    '',
  );
  return rows.join('\n');
}
function directory(root: string) {
  let dir = realpathSync(root);
  for (const name of ['docs', 'product']) {
    dir = join(dir, name);
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir))
      throw new Error('Проекция постановки не пишет через symlink');
  }
  return dir;
}
function atomicWrite(destination: string, content: string) {
  const temporary = destination + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, content, { flag: 'wx' });
  renameSync(temporary, destination);
}
// Markdown for reading and review, JSON for an exact diff of what changed.
// Agent progress notes are runtime telemetry and are left out: they would
// rewrite the file on every heartbeat and dirty the product repository.
export function writeProduct(state: DevContourState, root: string) {
  const changes = state.preparation?.changes ?? [];
  if (!changes.length) return;
  const dir = directory(root);
  for (const change of changes) {
    if (!/^PC-[A-Za-z0-9_-]{1,76}$/.test(change.id))
      throw new Error('Некорректный ID продуктового изменения');
    atomicWrite(join(dir, change.id + '.md'), renderProduct(change));
    const { activity: _activity, ...durable } = change;
    atomicWrite(join(dir, change.id + '.json'), JSON.stringify(durable, null, 2) + '\n');
  }
}
