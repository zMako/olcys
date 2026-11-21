import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI talks only to the local API; nothing is loaded from third-party hosts.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': process.env.API_URL ?? 'http://localhost:4000' } },
});
