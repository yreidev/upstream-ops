import type { ReactNode } from "react"
import { Typography } from "@douyinfe/semi-ui"

/** 每页顶部的标题行：标题、一句说明，右侧放本页的主要操作。 */
export function PageHeader({ title, description, actions }: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="page-header">
      <div style={{ minWidth: 0 }}>
        <Typography.Title heading={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {description ? (
          <Typography.Text type="tertiary" size="small">
            {description}
          </Typography.Text>
        ) : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </div>
  )
}
