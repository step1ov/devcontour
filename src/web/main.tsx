import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import '@xyflow/react/dist/style.css';
import './tokens.css';
import './theme.css';
import './graph.css';
import { PreparationPanel } from './PreparationPanel.tsx';
import { AttentionProvider } from './AttentionProvider.tsx';
import { Home } from './Home.tsx';
import { isHome } from './navigation.ts';

// Корень панели: главная на голом адресе, иначе — оболочка, как раньше
// (подготовка показывает панель разработки внутри себя). Оболочки и главная
// переходят друг в друга записью истории и `popstate` (`navigate`), без
// перезагрузки страницы.
function Root() {
  const [home, setHome] = useState(() => isHome(window.location));
  useEffect(() => {
    const restore = () => setHome(isHome(window.location));
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  return home ? <Home /> : <PreparationPanel />;
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
