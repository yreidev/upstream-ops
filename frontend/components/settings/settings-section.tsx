import type { ReactNode } from "react"
import { Card, Typography } from "@douyinfe/semi-ui"
import { useIsMobile } from "@/hooks/use-mobile"

/** 设置页的一块配置：标题、说明、右上角附加内容，字段两列排；footer 放在字段下面、占满整行。 */
export function SettingsSection({ title, description, extra, footer, children }: {
  title: string
  description: string
  extra?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const isMobile = useIsMobile()
  // 手机上右侧放不下，附加内容挪到说明下面，不然标题会被挤成一字一行
  return (
    <Card
      title={
        <div className="stack" style={{ gap: 2 }}>
          <Typography.Text strong>{title}</Typography.Text>
          <Typography.Text type="tertiary" size="small">
            {description}
          </Typography.Text>
          {isMobile && extra ? <div style={{ marginTop: 6 }}>{extra}</div> : null}
        </div>
      }
      headerExtraContent={isMobile ? undefined : extra}
    >
      <div className="form-grid">{children}</div>
      {footer}
    </Card>
  )
}
