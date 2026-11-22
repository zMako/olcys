import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts are bundled with the application; nothing is loaded from third-party hosts.
import '@fontsource/brygada-1918/400.css';
import '@fontsource/brygada-1918/400-italic.css';
import '@fontsource/brygada-1918/600.css';
import '@fontsource/brygada-1918/700.css';
import '@fontsource/lato/400.css';
import '@fontsource/lato/400-italic.css';
import '@fontsource/lato/700.css';
import '@fontsource/lato/900.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { App } from './App';
import './styles.css';
import './platform.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
