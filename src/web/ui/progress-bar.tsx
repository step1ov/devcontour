// Полоса готовности: подпись, «сделано / всего · %» текстом и role=progressbar.
// Общая для хода работ и главной.
export function Bar({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-muted-foreground tabular text-sm">
          {done} / {total} · {percent}%
        </span>
      </div>
      <div
        className="bg-active h-2 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="bg-success h-full rounded-full transition-[width] duration-[400ms] ease-out"
          style={{ width: percent + '%' }}
        />
      </div>
    </div>
  );
}
