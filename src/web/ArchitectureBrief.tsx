import { lazy, Suspense } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ArchitectureBrief, C4Diagram } from '../core/preparation-model.ts';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent } from '@/ui/card.tsx';
import { Input } from '@/ui/input.tsx';
import { Label } from '@/ui/label.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { EditActions, Lines, Section, SectionNav, useSectionDraft } from './BriefEditing.tsx';

const C4 = lazy(() => import('./C4Panel.tsx'));
const kinds = [
  ['person', 'Пользователь'],
  ['external-system', 'Внешняя система'],
  ['system', 'Целевая система'],
  ['container', 'Приложение / хранилище'],
  ['component', 'Компонент'],
] as const;
const sections = [
  ['summary', 'Решение'],
  ['stack', 'Стек'],
  ['decisions', 'Решения'],
  ['risks', 'Риски'],
  ['tests', 'Тесты'],
  ['c1', 'C1'],
  ['c2', 'C2'],
  ['c3', 'C3'],
] as const;
type Diagram = Pick<C4Diagram, 'nodes' | 'relationships'>;

// Nodes and relationships are the two lists every C4 level is made of, so one
// editor serves C1, C2 and each C3 diagram.
function DiagramEditor({
  value,
  onChange,
  prefix,
}: {
  value: Diagram;
  onChange: (next: Diagram) => void;
  prefix: string;
}) {
  const node = (i: number, patch: Partial<C4Diagram['nodes'][number]>) => {
    const nodes = [...value.nodes];
    nodes[i] = { ...nodes[i], ...patch };
    onChange({ ...value, nodes });
  };
  const link = (i: number, patch: Partial<C4Diagram['relationships'][number]>) => {
    const relationships = [...value.relationships];
    relationships[i] = { ...relationships[i], ...patch };
    onChange({ ...value, relationships });
  };
  return (
    <div className="grid gap-4">
      <div className="grid gap-3">
        <Label>Элементы</Label>
        {value.nodes.map((n, i) => (
          <Card key={i}>
            <CardContent className="grid gap-3 p-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <div className="grid gap-2">
                  <Label htmlFor={prefix + '-name-' + i}>Название</Label>
                  <Input
                    id={prefix + '-name-' + i}
                    value={n.name}
                    onChange={(e) => node(i, { name: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={prefix + '-kind-' + i}>Вид</Label>
                  <select
                    id={prefix + '-kind-' + i}
                    value={n.kind}
                    onChange={(e) => node(i, { kind: e.target.value as typeof n.kind })}
                  >
                    {kinds.map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor={prefix + '-id-' + i}>ID</Label>
                  <Input
                    id={prefix + '-id-' + i}
                    value={n.id}
                    onChange={(e) => node(i, { id: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={prefix + '-tech-' + i}>Технология</Label>
                  <Input
                    id={prefix + '-tech-' + i}
                    value={n.technology}
                    onChange={(e) => node(i, { technology: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={prefix + '-desc-' + i}>Назначение</Label>
                <Textarea
                  id={prefix + '-desc-' + i}
                  rows={2}
                  value={n.description}
                  onChange={(e) => node(i, { description: e.target.value })}
                />
              </div>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onChange({ ...value, nodes: value.nodes.filter((_, at) => at !== i) })
                  }
                >
                  <Trash2 aria-hidden="true" />
                  Удалить элемент
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                ...value,
                nodes: [
                  ...value.nodes,
                  {
                    id: 'element-' + (value.nodes.length + 1),
                    name: '',
                    kind: 'container',
                    description: '',
                    technology: '',
                  },
                ],
              })
            }
          >
            <Plus aria-hidden="true" />
            Добавить элемент
          </Button>
        </div>
      </div>
      <div className="grid gap-3">
        <Label>Связи</Label>
        {value.relationships.map((r, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[10rem_10rem_minmax(0,1fr)_auto]">
            <select
              aria-label={'Откуда, связь ' + (i + 1)}
              value={r.from}
              onChange={(e) => link(i, { from: e.target.value })}
            >
              {value.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name || n.id}
                </option>
              ))}
            </select>
            <select
              aria-label={'Куда, связь ' + (i + 1)}
              value={r.to}
              onChange={(e) => link(i, { to: e.target.value })}
            >
              {value.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name || n.id}
                </option>
              ))}
            </select>
            <div className="grid gap-2">
              <Input
                aria-label={'Описание связи ' + (i + 1)}
                value={r.description}
                onChange={(e) => link(i, { description: e.target.value })}
              />
              <Input
                aria-label={'Технология связи ' + (i + 1)}
                placeholder="Технология"
                value={r.technology}
                onChange={(e) => link(i, { technology: e.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={'Удалить связь ' + (i + 1)}
              onClick={() =>
                onChange({
                  ...value,
                  relationships: value.relationships.filter((_, at) => at !== i),
                })
              }
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                ...value,
                relationships: [
                  ...value.relationships,
                  {
                    from: value.nodes[0]?.id ?? '',
                    to: value.nodes[1]?.id ?? value.nodes[0]?.id ?? '',
                    description: '',
                    technology: '',
                  },
                ],
              })
            }
          >
            <Plus aria-hidden="true" />
            Добавить связь
          </Button>
        </div>
      </div>
    </div>
  );
}
function DiagramText({ diagram }: { diagram: C4Diagram }) {
  const name = (id: string) => diagram.nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer font-medium">Элементы и связи текстом</summary>
      <ul className="mt-2 grid gap-1">
        {diagram.nodes.map((n) => (
          <li key={n.id}>
            <strong>{n.name}</strong> — {n.description}
            {n.technology && ' Технология: ' + n.technology + '.'}
          </li>
        ))}
      </ul>
      <ul className="mt-2 grid gap-1">
        {diagram.relationships.map((r, i) => (
          <li key={i}>
            {name(r.from)} → {name(r.to)}: {r.description}
            {r.technology && ' (' + r.technology + ')'}
          </li>
        ))}
      </ul>
    </details>
  );
}
export function ArchitectureBriefView({
  content,
  busy,
  onSave,
}: {
  content: ArchitectureBrief;
  busy: boolean;
  onSave: (next: ArchitectureBrief, reason: string) => void;
}) {
  const { editing, draft, setDraft, open, close } = useSectionDraft(content);
  const submit = (reason: string) => (e: React.FormEvent) => {
    e.preventDefault();
    // C1 and C2 must describe the same system; keeping them in step here means
    // the operator cannot save a version the validator will refuse.
    const next = structuredClone(draft);
    if (next.c1 && next.c2) next.c2.systemId = next.c1.systemId;
    onSave(next, reason);
    close();
  };
  const system = content.c1?.nodes.find((n) => n.id === content.c1?.systemId)?.name ?? 'Система';
  const containers = content.c2?.nodes.filter((n) => n.kind === 'container') ?? [];
  return (
    <>
      <SectionNav label="Разделы архитектуры" sections={sections} />

      {(['summary', 'testStrategy'] as const).map((key) => (
        <Section
          key={key}
          id={'section-' + (key === 'summary' ? 'summary' : 'tests')}
          title={key === 'summary' ? 'Архитектурное решение' : 'Стратегия тестирования'}
          editing={editing === key}
          onEdit={() => open(key)}
        >
          {editing === key ? (
            <form
              onSubmit={submit(
                'Изменён раздел «' + (key === 'summary' ? 'Решение' : 'Тесты') + '»',
              )}
            >
              <Textarea
                aria-label={key === 'summary' ? 'Архитектурное решение' : 'Стратегия тестирования'}
                rows={10}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
              <EditActions onCancel={close} busy={busy} />
            </form>
          ) : (
            <p className="max-w-[78ch] break-words whitespace-pre-wrap">
              {content[key] || 'Пока не заполнено'}
            </p>
          )}
        </Section>
      ))}

      <Section
        id="section-stack"
        title={'Стек и обоснование (' + content.stack.length + ')'}
        editing={editing === 'stack'}
        onEdit={() => open('stack')}
      >
        {editing === 'stack' ? (
          <form onSubmit={submit('Изменён стек')} className="grid gap-4">
            {draft.stack.map((s, i) => (
              <Card key={i}>
                <CardContent className="grid gap-3 p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor={'stack-area-' + i}>Область</Label>
                      <Input
                        id={'stack-area-' + i}
                        value={s.area}
                        onChange={(e) => {
                          const stack = [...draft.stack];
                          stack[i] = { ...s, area: e.target.value };
                          setDraft({ ...draft, stack });
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor={'stack-choice-' + i}>Выбор</Label>
                      <Input
                        id={'stack-choice-' + i}
                        value={s.choice}
                        onChange={(e) => {
                          const stack = [...draft.stack];
                          stack[i] = { ...s, choice: e.target.value };
                          setDraft({ ...draft, stack });
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={'stack-why-' + i}>Почему</Label>
                    <Textarea
                      id={'stack-why-' + i}
                      rows={3}
                      value={s.rationale}
                      onChange={(e) => {
                        const stack = [...draft.stack];
                        stack[i] = { ...s, rationale: e.target.value };
                        setDraft({ ...draft, stack });
                      }}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={'stack-alt-' + i}>Альтернативы</Label>
                    <Textarea
                      id={'stack-alt-' + i}
                      rows={2}
                      value={s.alternatives}
                      onChange={(e) => {
                        const stack = [...draft.stack];
                        stack[i] = { ...s, alternatives: e.target.value };
                        setDraft({ ...draft, stack });
                      }}
                    />
                  </div>
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDraft({ ...draft, stack: draft.stack.filter((_, at) => at !== i) })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      Удалить строку
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraft({
                    ...draft,
                    stack: [
                      ...draft.stack,
                      { area: '', choice: '', rationale: '', alternatives: '' },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить строку стека
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Стек и обоснование"
          >
            <table className="w-full min-w-(--product-table-width) border-collapse">
              <thead>
                <tr>
                  {['Область', 'Выбор', 'Почему', 'Альтернативы'].map((h) => (
                    <th key={h} className="border-b p-3 text-left align-top font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {content.stack.map((s, i) => (
                  <tr key={i}>
                    <td className="border-b p-3 align-top">{s.area}</td>
                    <td className="border-b p-3 align-top">{s.choice}</td>
                    <td className="border-b p-3 align-top">{s.rationale}</td>
                    <td className="border-b p-3 align-top">{s.alternatives}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {(['decisions', 'risks'] as const).map((key) => (
        <Section
          key={key}
          id={'section-' + key}
          title={
            (key === 'decisions' ? 'Решения и границы ответственности' : 'Риски и компромиссы') +
            ' (' +
            content[key].length +
            ')'
          }
          editing={editing === key}
          onEdit={() => open(key)}
        >
          {editing === key ? (
            <form
              onSubmit={submit(
                'Изменён раздел «' + (key === 'decisions' ? 'Решения' : 'Риски') + '»',
              )}
            >
              <Lines
                id={'lines-' + key}
                label="По одному пункту на строку"
                rows={10}
                value={draft[key]}
                onChange={(next) => setDraft({ ...draft, [key]: next })}
              />
              <EditActions onCancel={close} busy={busy} />
            </form>
          ) : content[key].length ? (
            <ul className="grid gap-2">
              {content[key].map((item, i) => (
                <li key={i} className="max-w-[78ch] break-words whitespace-pre-wrap">
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Не указано</p>
          )}
        </Section>
      ))}

      {([1, 2] as const).map((level) => {
        const key = level === 1 ? 'c1' : 'c2';
        const diagram = content[key];
        return (
          <Section
            key={key}
            id={'section-' + key}
            title={'C' + level + (level === 1 ? ' · контекст' : ' · контейнеры')}
            editing={editing === key}
            onEdit={() => open(key)}
          >
            {editing === key ? (
              <form onSubmit={submit('Изменена диаграмма C' + level)}>
                {draft[key] ? (
                  <>
                    {level === 1 && (
                      <div className="mb-4 grid max-w-md gap-2">
                        <Label htmlFor="c1-system">Целевая система</Label>
                        <select
                          id="c1-system"
                          value={draft.c1!.systemId}
                          onChange={(e) =>
                            setDraft({ ...draft, c1: { ...draft.c1!, systemId: e.target.value } })
                          }
                        >
                          {draft
                            .c1!.nodes.filter((n) => n.kind === 'system')
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.name || n.id}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                    <DiagramEditor
                      prefix={key}
                      value={draft[key]}
                      onChange={(next) => setDraft({ ...draft, [key]: { ...draft[key], ...next } })}
                    />
                  </>
                ) : (
                  <p className="text-muted-foreground">Диаграмма ещё не создана.</p>
                )}
                <EditActions onCancel={close} busy={busy} />
              </form>
            ) : diagram ? (
              <Suspense fallback={<p role="status">Загрузка диаграммы…</p>}>
                <C4 diagram={diagram} level={level} systemName={system} />
                <DiagramText diagram={diagram} />
              </Suspense>
            ) : (
              <p className="text-muted-foreground">Диаграмма ещё не создана.</p>
            )}
          </Section>
        );
      })}

      <Section
        id="section-c3"
        title={'C3 · компоненты (' + content.c3.length + ')'}
        editing={editing === 'c3'}
        onEdit={() => open('c3')}
      >
        <p className="text-muted-foreground mb-4 max-w-[78ch]">
          Необязательный уровень. Рисуйте его только там, где внутреннее устройство контейнера несёт
          риск: диаграмма на каждый контейнер превращается в украшение.
        </p>
        {editing === 'c3' ? (
          <form onSubmit={submit('Изменены диаграммы C3')} className="grid gap-6">
            {draft.c3.map((c3, i) => (
              <Card key={i}>
                <CardContent className="grid gap-4 p-4">
                  <div className="grid max-w-md gap-2">
                    <Label htmlFor={'c3-container-' + i}>Контейнер</Label>
                    <select
                      id={'c3-container-' + i}
                      value={c3.containerId}
                      onChange={(e) => {
                        const next = [...draft.c3];
                        next[i] = { ...c3, containerId: e.target.value };
                        setDraft({ ...draft, c3: next });
                      }}
                    >
                      {containers.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <DiagramEditor
                    prefix={'c3-' + i}
                    value={c3}
                    onChange={(value) => {
                      const next = [...draft.c3];
                      next[i] = { ...c3, ...value };
                      setDraft({ ...draft, c3: next });
                    }}
                  />
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDraft({ ...draft, c3: draft.c3.filter((_, at) => at !== i) })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      Удалить диаграмму
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!containers.length}
                onClick={() =>
                  setDraft({
                    ...draft,
                    c3: [
                      ...draft.c3,
                      { containerId: containers[0]?.id ?? '', nodes: [], relationships: [] },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить диаграмму C3
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.c3.length ? (
          <Suspense fallback={<p role="status">Загрузка диаграмм…</p>}>
            {content.c3.map((c3) => (
              <div key={c3.containerId}>
                <C4
                  diagram={{
                    systemId: c3.containerId,
                    nodes: c3.nodes,
                    relationships: c3.relationships,
                  }}
                  level={3}
                  systemName={
                    containers.find((n) => n.id === c3.containerId)?.name ?? c3.containerId
                  }
                />
                <DiagramText
                  diagram={{
                    systemId: c3.containerId,
                    nodes: c3.nodes,
                    relationships: c3.relationships,
                  }}
                />
              </div>
            ))}
          </Suspense>
        ) : (
          <p className="text-muted-foreground">Диаграмм этого уровня нет.</p>
        )}
      </Section>
    </>
  );
}
