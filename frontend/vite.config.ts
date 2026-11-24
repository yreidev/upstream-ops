import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BACKEND_TARGET = process.env.VITE_BACKEND_URL ?? 'http://localhost:8418'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // 第三方较重库按需独立成块，避免进入首屏入口；匹配范围不含依赖 React 的顶层包。
        codeSplitting: {
          groups: [
            { name: 'd3-vendor', test: /[\\/]node_modules[\\/]d3-[^\\/]+[\\/]/ },
            { name: 'markdown-vendor', test: /[\\/]node_modules[\\/](remark|rehype|unified|micromark|mdast|hast|unist|parse5|vfile)[^\\/]*[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 3010,
    strictPort: true,
    proxy: {
      // 仅代理后端 API / 健康检查。
      '/api':     { target: BACKEND_TARGET, changeOrigin: true },
      '/healthz': { target: BACKEND_TARGET, changeOrigin: true },
    },
  },
})
