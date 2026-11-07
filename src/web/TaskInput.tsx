import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import type { InputService } from '../application/input.ts';

type View = ReturnType<InputService['taskView']>;
type Current = NonNullable<View['current']>;

/**
 * Состояние вопроса словами оператора. «Передано в новую попытку» — только
 * после начала вызова исполнителя с ответом (`delivered`), а не после
 * применения: «агент прочитал» панель не утверждает.
 */
export const inputStateLabels: Record<string, string> = {
  'awaiting-answer': 'Нужен ответ',
  'answer-saved': 'Ответ сохранён',
  'context-review': 'Нужна подготовка и проверка контекста',
  'ready-to-apply': 'Контекст с ответом проверен',
  'applied-awaiting-claim': 'Ответ применён, ждёт попытки',
  delivered: 'Передано в новую попытку',
  stale: 'Ответ устарел: нужен новый контекст',
  cancelled: 'Вопрос снят',
  superseded: 'Вопрос заменён',
};

const kindLabels: Record<string, string> = {
  clarification: 'уточнение',
  'requirement-change': 'изменение требований',
};

async function post(path: string, body: unknown) {
  const response = await fetch('/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
  if (!response.ok) throw new Error(data?.error ?? `сервер ответил ${response.status}`);
  return data;
}

/**
 * Вопрос исполнителя в карточке задачи: вопрос, варианты с последствиями,
 * рекомендованный вариант, серьёзность и почему она поднята, ответ
 * оператора, применение (только в режиме согласования оператором) и снятие
 * вопроса. Управления исполнителем («steering») здесь нет: ответ уходит в
 * новую попытку через снимок контекста, а не в идущую.
 */
export function TaskInput({ taskId, revision }: { taskId: string; revision: string }) {
  const [view, setView] = useState<View>();
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [option, setOption] = useState<string | null>(null);
  const [kind, setKind] = useState<'clarification' | 'requirement-change'>('clarification');
  const [busy, setBusy] = useState(false);
  // Ключ повтора ответа: двойная отправка той же формы — одно сообщение.
  const [answerKey, setAnswerKey] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/tasks/${taskId}/input`);
      if (!response.ok) return;
      setView((await response.json()) as View);
    } catch {
      /* Следующий опрос повторит чтение. */
    }
  }, [taskId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load, revision]);
  if (!view?.current) return null;
  const current: Current = view.current;
  const answers = current.answers as {
    revision: number;
    text?: string;
    excerpt?: string;
    kind: string;
    optionId: string | null;
    actor: { kind: string };
  }[];
  const latest = answers.at(-1);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setText('');
      await load();
    } catch (e) {
      // Текст ответа остаётся в форме: конфликт версии не теряет набранное.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const q = current.question;
  const answerable = current.state === 'awaiting-answer' || current.state === 'answer-saved';
  const operatorApplies =
    view.approvalMode === 'operator' &&
    (current.state === 'context-review' || current.state === 'ready-to-apply');
  return (
    <section
      id="input"
      aria-label="Вопрос исполнителя"
      className="border-border mt-3 rounded-md border p-3 text-sm"
      data-input-state={current.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-sm font-medium">
          {current.kind === 'follow-up' ? 'Решение исполнителя' : 'Вопрос исполнителя'}
        </h3>
        <Badge variant={current.state === 'awaiting-answer' ? 'destructive' : 'secondary'}>
          {inputStateLabels[current.state] ?? current.state}
        </Badge>
        <span className="text-muted-foreground text-xs">
          серьёзность {current.severity}
          {current.floors.length ? ' · критический: ' + current.floors.join(', ') : ''}
        </span>
      </div>
      <p className="mt-2 mb-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{q.question}</p>
      {current.normalized && (
        <p className="text-faint m-0 text-xs">Вопрос пришёл вне схемы и приведён к ней контуром.</p>
      )}
      {q.options.length > 0 && (
        <ul className="m-0 mt-1 list-none p-0" aria-label="Варианты">
          {q.options.map((o) => (
            <li key={o.id} className="mt-1">
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name={`input-option-${current.requestId}`}
                  value={o.id}
                  disabled={!answerable}
                  checked={option === o.id}
                  onChange={() => setOption(o.id)}
                />
                <span>
                  {o.label}
                  {q.recommended === o.id && (
                    <Badge variant="outline" className="ml-2">
                      рекомендует исполнитель
                    </Badge>
                  )}
                  {o.consequence && (
                    <span className="text-muted-foreground block text-xs">{o.consequence}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {latest && (
        <p className="bg-raised mt-2 mb-0 rounded-md p-2" data-input-answer>
          Ответ r{latest.revision} ({kindLabels[latest.kind] ?? latest.kind},{' '}
          {latest.actor.kind === 'operator' ? 'оператор' : 'ведущий'}
          {latest.optionId ? `, вариант ${latest.optionId}` : ''}):{' '}
          <span className="whitespace-pre-wrap">{latest.text ?? latest.excerpt}</span>
        </p>
      )}
      {current.state === 'stale' && (
        <p className="text-muted-foreground mt-2 mb-0 text-xs">
          Применённый ответ устарел до попытки: ведущий строит контекст заново.
        </p>
      )}
      {current.state !== 'awaiting-answer' && current.next !== 'none' && (
        <p className="text-muted-foreground mt-2 mb-0 text-xs" data-input-next>
          Дальше: {current.actor === 'operator' ? 'оператор' : 'ведущий'} — {current.next}
        </p>
      )}
      {answerable && current.kind === 'question' && (
        <form
          className="mt-2 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() =>
              post(`tasks/${taskId}/input/${current.requestId}/answer`, {
                text,
                ...(option ? { optionId: option } : {}),
                kind,
                expectedVersion: current.version,
                idempotencyKey: answerKey,
              }).then(() => setAnswerKey(crypto.randomUUID())),
            );
          }}
        >
          <label className="grid gap-1">
            <span className="text-xs">{latest ? 'Исправить ответ' : 'Ответ'}</span>
            <Textarea
              value={text}
              maxLength={3000}
              onChange={(e) => setText(e.target.value)}
              aria-label="Ответ исполнителю"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={kind === 'requirement-change'}
              onChange={(e) => setKind(e.target.checked ? 'requirement-change' : 'clarification')}
            />
            Ответ меняет требования (корректировка доски, а не продолжение)
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || !text.trim()}>
              Сохранить ответ
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  post(`tasks/${taskId}/input/${current.requestId}/cancel`, {
                    expectedVersion: current.version,
                    reason: 'Снят оператором в панели',
                  }),
                )
              }
            >
              Снять вопрос
            </Button>
          </div>
        </form>
      )}
      {operatorApplies && (
        <Button
          className="mt-2"
          size="sm"
          disabled={busy}
          onClick={() =>
            void act(() =>
              post(`tasks/${taskId}/input/${current.requestId}/apply`, {
                expectedVersion: current.version,
              }),
            )
          }
        >
          Применить ответ
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive mt-2 mb-0 text-xs">
          {error}
        </p>
      )}
    </section>
  );
}
