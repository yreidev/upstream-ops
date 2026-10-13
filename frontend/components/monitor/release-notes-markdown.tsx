import Markdown, { type Components } from "react-markdown"

// 发布说明来自 GitHub Release，按 Markdown 渲染；react-markdown 默认不渲染原始 HTML，
// 也会过滤 javascript: 之类的链接。单独成文件，由更新日志弹窗按需加载。
const components: Components = {
  h1: ({ children }) => <h4 className="pt-1 text-sm font-semibold text-foreground">{children}</h4>,
  h2: ({ children }) => <h4 className="pt-1 text-sm font-semibold text-foreground">{children}</h4>,
  h3: ({ children }) => <h4 className="pt-1 text-sm font-semibold text-foreground">{children}</h4>,
  h4: ({ children }) => <h5 className="pt-1 text-sm font-medium text-foreground">{children}</h5>,
  p: ({ children }) => <p className="leading-6">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 leading-6">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 leading-6">{children}</ol>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand underline-offset-2 hover:underline">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
}

export default function ReleaseNotesMarkdown({ children }: { children: string }) {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <Markdown components={components}>{children}</Markdown>
    </div>
  )
}
