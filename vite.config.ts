import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 渲染进程构建：产物输出到 dist-renderer，主进程以 file:// 加载
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500
  }
});
