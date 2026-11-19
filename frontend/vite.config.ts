import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, '../src/triad/web/dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) {
            return 'vendor-three';
          }
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) {
            return 'vendor-charts';
          }
          if (id.includes('node_modules/framer-motion') || id.includes('node_modules/motion-')) {
            return 'vendor-motion';
          }
          if (
            id.includes('node_modules/gsap') ||
            id.includes('node_modules/@gsap/') ||
            id.includes('node_modules/lenis')
          ) {
            return 'vendor-gsap';
          }
          if (id.includes('node_modules/cmdk')) {
            return 'vendor-cmdk';
          }
          if (
            id.includes('node_modules/@tanstack/react-table') ||
            id.includes('node_modules/@radix-ui/') ||
            id.includes('node_modules/lucide-react')
          ) {
            return 'vendor-ui';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
