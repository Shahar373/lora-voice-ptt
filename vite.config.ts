import { resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  // Relative base so the build works under https://<user>.github.io/<repo>/
  base: './',
  // `npm run dev:lan` serves self-signed HTTPS on the LAN so a phone can use the mic.
  plugins: mode === 'lan' ? [basicSsl()] : [],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        stt: resolve(__dirname, 'stt.html'),
        codec: resolve(__dirname, 'codec.html'),
      },
    },
  },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
}));
