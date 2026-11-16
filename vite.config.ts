import { defineConfig } from 'vite';
export default defineConfig({ clearScreen: false, server: { port: 1420, strictPort: true }, build: { outDir: 'web-dist', target: 'es2022' }, envPrefix: ['VITE_'] });
