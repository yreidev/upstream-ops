import type { ReactNode } from "react"

/** 每页顶部的标题行：标题、一句说明，右侧放本页的主要操作。 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="page-header">
      <div className="min-w-0">
        <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="mt-0.5 mb-0 text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  )
}
