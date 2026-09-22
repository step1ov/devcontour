import { useState } from 'react';
import {
  Boxes,
  Check,
  Milestone,
  MonitorSmartphone,
  Pencil,
  Plus,
  Trash2,
  User,
} from 'lucide-react';
import type { ProductBrief, ProductFeature } from '../core/preparation-model.ts';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.tsx';
import { Input } from '@/ui/input.tsx';
import { Label } from '@/ui/label.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';

export type Readiness = {
  id: string;
  tasks: number;
  done: number;
  failed: number;
  readiness: 'unplanned' | 'in-progress' | 'failed' | 'done';
};
const readinessNames = {
  unplanned: 'Нет задач',
  'in-progress': 'В работе',
  failed: 'Есть сбой',
  done: 'Задачи выполнены',
} as const;
const readinessTone = {
  unplanned: 'secondary',
  'in-progress': 'ready',
  failed: 'destructive',
  done: 'success',
} as const;
const sections = [
  ['problem', 'Проблема'],
  ['outcome', 'Результат'],
  ['personas', 'Персоны'],
  ['channels', 'Каналы'],
  ['releases', 'Релизы'],
  ['features', 'Фичи'],
  ['exclusions', 'Границы'],
  ['references', 'Материалы'],
] as const;

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
const slug = (value: string, fallback: string) => {
  const text = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return /^[a-z0-9]/.test(text) ? text : fallback;
};

