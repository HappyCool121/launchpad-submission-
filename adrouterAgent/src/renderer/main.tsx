import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { applyStoredTheme } from './theme';

applyStoredTheme();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Unable to find the app root.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
