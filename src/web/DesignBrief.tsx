import { Check, ExternalLink, Palette, Plus, Trash2, X } from 'lucide-react';
import type { DesignBrief, ProductChannel } from '../core/preparation-model.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent } from '@/ui/card.tsx';
import { Input } from '@/ui/input.tsx';
import { Label } from '@/ui/label.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { EditActions, Lines, Section, SectionNav, useSectionDraft } from './BriefEditing.tsx';

const sections = [
  ['concept', 'Концепция'],
  ['references', 'Референсы'],
  ['shared', 'Общее'],
  ['channels', 'По каналам'],
  ['tokens', 'Токены'],
  ['guidelines', 'Guidelines'],
  ['prototypes', 'Макеты'],
] as const;
const statuses = {
  candidate: { label: 'Кандидат', tone: 'secondary' },
  accepted: { label: 'Принят', tone: 'success' },
  rejected: { label: 'Отклонён', tone: 'destructive' },
} as const;

export function DesignBriefView({
  content,
  channels,
  busy,
  onSave,
}: {
  content: DesignBrief;
  channels: ProductChannel[];
  busy: boolean;
  onSave: (next: DesignBrief, reason: string) => void;
}) {
  const { editing, draft, setDraft, open, close } = useSectionDraft(content);
  const submit = (reason: string) => (e: React.FormEvent) => {
    e.preventDefault();
    onSave(draft, reason);
    close();
  };
  const title = (id: string) => channels.find((c) => c.id === id)?.title ?? id;
  if (!content.applicable)
    return (
      <>
        <Alert variant="info" className="mb-4">
          <AlertDescription>
            Изменению не нужно направление дизайна. Причина: {content.reason}
          </AlertDescription>
        </Alert>
        {editing === 'applicable' ? (
          <form onSubmit={submit('Направление дизайна снова требуется')}>
            <Button
              type="submit"
              disabled={busy}
              onClick={() => setDraft({ ...draft, applicable: true })}
            >
              Вернуть стадию дизайна
            </Button>
          </form>
        ) : (
          <Button variant="outline" size="sm" onClick={() => open('applicable')}>
            Дизайн всё-таки нужен
          </Button>
        )}
      </>
    );
  return (
    <>
      <SectionNav label="Разделы дизайна" sections={sections} />

      <Section
        id="section-concept"
        title="Концепция"
        editing={editing === 'concept'}
        onEdit={() => open('concept')}
      >
        {editing === 'concept' ? (
          <form onSubmit={submit('Изменена концепция дизайна')}>
            <Textarea
              aria-label="Концепция"
              rows={8}
              value={draft.concept}
              onChange={(e) => setDraft({ ...draft, concept: e.target.value })}
            />
            <div className="mt-4 grid gap-2">
              <Label htmlFor="design-not-needed">Если дизайн не требуется — объясните почему</Label>
              <Textarea
                id="design-not-needed"
                rows={2}
                value={draft.reason}
                onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
              />
              <div>
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={busy || draft.reason.trim().length < 10}
                  onClick={() => setDraft({ ...draft, applicable: false })}
                >
                  Отметить, что дизайн не нужен
                </Button>
              </div>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : (
          <p className="max-w-[78ch] break-words whitespace-pre-wrap">
            {content.concept || 'Пока не заполнено'}
          </p>
        )}
      </Section>

      <Section
        id="section-references"
        title={
          'Референсы (' +
          content.references.filter((r) => r.status === 'accepted').length +
          ' принято из ' +
          content.references.length +
          ')'
        }
        editing={editing === 'references'}
        onEdit={() => open('references')}
      >
        <p className="text-muted-foreground mb-4 max-w-[78ch]">
          Храним ссылку и то, что именно отсюда берём. Свойство, а не картинка, делает выбор
          проверяемым.
        </p>
        {editing === 'references' ? (
          <form onSubmit={submit('Изменены референсы')} className="grid gap-4">
            {draft.references.map((r, i) => (
              <Card key={i}>
                <CardContent className="grid gap-3 p-4">
                  <div className="grid gap-2">
                    <Label htmlFor={'ref-url-' + i}>Ссылка</Label>
                    <Input
                      id={'ref-url-' + i}
                      value={r.url}
                      placeholder="https://"
                      onChange={(e) => {
                        const references = [...draft.references];
                        references[i] = { ...r, url: e.target.value };
                        setDraft({ ...draft, references });
                      }}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={'ref-take-' + i}>Что берём</Label>
                    <Textarea
                      id={'ref-take-' + i}
                      rows={2}
                      value={r.takeaway}
                      onChange={(e) => {
                        const references = [...draft.references];
                        references[i] = { ...r, takeaway: e.target.value };
                        setDraft({ ...draft, references });
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(['accepted', 'candidate', 'rejected'] as const).map((status) => (
                      <Button
                        key={status}
                        type="button"
                        variant={r.status === status ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => {
                          const references = [...draft.references];
                          references[i] = { ...r, status };
                          setDraft({ ...draft, references });
                        }}
                      >
                        {status === 'accepted' ? <Check aria-hidden="true" /> : null}
                        {status === 'rejected' ? <X aria-hidden="true" /> : null}
                        {statuses[status].label}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          references: draft.references.filter((_, at) => at !== i),
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      Удалить
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
                    references: [
                      ...draft.references,
                      { url: '', takeaway: '', status: 'candidate' },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить референс
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.references.length ? (
          <ul className="grid gap-3">
            {content.references.map((r, i) => (
              <li key={i} className="flex flex-wrap items-start gap-3">
                <Badge variant={statuses[r.status].tone}>{statuses[r.status].label}</Badge>
                <span className="max-w-[70ch] break-words">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {r.url}
                    <ExternalLink aria-hidden="true" className="ml-1 inline size-3" />
                  </a>
                  <span className="block">{r.takeaway}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Референсы ещё не собраны.</p>
        )}
      </Section>

      {(['shared', 'guidelines'] as const).map((key) => (
        <Section
          key={key}
          id={'section-' + key}
          title={
            (key === 'shared' ? 'Общее для всех каналов' : 'Guidelines') +
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
                'Изменён раздел «' + (key === 'shared' ? 'Общее' : 'Guidelines') + '»',
              )}
            >
              <Lines
                id={'lines-' + key}
                label="По одному пункту на строку"
                rows={8}
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

      <Section
        id="section-channels"
        title={'Различия по каналам (' + content.channels.length + ')'}
        editing={editing === 'channels'}
        onEdit={() => open('channels')}
      >
        {editing === 'channels' ? (
          <form onSubmit={submit('Изменены различия по каналам')} className="grid gap-4">
            {draft.channels.map((item, i) => (
              <Card key={i}>
                <CardContent className="grid gap-3 p-4">
                  <div className="grid max-w-md gap-2">
                    <Label htmlFor={'design-channel-' + i}>Канал</Label>
                    <select
                      id={'design-channel-' + i}
                      value={item.channelId}
                      onChange={(e) => {
                        const next = [...draft.channels];
                        next[i] = { ...item, channelId: e.target.value };
                        setDraft({ ...draft, channels: next });
                      }}
                    >
                      {channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Lines
                    id={'design-notes-' + i}
                    label="Чем отличается, по пункту на строку"
                    rows={4}
                    value={item.notes}
                    onChange={(notes) => {
                      const next = [...draft.channels];
                      next[i] = { ...item, notes };
                      setDraft({ ...draft, channels: next });
                    }}
                  />
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDraft({ ...draft, channels: draft.channels.filter((_, at) => at !== i) })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      Удалить канал
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
                disabled={!channels.length}
                onClick={() =>
                  setDraft({
                    ...draft,
                    channels: [...draft.channels, { channelId: channels[0]?.id ?? '', notes: [] }],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить канал
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.channels.length ? (
          <ul className="grid gap-4">
            {content.channels.map((item) => (
              <li key={item.channelId}>
                <Card>
                  <CardContent className="p-4">
                    <h4 className="mb-2 font-semibold">{title(item.channelId)}</h4>
                    <ul className="grid list-disc gap-1 pl-5">
                      {item.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Различия не описаны.</p>
        )}
      </Section>

      <Section
        id="section-tokens"
        title={'Семантические токены (' + content.tokens.length + ')'}
        editing={editing === 'tokens'}
        onEdit={() => open('tokens')}
      >
        <p className="text-muted-foreground mb-4 max-w-[78ch]">
          Единственный источник значений для всех каналов. Компоненты используют имена, а не числа.
        </p>
        {editing === 'tokens' ? (
          <form onSubmit={submit('Изменены токены')} className="grid gap-3">
            {draft.tokens.map((token, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[8rem_10rem_8rem_minmax(0,1fr)_auto]">
                <Input
                  aria-label={'Группа токена ' + (i + 1)}
                  placeholder="color"
                  value={token.group}
                  onChange={(e) => {
                    const tokens = [...draft.tokens];
                    tokens[i] = { ...token, group: e.target.value };
                    setDraft({ ...draft, tokens });
                  }}
                />
                <Input
                  aria-label={'Имя токена ' + (i + 1)}
                  placeholder="surface-page"
                  value={token.name}
                  onChange={(e) => {
                    const tokens = [...draft.tokens];
                    tokens[i] = { ...token, name: e.target.value };
                    setDraft({ ...draft, tokens });
                  }}
                />
                <Input
                  aria-label={'Значение токена ' + (i + 1)}
                  value={token.value}
                  onChange={(e) => {
                    const tokens = [...draft.tokens];
                    tokens[i] = { ...token, value: e.target.value };
                    setDraft({ ...draft, tokens });
                  }}
                />
                <Input
                  aria-label={'Назначение токена ' + (i + 1)}
                  placeholder="Назначение"
                  value={token.purpose}
                  onChange={(e) => {
                    const tokens = [...draft.tokens];
                    tokens[i] = { ...token, purpose: e.target.value };
                    setDraft({ ...draft, tokens });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={'Удалить токен ' + (i + 1)}
                  onClick={() =>
                    setDraft({ ...draft, tokens: draft.tokens.filter((_, at) => at !== i) })
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
                  setDraft({
                    ...draft,
                    tokens: [...draft.tokens, { group: '', name: '', value: '', purpose: '' }],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить токен
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.tokens.length ? (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Семантические токены"
          >
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <thead>
                <tr>
                  {['Группа', 'Имя', 'Значение', 'Назначение'].map((h) => (
                    <th key={h} className="border-b p-2 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {content.tokens.map((token, i) => (
                  <tr key={i}>
                    <td className="border-b p-2">{token.group}</td>
                    <td className="border-b p-2">
                      <code className="font-mono">{token.name}</code>
                    </td>
                    <td className="border-b p-2">
                      <code className="font-mono">{token.value}</code>
                    </td>
                    <td className="border-b p-2">{token.purpose}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground">Токены не заданы.</p>
        )}
      </Section>

      <Section
        id="section-prototypes"
        title={'Макеты (' + content.prototypes.length + ')'}
        editing={editing === 'prototypes'}
        onEdit={() => open('prototypes')}
      >
        <p className="text-muted-foreground mb-4 max-w-[78ch]">
          Ссылки на макеты экранов. Сами экраны остаются контрактами внутри разработки — здесь
          только направление и то, где макет лежит.
        </p>
        {editing === 'prototypes' ? (
          <form onSubmit={submit('Изменены ссылки на макеты')} className="grid gap-3">
            {draft.prototypes.map((item, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
                <Input
                  aria-label={'Название макета ' + (i + 1)}
                  value={item.title}
                  onChange={(e) => {
                    const prototypes = [...draft.prototypes];
                    prototypes[i] = { ...item, title: e.target.value };
                    setDraft({ ...draft, prototypes });
                  }}
                />
                <Input
                  aria-label={'Ссылка на макет ' + (i + 1)}
                  placeholder="https://"
                  value={item.url}
                  onChange={(e) => {
                    const prototypes = [...draft.prototypes];
                    prototypes[i] = { ...item, url: e.target.value };
                    setDraft({ ...draft, prototypes });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={'Удалить макет ' + (i + 1)}
                  onClick={() =>
                    setDraft({ ...draft, prototypes: draft.prototypes.filter((_, at) => at !== i) })
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
                  setDraft({ ...draft, prototypes: [...draft.prototypes, { title: '', url: '' }] })
                }
              >
                <Plus aria-hidden="true" />
                Добавить макет
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.prototypes.length ? (
          <ul className="grid gap-2">
            {content.prototypes.map((item, i) => (
              <li key={i} className="flex items-center gap-2">
                <Palette className="text-primary size-4 shrink-0" aria-hidden="true" />
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {item.title}
                  <ExternalLink aria-hidden="true" className="ml-1 inline size-3" />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Макетов пока нет.</p>
        )}
      </Section>
    </>
  );
}
