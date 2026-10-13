import type { ComponentProps } from "react"
import { MarkdownRender, Typography } from "@douyinfe/semi-ui"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"

/**
 * Markdown 渲染：更新日志（GitHub Release）、上游公告和倍率变动通知的正文都用它。默认导出，调用方用 React.lazy 按需加载（MDX 编译器体积大）。
 *
 * 上游公告来自第三方站点，按不可信内容处理。公告里可能夹着 HTML，所以先用 rehype-raw 解析 HTML，
 * 再用 rehype-sanitize（GitHub 同款白名单）去掉 script、事件属性、style 和 javascript: 链接。
 * format="md" 按纯 Markdown 编译，不执行 MDX 里的表达式。
 */
const rehypePlugins = [rehypeRaw, rehypeSanitize]

type AnchorProps = ComponentProps<"a">

function Anchor({ href, children }: AnchorProps) {
  return (
    <Typography.Text link={{ href, target: "_blank", rel: "noopener noreferrer" }}>
      {children}
    </Typography.Text>
  )
}

// 弹窗里的标题不用太大：一、二级标题按 5 级，其余按 6 级显示。
const heading = (level: 5 | 6) =>
  function Heading({ children }: { children?: React.ReactNode }) {
    return (
      <Typography.Title heading={level} style={{ margin: "12px 0 6px" }}>
        {children}
      </Typography.Title>
    )
  }

// Semi 默认把 Markdown 表格渲染成数据表格并带分页器，公告里的小表格不需要分页。
const SemiMarkdownTable = MarkdownRender.defaultComponents.table

function MarkdownTable(props: ComponentProps<typeof SemiMarkdownTable>) {
  return <SemiMarkdownTable {...props} pagination={false} size="small" />
}

const components = {
  a: Anchor,
  table: MarkdownTable,
  h1: heading(5),
  h2: heading(5),
  h3: heading(6),
  h4: heading(6),
  h5: heading(6),
  h6: heading(6),
}

export default function Markdown({ content }: { content: string }) {
  return <MarkdownRender raw={content} format="md" components={components as any} rehypePlugins={rehypePlugins} />
}
