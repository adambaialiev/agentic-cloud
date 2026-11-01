import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import './workspace.css';
import './app.css';
import './join-flow.css';
import { rememberFirstVisit } from '../../src/shared/first-visit.js';

// Where this browser first came from, if the landing site has not already
// noted it — a person can arrive straight on the Workspace from a link.
rememberFirstVisit(window);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
