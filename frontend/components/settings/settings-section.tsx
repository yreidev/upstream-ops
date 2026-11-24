import type { ReactNode } from "react"
import { Card, Separator } from "@heroui/react"
import { useIsMobile } from "@/hooks/use-mobile"

/** 设置页的一块配置：标题、说明、右上角附加内容，字段两列排；footer 放在字段下面、占满整行。 */
export function SettingsSection({
  title,
  description,
  extra,
  footer,
  children,
}: {
  title: string
  description: string
  extra?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const isMobile = useIsMobile()
  // 手机上右侧放不下，附加内容挪到说明下面，不然标题会被挤成一字一行
  return (
    <Card className="rounded-2xl p-5">
      <Card.Header className="flex-row items-start justify-between gap-3">
        <div className="stack min-w-0 gap-1">
          <Card.Title className="text-sm font-semibold">{title}</Card.Title>
          <Card.Description className="text-xs">{description}</Card.Description>
          {isMobile && extra ? <div className="mt-2">{extra}</div> : null}
        </div>
        {!isMobile && extra ? <div className="shrink-0">{extra}</div> : null}
      </Card.Header>
      <Separator className="my-4" />
      <Card.Content>
        <div className="form-grid">{children}</div>
        {footer}
      </Card.Content>
    </Card>
  )
}
