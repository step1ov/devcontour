// Переход внутри панели по ссылке центра внимания. Обе оболочки (подготовка
// и разработка) уже восстанавливают вид из адреса по `popstate`: переход —
// новая запись истории и то же событие, без перезагрузки страницы.

type DepthState = { devcontourDepth?: number; attentionKey?: string } | null;

const FOCUS_TIMEOUT_MS = 10_000;
let pending: ReturnType<typeof setInterval> | undefined;

/** Ссылка ведёт внутрь этой панели (тот же origin). */
export function sameOrigin(href: string) {
  try {
    return new URL(href, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Переход по адресу панели: запись истории с глубиной панели (кнопка «Назад»
 * панели) и `popstate`, который применяют обе оболочки. Якорь получает фокус,
 * когда его элемент отрисован (`focusHash`); оболочка может переписать адрес
 * без якоря, поэтому он запоминается здесь.
 */
export function navigate(href: string, options: { attentionKey?: string } = {}) {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  const state = window.history.state as DepthState;
  // Карточка, с которой ушли: «Назад» вернёт к ней фокус.
  if (options.attentionKey)
    window.history.replaceState({ ...(state ?? {}), attentionKey: options.attentionKey }, '');
  const depth = (state?.devcontourDepth ?? 0) + 1;
  window.history.pushState({ devcontourDepth: depth }, '', url.pathname + url.search + url.hash);
  window.dispatchEvent(
    new PopStateEvent('popstate', { state: window.history.state as DepthState }),
  );
  if (url.hash.length > 1) focusHash(decodeURIComponent(url.hash.slice(1)));
}

/** Запасная цель: сообщение обсуждения вне загруженной страницы — само обсуждение. */
const fallbackOf = (id: string) => (id.startsWith('dm-') ? 'discussion' : undefined);

const visible = (element: HTMLElement) =>
  !element.closest('[hidden]') && element.getClientRects().length > 0;

/**
 * Фокус на элементе якоря, когда он появится: экран и задача отрисовываются
 * после опроса. Ждёт не дольше 10 с; новый переход отменяет прежнее ожидание.
 */
export function focusHash(id: string, timeoutMs = FOCUS_TIMEOUT_MS) {
  if (pending) clearInterval(pending);
  const started = Date.now();
  const attempt = () => {
    const element = document.getElementById(id);
    if (element && visible(element)) {
      element.scrollIntoView({ block: 'nearest' });
      element.focus();
      return true;
    }
    if (Date.now() - started < timeoutMs) return false;
    const fallback = fallbackOf(id);
    const other = fallback ? document.getElementById(fallback) : null;
    if (other && visible(other)) {
      other.scrollIntoView({ block: 'nearest' });
      other.focus();
    }
    return true;
  };
  if (attempt()) return;
  pending = setInterval(() => {
    if (attempt()) {
      clearInterval(pending);
      pending = undefined;
    }
  }, 100);
}

/** Карточка центра внимания, с которой ушли по ссылке этой записи истории. */
export const rememberedAttentionKey = () =>
  (window.history.state as DepthState)?.attentionKey ?? '';
