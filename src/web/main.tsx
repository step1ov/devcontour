import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import '@xyflow/react/dist/style.css';
import './tokens.css';
import './theme.css';
import './graph.css';
import { PreparationPanel } from './PreparationPanel.tsx';
import { AttentionProvider } from './AttentionProvider.tsx';
// Один источник всплывающих уведомлений на обе оболочки: подготовка
// показывает панель разработки внутри себя, и второй Toaster дублировал бы их.
// Центр внимания — над обеими оболочками: до setup и после на том же адресе.
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AttentionProvider>
      <PreparationPanel />
      <Toaster position="bottom-right" visibleToasts={3} toastOptions={{ duration: 4000 }} />
    </AttentionProvider>
  </React.StrictMode>,
);
