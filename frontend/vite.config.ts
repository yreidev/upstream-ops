import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BACKEND_TARGET = process.env.VITE_BACKEND_URL ?? 'http://localhost:8418'

// 依赖源码里的写法触发、对产物没有影响的构建警告：
//   - EVAL：Semi 入口导出了 Lottie 组件，lottie-web 里有 eval。lottie-web 声明了无副作用，没用到就不会打进产物，只是被扫描时报一次。
//   - MODULE_LEVEL_DIRECTIVE：@mdx-js/mdx、hast-util-to-estree 里有单独一行 ''，被当成模块指令，空字符串指令没有任何含义。
// 只忽略 node_modules 里的这两类，自己代码里的照常报。
const IGNORED_DEPENDENCY_WARNINGS = new Set(['EVAL', 'MODULE_LEVEL_DIRECTIVE'])

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    rolldownOptions: {
      onLog(level, log, defaultHandler) {
        if (level === 'warn' && log.code && IGNORED_DEPENDENCY_WARNINGS.has(log.code) && /[\\/]node_modules[\\/]/.test(log.id ?? '')) {
          return
        }
        defaultHandler(level, log)
      },
      output: {
        // 体积大、很少变的第三方库单独成块：发新版时这些文件名不变，浏览器可以继续用缓存，每块也都在 500 kB 的警告线以内。
        // VChart 只在总览页加载，Markdown 解析器只在打开公告和更新日志时加载，date-fns 是 Semi 日期组件用的、跟表单一起加载。
        // 每组会连带收进匹配模块的依赖，匹配范围里不能有依赖 React 的包：React 一旦被收进这些块，入口就得同步加载它们，
        // 之前 react-vchart 被 vchart 组匹配到，入口连带加载整个图表块，页面直接白屏。改动分组后要在浏览器里打开页面确认。
        codeSplitting: {
          groups: [
            // VChart 连同渲染引擎压缩后约 1.2 MB，按包拆开，priority 大的先认领模块。
            // 不用 maxSize 切 vrender-core：切出来的几块互相引用，加载顺序不对会报错。
            { name: 'vutils', test: /[\\/]node_modules[\\/].*@visactor[\\/]vutils[\\/]/, priority: 4 },
            { name: 'vrender-core', test: /[\\/]node_modules[\\/].*@visactor[\\/]vrender-core[\\/]/, priority: 3 },
            { name: 'vrender', test: /[\\/]node_modules[\\/].*@visactor[\\/]vrender[^\\/]*[\\/]/, priority: 2 },
            // react-vchart 依赖 React，留在总览页自己的块里
            { name: 'vchart', test: /[\\/]node_modules[\\/].*@visactor[\\/](?!react-vchart[\\/])/, priority: 1 },
            { name: 'markdown-parser', test: /[\\/]node_modules[\\/].*[\\/](acorn|acorn-jsx|parse5|entities)[\\/]/ },
            { name: 'date-fns', test: /[\\/]node_modules[\\/].*[\\/]date-fns(-tz)?[\\/]/ },
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
