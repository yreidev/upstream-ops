import type { Components } from "react-markdown"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import { Link } from "@heroui/react"

/**
 * Markdown 渲染：更新日志（GitHub Release）、上游公告和倍率变动通知的正文都用它。
 * 默认导出，调用方用 React.lazy 按需加载。
 *
 * 上游公告来自第三方站点，按不可信内容处理。公告里可能夹着 HTML，所以先用 rehype-raw 解析 HTML，
 * 再用 rehype-sanitize（GitHub 同款白名单）去掉 script、事件属性、style 和 javascript: 链接。
 */
const remarkPlugins = [remarkGfm]
const rehypePlugins = [rehypeRaw, rehypeSanitize]

const components: Components = {
  a({ href, children }) {
    return (
      <Link href={href} target="_blank" rel="noopener noreferrer" className="text-accent break-all">
        {children}
      </Link>
    )
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto">
        <table>{children}</table>
      </div>
    )
  },
}

export default function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