function Section({
  id,
  title,
  onEdit,
  editing,
  children,
}: {
  id: string;
  title: string;
  onEdit?: () => void;
  editing?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-b py-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-md font-semibold">{title}</h3>
        {onEdit && !editing && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil aria-hidden="true" />
            Изменить
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}
function EditActions({ onCancel, busy }: { onCancel: () => void; busy: boolean }) {
  return (
    <div className="mt-4 flex flex-wrap gap-3">
      <Button type="submit" disabled={busy}>
        <Check aria-hidden="true" />
        Сохранить как новую версию
      </Button>
      <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
        Отмена
      </Button>
    </div>
  );
}
// Lists of plain strings edit as one item per line: far less chrome than a row
// of inputs, and it is how the operator already thinks about them.
function Lines({
  id,
  label,
  value,
  onChange,
  rows = 6,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  rows?: number;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        rows={rows}
        value={value.join('\n')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    </div>
  );
}

// The matrix answers the first question a reader has: what does this product
// consist of, and where does each part live. Rows and columns are links.
function Matrix({
  content,
  readiness,
}: {
  content: ProductBrief;
  readiness: Map<string, Readiness>;
}) {
  const release = (feature: ProductFeature) => {
    const index = Math.min(
      ...feature.acceptance.map((a) => {
        const at = content.releases.findIndex((r) => r.id === a.releaseId);
        return at < 0 ? content.releases.length : at;
      }),
    );
    return content.releases[index];
  };
  return (
    <section id="section-map" className="scroll-mt-24 border-b py-5">
      <h3 className="text-md mb-1 font-semibold">Карта продукта</h3>
      <p className="text-muted-foreground mb-4 max-w-[78ch] text-sm">
        Фичи по каналам, цвет — релиз, в котором фича появляется. Нажмите на фичу или канал, чтобы
        перейти к описанию.
      </p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Карта фич по каналам">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <thead>
            <tr>
              <th className="border-b p-2 text-left font-medium">Фича</th>
              {content.channels.map((c) => (
                <th key={c.id} className="border-b p-2 text-center font-medium">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto flex-col gap-1 py-1 whitespace-normal"
                    onClick={() => jump('channel-' + c.id)}
                  >
                    <MonitorSmartphone aria-hidden="true" />
                    <span className="max-w-24 text-xs">{c.title}</span>
                  </Button>
                </th>
              ))}
              <th className="border-b p-2 text-left font-medium">Готовность</th>
            </tr>
          </thead>
          <tbody>
            {content.features.map((f) => {
              const state = readiness.get(f.id);
              const first = release(f);
              return (
                <tr key={f.id}>
                  <th scope="row" className="border-b p-0 text-left font-normal">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto w-full justify-start gap-2 py-2 text-left whitespace-normal"
                      onClick={() => jump('feature-' + f.id)}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'h-4 w-1 shrink-0 rounded-full',
                          first?.id === content.releases[0]?.id ? 'bg-primary' : 'bg-warning',
                        )}
                      />
                      <span>
                        {f.title}
                        <small className="text-muted-foreground">{first?.version}</small>
                      </span>
                    </Button>
                  </th>
                  {content.channels.map((c) => (
                    <td key={c.id} className="border-b p-2 text-center">
                      {f.channels.includes(c.id) ? (
                        <span
                          className="bg-primary inline-block size-2.5 rounded-full"
                          aria-label={'входит в канал ' + c.title}
                        />
                      ) : (
                        <span className="text-muted-foreground" aria-label="не входит">
                          ·
                        </span>
                      )}
                    </td>
                  ))}
                  <td className="border-b p-2">
                    <Badge variant={readinessTone[state?.readiness ?? 'unplanned']}>
                      {readinessNames[state?.readiness ?? 'unplanned']}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ProductBriefView({
  content,
  readiness,
  releaseReadiness,
  busy,
  onSave,
}: {
  content: ProductBrief;
  readiness: Readiness[];
  releaseReadiness: (Readiness & { features: number; criteria: number })[];
  busy: boolean;
  onSave: (next: ProductBrief, reason: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductBrief>(content);
  const byFeature = new Map(readiness.map((r) => [r.id, r]));
  const open = (key: string) => {
    setDraft(structuredClone(content));
    setEditing(key);
  };
  const close = () => setEditing(null);
  const submit = (reason: string) => (e: React.FormEvent) => {
    e.preventDefault();
    onSave(draft, reason);
    setEditing(null);
  };
  const who = (id?: string) => (id ? (content.personas.find((x) => x.id === id)?.name ?? id) : '');
  const when = (id: string) => content.releases.find((x) => x.id === id)?.version ?? id;

  return (
    <>
      <nav
        aria-label="Разделы постановки"
        className="bg-background sticky top-0 z-10 -mx-1 mb-2 flex gap-1 overflow-x-auto border-b px-1 py-2"
      >
        <Button variant="ghost" size="sm" onClick={() => jump('section-map')}>
          Карта
        </Button>
        {sections.map(([key, label]) => (
          <Button key={key} variant="ghost" size="sm" onClick={() => jump('section-' + key)}>
            {label}
          </Button>
        ))}
      </nav>

      <Matrix content={content} readiness={byFeature} />

      {(['problem', 'outcome'] as const).map((key) => (
        <Section
          key={key}
          id={'section-' + key}
          title={key === 'problem' ? 'Проблема' : 'Ожидаемый результат'}
          editing={editing === key}
          onEdit={() => open(key)}
        >
          {editing === key ? (
            <form
              onSubmit={submit(
                'Изменён раздел «' + (key === 'problem' ? 'Проблема' : 'Результат') + '»',
              )}
            >
              <Textarea
                aria-label={key === 'problem' ? 'Проблема' : 'Ожидаемый результат'}
                rows={8}
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
        id="section-personas"
        title={'Персоны (' + content.personas.length + ')'}
        editing={editing === 'personas'}
        onEdit={() => open('personas')}
      >
        {editing === 'personas' ? (
          <form onSubmit={submit('Изменены персоны')} className="grid gap-4">
            {draft.personas.map((persona, i) => (
              <Card key={i}>
                <CardContent className="grid gap-3 p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor={'persona-name-' + i}>Имя</Label>
                      <Input
                        id={'persona-name-' + i}
                        value={persona.name}
                        onChange={(e) => {
                          const next = [...draft.personas];
                          next[i] = {
                            ...persona,
                            name: e.target.value,
                            id: persona.id || slug(e.target.value, 'persona-' + (i + 1)),
                          };
                          setDraft({ ...draft, personas: next });
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor={'persona-role-' + i}>Роль</Label>
                      <Input
                        id={'persona-role-' + i}
                        value={persona.role}
                        onChange={(e) => {
                          const next = [...draft.personas];
                          next[i] = { ...persona, role: e.target.value };
                          setDraft({ ...draft, personas: next });
                        }}
                      />
                    </div>
                  </div>
                  <Lines
                    id={'persona-goals-' + i}
                    label="Цели, по одной на строку"
                    rows={3}
                    value={persona.goals}
                    onChange={(goals) => {
                      const next = [...draft.personas];
                      next[i] = { ...persona, goals };
                      setDraft({ ...draft, personas: next });
                    }}
                  />
                  <Lines
                    id={'persona-pains-' + i}
                    label="Боли, по одной на строку"
                    rows={3}
                    value={persona.pains}
                    onChange={(pains) => {
                      const next = [...draft.personas];
                      next[i] = { ...persona, pains };
                      setDraft({ ...draft, personas: next });
                    }}
                  />
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          personas: draft.personas.filter((_, at) => at !== i),
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      Удалить персону
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
                    personas: [
                      ...draft.personas,
                      {
                        id: 'persona-' + (draft.personas.length + 1),
                        name: '',
                        role: '',
                        goals: [],
                        pains: [],
                      },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить персону
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.personas.length ? (
          <ul className="grid gap-4 md:grid-cols-2">
            {content.personas.map((persona) => (
              <li key={persona.id} id={'persona-' + persona.id} className="scroll-mt-24">
                <Card className="h-full">
                  <CardHeader className="gap-1 pb-3">
                    <CardTitle className="flex items-center gap-2">
                      <User className="text-primary size-4 shrink-0" aria-hidden="true" />
                      {persona.name}
                    </CardTitle>
                    <p className="text-muted-foreground text-sm">{persona.role}</p>
                  </CardHeader>
                  <CardContent className="grid gap-3 pt-0 text-sm">
                    <div>
                      <h4 className="mb-1 font-semibold">Цели</h4>
                      <ul className="grid list-disc gap-1 pl-5">
                        {persona.goals.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <h4 className="mb-1 font-semibold">Боли</h4>
                      <ul className="grid list-disc gap-1 pl-5">
                        {persona.pains.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Персоны не описаны — это допустимо.</p>
        )}
      </Section>

      <Section
        id="section-channels"
        title={'Каналы (' + content.channels.length + ')'}
        editing={editing === 'channels'}
        onEdit={() => open('channels')}
      >
        {editing === 'channels' ? (
          <form onSubmit={submit('Изменены каналы')} className="grid gap-4">
            {draft.channels.map((channel, i) => (
              <Card key={i}>
                <CardContent className="grid gap-3 p-4">
                  <div className="grid gap-2">
                    <Label htmlFor={'channel-title-' + i}>Название</Label>
                    <Input
                      id={'channel-title-' + i}
                      value={channel.title}
                      onChange={(e) => {
                        const next = [...draft.channels];
                        next[i] = {
                          ...channel,
                          title: e.target.value,
                          id: channel.id || slug(e.target.value, 'channel-' + (i + 1)),
                        };
                        setDraft({ ...draft, channels: next });
                      }}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={'channel-purpose-' + i}>Назначение</Label>
                    <Textarea
                      id={'channel-purpose-' + i}
                      rows={2}
                      value={channel.purpose}
                      onChange={(e) => {
                        const next = [...draft.channels];
                        next[i] = { ...channel, purpose: e.target.value };
                        setDraft({ ...draft, channels: next });
                      }}
                    />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    ID: <code className="font-mono">{channel.id}</code>
                  </p>
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
                    channels: [
                      ...draft.channels,
                      { id: 'channel-' + (draft.channels.length + 1), title: '', purpose: '' },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить канал
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              Канал нельзя удалить, пока на него ссылается фича: сначала уберите его из фич.
            </p>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {content.channels.map((c) => (
              <li key={c.id} id={'channel-' + c.id} className="scroll-mt-24">
                <Card className="h-full">
                  <CardHeader className="gap-1 pb-4">
                    <CardTitle className="flex items-start gap-2">
                      <MonitorSmartphone
                        className="text-primary mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="max-w-[60ch] break-words">{c.title}</span>
                    </CardTitle>
                    <p className="max-w-[70ch] break-words whitespace-pre-wrap">{c.purpose}</p>
                    <p className="text-muted-foreground text-sm">
                      Фич в канале:{' '}
                      {content.features.filter((f) => f.channels.includes(c.id)).length}
                    </p>
                  </CardHeader>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="section-releases"
        title={'Релизы (' + content.releases.length + ')'}
        editing={editing === 'releases'}
        onEdit={() => open('releases')}
      >
        {editing === 'releases' ? (
          <form onSubmit={submit('Изменены релизы')} className="grid gap-4">
            {draft.releases.map((release, i) => (
              <Card key={i}>
                <CardContent className="grid gap-3 p-4">
                  <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                    <div className="grid gap-2">
                      <Label htmlFor={'release-version-' + i}>Версия</Label>
                      <Input
                        id={'release-version-' + i}
                        value={release.version}
                        placeholder="0.1.0"
                        onChange={(e) => {
                          const next = [...draft.releases];
                          next[i] = { ...release, version: e.target.value };
                          setDraft({ ...draft, releases: next });
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor={'release-title-' + i}>Название</Label>
                      <Input
                        id={'release-title-' + i}
                        value={release.title}
                        onChange={(e) => {
                          const next = [...draft.releases];
                          next[i] = {
                            ...release,
                            title: e.target.value,
                            id: release.id || slug(e.target.value, 'release-' + (i + 1)),
                          };
                          setDraft({ ...draft, releases: next });
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={'release-goal-' + i}>Граница объёма</Label>
                    <Textarea
                      id={'release-goal-' + i}
                      rows={3}
                      value={release.goal}
                      onChange={(e) => {
                        const next = [...draft.releases];
                        next[i] = { ...release, goal: e.target.value };
                        setDraft({ ...draft, releases: next });
                      }}
                    />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    ID: <code className="font-mono">{release.id}</code>
                  </p>
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
                    releases: [
                      ...draft.releases,
                      {
                        id: 'release-' + (draft.releases.length + 1),
                        version: '',
                        title: '',
                        goal: '',
                      },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить релиз
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              Версии обязаны возрастать по SemVer, и у каждого релиза должен остаться хотя бы один
              критерий приёмки.
            </p>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : (
          <ol className="grid gap-3">
            {content.releases.map((r) => {
              const state = releaseReadiness.find((x) => x.id === r.id);
              return (
                <li key={r.id} id={'release-' + r.id} className="scroll-mt-24">
                  <Card>
                    <CardHeader className="gap-1 pb-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <CardTitle className="flex items-start gap-2">
                          <Milestone
                            className="text-primary mt-0.5 size-4 shrink-0"
                            aria-hidden="true"
                          />
                          <span className="max-w-[70ch] break-words">
                            {r.version} · {r.title}
                          </span>
                        </CardTitle>
                        {state && (
                          <Badge variant={readinessTone[state.readiness]}>
                            {readinessNames[state.readiness]}
                            {state.tasks > 0 && ' · ' + state.done + '/' + state.tasks}
                          </Badge>
                        )}
                      </div>
                      <p className="max-w-[78ch] break-words whitespace-pre-wrap">{r.goal}</p>
                      {state && (
                        <p className="text-muted-foreground text-sm">
                          Фич: {state.features} · критериев: {state.criteria}
                        </p>
                      )}
                    </CardHeader>
                  </Card>
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      <Section id="section-features" title={'Фичи (' + content.features.length + ')'}>
        <ul className="grid gap-4">
          {content.features.map((feature) => (
            <li key={feature.id} id={'feature-' + feature.id} className="scroll-mt-24">
              <FeatureCard
                feature={feature}
                content={content}
                state={byFeature.get(feature.id)}
                editing={editing === 'feature:' + feature.id}
                busy={busy}
                who={who}
                when={when}
                onEdit={() => open('feature:' + feature.id)}
                onCancel={close}
                draft={draft}
                setDraft={setDraft}
                onSubmit={submit('Изменена фича «' + feature.title + '»')}
              />
            </li>
          ))}
        </ul>
      </Section>

      {(['exclusions', 'references'] as const).map((key) => (
        <Section
          key={key}
          id={'section-' + key}
          title={key === 'exclusions' ? 'За пределами изменения' : 'Материалы и референсы'}
          editing={editing === key}
          onEdit={() => open(key)}
        >
          {editing === key ? (
            <form
              onSubmit={submit(
                'Изменён раздел «' + (key === 'exclusions' ? 'Границы' : 'Материалы') + '»',
              )}
            >
              <Lines
                id={'lines-' + key}
                label="По одному пункту на строку"
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
    </>
  );
}

function FeatureCard({
  feature,
  content,
  state,
  editing,
  busy,
  who,
  when,
  onEdit,
  onCancel,
  draft,
  setDraft,
  onSubmit,
}: {
  feature: ProductFeature;
  content: ProductBrief;
  state?: Readiness;
  editing: boolean;
  busy: boolean;
  who: (id?: string) => string;
  when: (id: string) => string;
  onEdit: () => void;
  onCancel: () => void;
  draft: ProductBrief;
  setDraft: (next: ProductBrief) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const index = draft.features.findIndex((f) => f.id === feature.id);
  const editable = draft.features[index];
  const patch = (next: Partial<ProductFeature>) => {
    const features = [...draft.features];
    features[index] = { ...editable, ...next };
    setDraft({ ...draft, features });
  };
  if (editing && editable)
    return (
      <Card>
        <CardContent className="p-4">
          <form onSubmit={onSubmit} className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor={'feature-title-' + feature.id}>Название</Label>
              <Input
                id={'feature-title-' + feature.id}
                value={editable.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={'feature-outcome-' + feature.id}>Результат для пользователя</Label>
              <Textarea
                id={'feature-outcome-' + feature.id}
                rows={3}
                value={editable.outcome}
                onChange={(e) => patch({ outcome: e.target.value })}
              />
            </div>
            <fieldset>
              <legend>Каналы</legend>
              {content.channels.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-start gap-2 py-1 text-sm">
                  <input
                    type="checkbox"
                    checked={editable.channels.includes(c.id)}
                    onChange={(e) =>
                      patch({
                        channels: e.target.checked
                          ? [...editable.channels, c.id]
                          : editable.channels.filter((id) => id !== c.id),
                      })
                    }
                  />
                  <span>{c.title}</span>
                </label>
              ))}
            </fieldset>
            <div className="grid gap-2">
              <Label>Сценарии</Label>
              {editable.scenarios.map((s, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                  <select
                    aria-label={'Персона сценария ' + (i + 1)}
                    value={s.personaId ?? ''}
                    onChange={(e) => {
                      const scenarios = [...editable.scenarios];
                      scenarios[i] = { ...s, personaId: e.target.value || undefined };
                      patch({ scenarios });
                    }}
                  >
                    <option value="">Без персоны</option>
                    {content.personas.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.name}
                      </option>
                    ))}
                  </select>
                  <Textarea
                    aria-label={'Текст сценария ' + (i + 1)}
                    rows={2}
                    value={s.text}
                    onChange={(e) => {
                      const scenarios = [...editable.scenarios];
                      scenarios[i] = { ...s, text: e.target.value };
                      patch({ scenarios });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={'Удалить сценарий ' + (i + 1)}
                    onClick={() =>
                      patch({ scenarios: editable.scenarios.filter((_, at) => at !== i) })
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
                  onClick={() => patch({ scenarios: [...editable.scenarios, { text: '' }] })}
                >
                  <Plus aria-hidden="true" />
                  Добавить сценарий
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Критерии приёмки</Label>
              {editable.acceptance.map((a, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                  <select
                    aria-label={'Релиз критерия ' + (i + 1)}
                    value={a.releaseId}
                    onChange={(e) => {
                      const acceptance = [...editable.acceptance];
                      acceptance[i] = { ...a, releaseId: e.target.value };
                      patch({ acceptance });
                    }}
                  >
                    {content.releases.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.version} · {r.title}
                      </option>
                    ))}
                  </select>
                  <Textarea
                    aria-label={'Текст критерия ' + (i + 1)}
                    rows={2}
                    value={a.text}
                    onChange={(e) => {
                      const acceptance = [...editable.acceptance];
                      acceptance[i] = { ...a, text: e.target.value };
                      patch({ acceptance });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={'Удалить критерий ' + (i + 1)}
                    onClick={() =>
                      patch({ acceptance: editable.acceptance.filter((_, at) => at !== i) })
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
                    patch({
                      acceptance: [
                        ...editable.acceptance,
                        { releaseId: content.releases[0]?.id ?? '', text: '' },
                      ],
                    })
                  }
                >
                  <Plus aria-hidden="true" />
                  Добавить критерий
                </Button>
              </div>
            </div>
            <EditActions onCancel={onCancel} busy={busy} />
          </form>
        </CardContent>
      </Card>
    );
  return (
    <Card>
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="flex items-start gap-2">
            <Boxes className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="max-w-[70ch] break-words">{feature.title}</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={readinessTone[state?.readiness ?? 'unplanned']}>
              {readinessNames[state?.readiness ?? 'unplanned']}
              {state && state.tasks > 0 && ' · ' + state.done + '/' + state.tasks}
            </Badge>
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              Изменить
            </Button>
          </div>
        </div>
        <p className="max-w-[78ch] break-words whitespace-pre-wrap">{feature.outcome}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-sm">Каналы:</span>
          {feature.channels.map((id) => (
            <Button
              key={id}
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-0.5"
              onClick={() => jump('channel-' + id)}
            >
              <Badge variant="secondary">
                <MonitorSmartphone aria-hidden="true" className="size-3" />
                {content.channels.find((c) => c.id === id)?.title ?? id}
              </Badge>
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 pt-0">
        <div>
          <h4 className="mb-2 text-sm font-semibold">Сценарии</h4>
          <ul className="grid gap-2">
            {feature.scenarios.map((s, i) => (
              <li key={i} className="max-w-[74ch] break-words whitespace-pre-wrap">
                {s.personaId && (
                  <Badge variant="outline" className="mr-2">
                    <User aria-hidden="true" className="size-3" />
                    {who(s.personaId)}
                  </Badge>
                )}
                {s.text}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold">Как примем</h4>
          <ul className="grid gap-2">
            {feature.acceptance.map((a, i) => (
              <li key={i} className="max-w-[74ch] break-words whitespace-pre-wrap">
                <Badge variant="ready" className="mr-2">
                  {when(a.releaseId)}
                </Badge>
                {a.text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted-foreground text-xs">
          ID фичи: <code className="font-mono">{feature.id}</code>
        </p>
      </CardContent>
    </Card>
  );
}
