import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import UnoCSS from 'unocss/vite';

export default defineConfig({
  plugins: [react(), UnoCSS()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    proxy: {
      '/sessions': 'http://localhost:3000',
      '/agent-specs': 'http://localhost:3000',
      '/skill-packs': 'http://localhost:3000',
      '/workspaces': 'http://localhost:3000',
      '/models': 'http://localhost:3000',
      '/tool-profiles': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
