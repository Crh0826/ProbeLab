import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ProbeLabApp } from './ProbeLabApp.js';
import './probelab.css';

const container = document.getElementById('probe-root');
if (container === null) throw new Error('找不到 ProbeLab 页面根节点 #probe-root');

createRoot(container).render(
  <StrictMode>
    <ProbeLabApp />
  </StrictMode>,
);
