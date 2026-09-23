import { useState } from 'react';
import { Check, ExternalLink, FileCode2, ImageOff, Plus, Trash2, X, ZoomIn } from 'lucide-react';
import type { ReferencesBrief } from '../core/preparation-model.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent } from '@/ui/card.tsx';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog.tsx';
import { Input } from '@/ui/input.tsx';
import { Label } from '@/ui/label.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { EditActions, Section, useSectionDraft } from './BriefEditing.tsx';

export const statuses = {
  candidate: { label: 'Кандидат', tone: 'secondary' },
  accepted: { label: 'Принят', tone: 'success' },
  rejected: { label: 'Отклонён', tone: 'destructive' },
} as const;
export const assetUrl = (file: string, kind: 'refs' | 'sketches' = 'refs') =>
  '/api/design/asset?kind=' + kind + '&file=' + encodeURIComponent(file);

// A screenshot is here so candidates are compared by looking. Clicking one
// opens it full size, because a thumbnail decides nothing.
export function Shot({
  file,
  alt,
  kind = 'refs',
  className,
}: {
  file?: string;
  alt: string;
  kind?: 'refs' | 'sketches';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!file)
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        <ImageOff aria-hidden="true" className="size-4" />
        нет
      </span>
    );
  return (
    <>
      <button
        type="button"
        className="group relative cursor-zoom-in rounded-sm border"
        onClick={() => setOpen(true)}
        aria-label={'Увеличить: ' + alt}
      >
        <img
          src={assetUrl(file, kind)}
          alt={alt}
          className={className ?? 'h-24 w-auto rounded-sm'}
        />
        <span className="bg-card/80 absolute right-1 bottom-1 rounded-sm p-0.5 opacity-0 group-hover:opacity-100">
          <ZoomIn aria-hidden="true" className="size-4" />
        </span>
      </button>
      {open && (
        <Dialog open onOpenChange={(next) => !next && setOpen(false)}>
          <DialogContent className="max-w-[min(96vw,80rem)]">
            <DialogTitle className="text-md mb-3 font-semibold">{alt}</DialogTitle>
            <img src={assetUrl(file, kind)} alt={alt} className="h-auto w-full" />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function ReferencesBriefView({
  content,
  busy,
  onSave,
}: {
  content: ReferencesBrief;
  busy: boolean;
  onSave: (next: ReferencesBrief, reason: string) => void;
}) {
  const { editing, draft, setDraft, open, close } = useSectionDraft(content);
  const submit = (reason: string) => (e: React.FormEvent) => {
    e.preventDefault();
    onSave(draft, reason);
    close();
  };
  const accepted = content.items.filter((r) => r.status === 'accepted').length;
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
              Вернуть дизайн в объём
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
      <Section
        id="section-summary"
        title="Что искали"
        editing={editing === 'summary'}
        onEdit={() => open('summary')}
      >
        {editing === 'summary' ? (
          <form onSubmit={submit('Изменён обзор поиска референсов')}>
            <Textarea
              aria-label="Что искали"
              rows={6}
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
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
            {content.summary || 'Пока не заполнено'}
          </p>
        )}
      </Section>

      <Section
        id="section-items"
        title={'Референсы (' + accepted + ' принято из ' + content.items.length + ')'}
        editing={editing === 'items'}
        onEdit={() => open('items')}
      >
        <p className="text-muted-foreground mb-4 max-w-[78ch]">
          Храним ссылку, скриншот и то, что именно отсюда берём. Свойство, а не картинка, делает
          выбор проверяемым; скриншот нужен, чтобы сравнивать кандидатов взглядом.
        </p>
        {editing === 'items' ? (
          <form onSubmit={submit('Изменены референсы')} className="grid gap-4">
            {draft.items.map((r, i) => (
              <Card key={i}>
                <CardContent className="grid gap-3 p-4">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <div className="grid gap-2">
                      <Label htmlFor={'ref-url-' + i}>Ссылка или путь в репозитории</Label>
                      <Input
                        id={'ref-url-' + i}
                        value={r.url}
                        placeholder="https://… или docs/design/refs/файл.html"
                        onChange={(e) => {
                          const items = [...draft.items];
                          items[i] = { ...r, url: e.target.value };
                          setDraft({ ...draft, items });
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor={'ref-shot-' + i}>Файл скриншота</Label>
                      <Input
                        id={'ref-shot-' + i}
                        value={r.screenshot ?? ''}
                        placeholder="hevy-log.png"
                        onChange={(e) => {
                          const items = [...draft.items];
                          items[i] = { ...r, screenshot: e.target.value || undefined };
                          setDraft({ ...draft, items });
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={'ref-take-' + i}>Что берём</Label>
                    <Textarea
                      id={'ref-take-' + i}
                      rows={2}
                      value={r.takeaway}
                      onChange={(e) => {
                        const items = [...draft.items];
                        items[i] = { ...r, takeaway: e.target.value };
                        setDraft({ ...draft, items });
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(['accepted', 'candidate', 'rejected'] as const).map((status) => (
                      <Button
                        key={status}
                        type="button"
                        variant={r.status === status ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => {
                          const items = [...draft.items];
                          items[i] = { ...r, status };
                          setDraft({ ...draft, items });
                        }}
                      >
                        {status === 'accepted' && <Check aria-hidden="true" />}
                        {status === 'rejected' && <X aria-hidden="true" />}
                        {statuses[status].label}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDraft({ ...draft, items: draft.items.filter((_, at) => at !== i) })
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
                    items: [...draft.items, { url: '', takeaway: '', status: 'candidate' }],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить референс
              </Button>
            </div>
            <p className="text-muted-foreground text-sm">
              Скриншоты лежат в <code className="font-mono">docs/design/refs/</code>; в поле
              указывается имя файла.
            </p>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.items.length ? (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Референсы">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr>
                  {['Скриншот', 'Статус', 'Ссылка', 'Что берём'].map((h) => (
                    <th key={h} className="border-b p-2 text-left align-top font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {content.items.map((r, i) => (
                  <tr key={i}>
                    <td className="border-b p-2 align-top">
                      <Shot file={r.screenshot} alt={r.takeaway || r.url} />
                    </td>
                    <td className="border-b p-2 align-top">
                      <Badge variant={statuses[r.status].tone}>{statuses[r.status].label}</Badge>
                    </td>
                    <td className="border-b p-2 align-top">
                      {/^https?:\/\//i.test(r.url) ? (
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary break-all underline-offset-4 hover:underline"
                        >
                          {r.url}
                          <ExternalLink aria-hidden="true" className="ml-1 inline size-3" />
                        </a>
                      ) : (
                        // A reference can live in the repository. Rendering the path as
                        // a link would only produce one that leads nowhere.
                        <span className="text-muted-foreground flex items-start gap-1">
                          <FileCode2 aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                          <code className="font-mono break-all">{r.url}</code>
                        </span>
                      )}
                    </td>
                    <td className="border-b p-2 align-top">{r.takeaway}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground">Референсы ещё не собраны.</p>
        )}
      </Section>
    </>
  );
}
