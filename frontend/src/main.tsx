import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// Syntax-highlighting token colors (11 §11); the code block keeps its own
// background — see the `.hljs` override in styles.css.
import 'highlight.js/styles/github-dark.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
