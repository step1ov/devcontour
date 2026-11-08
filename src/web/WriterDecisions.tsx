import type { AssumptionLine } from '../application/assumptions.ts';

const floorNames: Record<string, string> = {
  declared: 'объявленная область',
  'critical-path': 'критический путь',
};

function severityText(a: Pick<AssumptionLine, 'severity' | 'effectiveSeverity' | 'floors'>) {
  const raised = a.effectiveSeverity !== a.severity;
  return [
    `серьёзность ${a.effectiveSeverity}`,
    raised ? `исполнитель оценил ${a.severity}` : '',
    a.floors.length ? 'поднята: ' + a.floors.map((f) => floorNames[f] ?? f).join(', ') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Решения, которые исполнитель принял сам ниже порога вопросов: вопрос,
 * выбор, основание и серьёзность. Показываются рядом с результатом попытки —
 * в ходе попыток карточки задачи и в результате быстрого изменения, — чтобы
 * оператор видел развилки, на которых построен результат, без журнала.
 */
export function WriterDecisions({
  items,
}: {
  items?: Pick<
    AssumptionLine,
    'question' | 'chosen' | 'rationale' | 'severity' | 'effectiveSeverity' | 'floors'
  >[];
}) {
  if (!items?.length) return null;
  return (
    <section aria-label="Решения исполнителя" className="grid gap-1">
      <h4 className="text-muted-foreground m-0 text-xs font-medium">
        Решения исполнителя ({items.length})
      </h4>
      <p className="text-faint m-0 text-xs">
        Развилки ниже порога вопросов: исполнитель решил их сам, не останавливая работу.
      </p>
      <ul className="m-0 grid list-none gap-2 p-0">
        {items.map((a, i) => (
          <li
            key={i}
            className="border-rule grid gap-0.5 border-l-2 pl-2 text-xs [overflow-wrap:anywhere]"
            data-writer-decision
          >
            <span className="text-foreground">{a.question}</span>
            <span>
              <span className="text-muted-foreground">Выбор: </span>
              {a.chosen}
            </span>
            <span>
              <span className="text-muted-foreground">Основание: </span>
              {a.rationale}
            </span>
            <span className="text-muted-foreground">{severityText(a)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
