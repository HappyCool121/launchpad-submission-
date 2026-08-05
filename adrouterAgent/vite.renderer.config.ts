import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react()],
  root: 'src/renderer',
  build: {
    emptyOutDir: true,
    outDir: '../../.vite/renderer/main_window',
  },
  server: {
    // The sibling WebUI owns 5173. Keep Electron's renderer on a dedicated
    // port so both development applications can run at the same time.
    port: 5174,
    strictPort: true,
  },
});
