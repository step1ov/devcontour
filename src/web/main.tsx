import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import '@xyflow/react/dist/style.css';
import './tokens.css';
import './theme.css';
import './graph.css';
import { PreparationPanel } from './PreparationPanel.tsx';
import { AttentionProvider } from './AttentionProvider.tsx';
import { Home } from './Home.tsx';
import { focusHash, isHome } from './navigation.ts';

// Корень панели: главная на голом адресе, иначе — оболочка, как раньше
// (подготовка показывает панель разработки внутри себя). Оболочки и главная
// переходят друг в друга записью истории и `popstate` (`navigate`), без
// перезагрузки страницы.
function Root() {
  const [home, setHome] = useState(() => isHome(window.location));
  const switched = useRef(false);
  useEffect(() => {
    const restore = () => {
      const next = isHome(window.location);
      setHome((was) => {
        if (was !== next) switched.current = true;
        return next;
      });
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  // Смена главной и оболочки снимает фокус со ссылки, по которой ушли: он
  // переходит к якорю адреса или к заголовку открывшегося экрана.
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    if (window.location.hash.length > 1)
      focusHash(decodeURIComponent(window.location.hash.slice(1)));
    else focusHeading();
  }, [home]);
  return home ? <Home /> : <PreparationPanel />;
}

/**
 * Фокус на заголовке открывшегося экрана. Оболочка сначала рисует
 * заглушку загрузки, потом экран: пока фокус на body (заголовок заглушки
 * исчез), он переносится на текущий заголовок — не дольше 5 с.
 */
function focusHeading() {
  const started = Date.now();
  const attempt = () => {
    if (document.activeElement === document.body || !document.activeElement) {
      const heading = document.querySelector<HTMLElement>('main h1, main h2, h1, h2');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    }
    if (Date.now() - started < 5000) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
// Один источник всплывающих уведомлений на обе оболочки: подготовка
// показывает панель разработки внутри себя, и второй Toaster дублировал бы их.
// Центр внимания — над обеими оболочками и главной: до setup и после на том
// же адресе.
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AttentionProvider>
      <Root />
      <Toaster position="bottom-right" visibleToasts={3} toastOptions={{ duration: 4000 }} />
    </AttentionProvider>
  </React.StrictMode>,
);
