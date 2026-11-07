import { useEffect } from 'react';
import { useAttention } from './AttentionProvider.tsx';

/** Экран центра внимания. */
export function AttentionCenter() {
  const attention = useAttention();
  const { onScreen } = attention;
  useEffect(() => {
    onScreen(true);
    return () => onScreen(false);
  }, [onScreen]);
  if (attention.loading)
    return (
      <p role="status" aria-busy="true">
        Загружаем действия…
      </p>
    );
  return (
    <section aria-label="Центр внимания" className="grid min-w-0 gap-3 [overflow-wrap:anywhere]">
      <ul className="m-0 grid list-none gap-2 p-0">
        {attention.items.map((i) => (
          <li key={i.sourceKey} data-attention-key={i.sourceKey}>
            {i.title}
          </li>
        ))}
      </ul>
    </section>
  );
}
