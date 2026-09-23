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

const fileUrl = (path: string) =>
  '/api/design/file/' + path.split('/').map(encodeURIComponent).join('/');
const extensionOf = (path: string) => (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
const images = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg']);
const pages = new Set(['html', 'htm']);

// A handoff entry is meant to be looked at. A page renders in a sandboxed frame
// and an export as an image; everything else stays a link, because a stylesheet
// tells the reader nothing when embedded.
function Artifact({ title, path }: { title: string; path: string }) {
  const extension = extensionOf(path);
  const url = fileUrl(path);
  return (
    <Card>
      <CardContent className="grid gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Palette className="text-primary size-4 shrink-0" aria-hidden="true" />
            <strong>{title}</strong>
          </span>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            Открыть отдельно
            <ExternalLink aria-hidden="true" className="ml-1 inline size-3" />
          </a>
        </div>
        <code className="text-muted-foreground font-mono text-xs break-all">{path}</code>
        {pages.has(extension) ? (
          <iframe
            src={url}
            title={title}
            loading="lazy"
            sandbox="allow-scripts"
            className="bg-background h-[34rem] w-full rounded-sm border"
          />
        ) : images.has(extension) ? (
          <img
            src={url}
            alt={title}
            loading="lazy"
            className="max-h-[34rem] w-auto rounded-sm border"
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

const sections = [
  ['palette', 'Палитра'],
  ['tokens', 'Токены'],
  ['shared', 'Общее'],
  ['channels', 'По каналам'],
  ['guidelines', 'Guidelines'],
  ['handoff', 'Пакет передачи'],
] as const;

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
  return (
    <>
      <SectionNav label="Разделы дизайн-системы" sections={sections} />

      <Section
        id="section-palette"
        title={'Палитра (' + content.palette.length + ')'}
        editing={editing === 'palette'}
        onEdit={() => open('palette')}
      >
        <p className="text-muted-foreground mb-4 max-w-[78ch]">
          Примитивы палитры. Компоненты их не используют напрямую — только через семантические
          токены ниже.
        </p>
        {editing === 'palette' ? (
          <form onSubmit={submit('Изменена палитра')} className="grid gap-3">
            {draft.palette.map((color, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[3rem_12rem_9rem_minmax(0,1fr)_auto]">
                <span
                  aria-hidden="true"
                  className="h-10 rounded-sm border"
                  style={{
                    background: /^#[0-9a-fA-F]{6}$/.test(color.value) ? color.value : undefined,
                  }}
                />
                <Input
                  aria-label={'Имя цвета ' + (i + 1)}
                  value={color.name}
                  onChange={(e) => {
                    const palette = [...draft.palette];
                    palette[i] = { ...color, name: e.target.value };
                    setDraft({ ...draft, palette });
                  }}
                />
                <Input
                  aria-label={'Значение цвета ' + (i + 1)}
                  placeholder="#rrggbb"
                  value={color.value}
                  onChange={(e) => {
                    const palette = [...draft.palette];
                    palette[i] = { ...color, value: e.target.value };
                    setDraft({ ...draft, palette });
                  }}
                />
                <Input
                  aria-label={'Роль цвета ' + (i + 1)}
                  placeholder="Где используется"
                  value={color.role}
                  onChange={(e) => {
                    const palette = [...draft.palette];
                    palette[i] = { ...color, role: e.target.value };
                    setDraft({ ...draft, palette });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={'Удалить цвет ' + (i + 1)}
                  onClick={() =>
                    setDraft({ ...draft, palette: draft.palette.filter((_, at) => at !== i) })
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
                    // Left blank on purpose: the value is data the operator
                    // supplies, and a hardcoded default would be a colour
                    // literal outside tokens.css.
                    palette: [...draft.palette, { name: '', value: '', role: '' }],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить цвет
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.palette.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {content.palette.map((color) => (
              <li key={color.name} className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="size-12 shrink-0 rounded-md border"
                  style={{ background: color.value }}
                />
                <span className="min-w-0">
                  <code className="font-mono text-sm">{color.name}</code>
                  <span className="text-muted-foreground block text-xs">{color.value}</span>
                  {color.role && <span className="block text-sm">{color.role}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Палитра не задана.</p>
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
        id="section-handoff"
        title={'Пакет передачи (' + content.handoff.length + ')'}
        editing={editing === 'handoff'}
        onEdit={() => open('handoff')}
      >
        <p className="text-muted-foreground mb-4 max-w-[78ch]">
          Где лежит пакет передачи: экспорт макетов, файл токенов, спецификация. Экраны остаются
          контрактами внутри разработки — здесь только путь к артефактам.
        </p>
        {editing === 'handoff' ? (
          <form onSubmit={submit('Изменены ссылки на макеты')} className="grid gap-3">
            {draft.handoff.map((item, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
                <Input
                  aria-label={'Название артефакта ' + (i + 1)}
                  value={item.title}
                  onChange={(e) => {
                    const handoff = [...draft.handoff];
                    handoff[i] = { ...item, title: e.target.value };
                    setDraft({ ...draft, handoff });
                  }}
                />
                <Input
                  aria-label={'Путь к артефакту ' + (i + 1)}
                  placeholder="docs/design/ui/handoff"
                  value={item.path}
                  onChange={(e) => {
                    const handoff = [...draft.handoff];
                    handoff[i] = { ...item, path: e.target.value };
                    setDraft({ ...draft, handoff });
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={'Удалить артефакт ' + (i + 1)}
                  onClick={() =>
                    setDraft({ ...draft, handoff: draft.handoff.filter((_, at) => at !== i) })
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
                  setDraft({ ...draft, handoff: [...draft.handoff, { title: '', path: '' }] })
                }
              >
                <Plus aria-hidden="true" />
                Добавить артефакт
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.handoff.length ? (
          <ul className="grid gap-5">
            {content.handoff.map((item, i) => (
              <li key={i}>
                <Artifact title={item.title} path={item.path} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Пакет передачи ещё не собран.</p>
        )}
      </Section>
    </>
  );
}
