import { useState } from 'react';
import { Check, Pencil } from 'lucide-react';
import { Button } from '@/ui/button.tsx';
import { Label } from '@/ui/label.tsx';
import { Textarea } from '@/ui/textarea.tsx';

// Shared editing chrome for the two briefs: the product and the architecture
// are read and changed the same way, so the affordances are identical.
export function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
export function SectionNav({
  label,
  sections,
}: {
  label: string;
  sections: readonly (readonly [string, string])[];
}) {
  return (
    <nav
      aria-label={label}
      className="bg-background sticky top-0 z-10 -mx-1 mb-2 flex gap-1 overflow-x-auto border-b px-1 py-2"
    >
      {sections.map(([key, title]) => (
        <Button key={key} variant="ghost" size="sm" onClick={() => jump('section-' + key)}>
          {title}
        </Button>
      ))}
    </nav>
  );
}
export function Section({
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
export function EditActions({ onCancel, busy }: { onCancel: () => void; busy: boolean }) {
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
export function Lines({
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
// One section is edited at a time; the draft is a copy so Cancel is free.
export function useSectionDraft<T>(content: T) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<T>(content);
  return {
    editing,
    draft,
    setDraft,
    setEditing,
    open: (key: string) => {
      setDraft(structuredClone(content));
      setEditing(key);
    },
    close: () => setEditing(null),
  };
}
