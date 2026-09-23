import { Check, Plus, Trash2, X } from 'lucide-react';
import type { ConceptBrief } from '../core/preparation-model.ts';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent } from '@/ui/card.tsx';
import { Input } from '@/ui/input.tsx';
import { Label } from '@/ui/label.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { EditActions, Section, Source, useSectionDraft } from './BriefEditing.tsx';
import { Shot, statuses } from './ReferencesBrief.tsx';

export function ConceptBriefView({
  content,
  busy,
  onSave,
}: {
  content: ConceptBrief;
  busy: boolean;
  onSave: (next: ConceptBrief, reason: string) => void;
}) {
  const { editing, draft, setDraft, open, close } = useSectionDraft(content);
  const submit = (reason: string) => (e: React.FormEvent) => {
    e.preventDefault();
    onSave(draft, reason);
    close();
  };
  return (
    <>
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
              rows={10}
              value={draft.concept}
              onChange={(e) => setDraft({ ...draft, concept: e.target.value })}
            />
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : (
          <p className="max-w-[78ch] break-words whitespace-pre-wrap">
            {content.concept || 'Пока не заполнено'}
          </p>
        )}
      </Section>

      <Section
        id="section-sketches"
        title={'Эскизы (' + content.sketches.length + ')'}
        editing={editing === 'sketches'}
        onEdit={() => open('sketches')}
      >
        <p className="text-muted-foreground mb-4 max-w-[78ch]">
          Варианты, между которыми выбираем. Выбор делается взглядом, поэтому эскиз — изображение
          или ссылка, а не описание.
        </p>
        {editing === 'sketches' ? (
          <form onSubmit={submit('Изменены эскизы')} className="grid gap-4">
            {draft.sketches.map((s, i) => (
              <Card key={i}>
                <CardContent className="grid gap-3 p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor={'sketch-title-' + i}>Название варианта</Label>
                      <Input
                        id={'sketch-title-' + i}
                        value={s.title}
                        onChange={(e) => {
                          const sketches = [...draft.sketches];
                          sketches[i] = { ...s, title: e.target.value };
                          setDraft({ ...draft, sketches });
                        }}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor={'sketch-file-' + i}>Файл в docs/design/sketches</Label>
                      <Input
                        id={'sketch-file-' + i}
                        value={s.file ?? ''}
                        placeholder="workout-a.png"
                        onChange={(e) => {
                          const sketches = [...draft.sketches];
                          sketches[i] = { ...s, file: e.target.value || undefined };
                          setDraft({ ...draft, sketches });
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={'sketch-url-' + i}>
                      Исходник: ссылка или путь в репозитории
                    </Label>
                    <Input
                      id={'sketch-url-' + i}
                      value={s.url}
                      placeholder="https://… или docs/design/sketches/файл.html"
                      onChange={(e) => {
                        const sketches = [...draft.sketches];
                        sketches[i] = { ...s, url: e.target.value };
                        setDraft({ ...draft, sketches });
                      }}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor={'sketch-note-' + i}>Чем отличается</Label>
                    <Textarea
                      id={'sketch-note-' + i}
                      rows={2}
                      value={s.note}
                      onChange={(e) => {
                        const sketches = [...draft.sketches];
                        sketches[i] = { ...s, note: e.target.value };
                        setDraft({ ...draft, sketches });
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(['accepted', 'candidate', 'rejected'] as const).map((status) => (
                      <Button
                        key={status}
                        type="button"
                        variant={s.status === status ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => {
                          const sketches = [...draft.sketches];
                          sketches[i] = { ...s, status };
                          setDraft({ ...draft, sketches });
                        }}
                      >
                        {status === 'accepted' && <Check aria-hidden="true" />}
                        {status === 'rejected' && <X aria-hidden="true" />}
                        {status === 'accepted' ? 'Выбран' : statuses[status].label}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDraft({ ...draft, sketches: draft.sketches.filter((_, at) => at !== i) })
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
                    sketches: [
                      ...draft.sketches,
                      { title: '', url: '', note: '', status: 'candidate' },
                    ],
                  })
                }
              >
                <Plus aria-hidden="true" />
                Добавить эскиз
              </Button>
            </div>
            <EditActions onCancel={close} busy={busy} />
          </form>
        ) : content.sketches.length ? (
          <ul className="grid gap-4 md:grid-cols-2">
            {content.sketches.map((s, i) => (
              <li key={i}>
                <Card className="h-full">
                  <CardContent className="grid gap-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong>{s.title}</strong>
                      <Badge variant={statuses[s.status].tone}>
                        {s.status === 'accepted' ? 'Выбран' : statuses[s.status].label}
                      </Badge>
                    </div>
                    {s.file && (
                      <Shot
                        file={s.file}
                        alt={s.title}
                        kind="sketches"
                        className="w-full rounded-sm"
                      />
                    )}
                    {/* The source stays visible next to the image: a sketch is
                        worth editing, and that needs the file it came from. */}
                    <Source url={s.url} />
                    {s.note && <p className="text-muted-foreground text-sm">{s.note}</p>}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Эскизов пока нет.</p>
        )}
      </Section>
    </>
  );
}
