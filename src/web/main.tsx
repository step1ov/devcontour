import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './tokens.css';
import './theme.css';
import './graph.css';
import { PreparationPanel } from './PreparationPanel.tsx';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PreparationPanel />
  </React.StrictMode>,
);
