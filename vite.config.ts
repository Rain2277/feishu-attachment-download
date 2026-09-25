import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 飞书多维表格插件以 URL 形式加载，需要保证产物可被 iframe 嵌入。
// base 使用相对路径，方便部署到任意静态目录（Vercel / GitHub Pages / Nginx 子目录等）。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5173,
  },
});
