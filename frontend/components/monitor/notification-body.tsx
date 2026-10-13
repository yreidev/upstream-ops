import { lazy, Suspense } from "react"
import { Spin, Typography } from "@douyinfe/semi-ui"
import type { NotificationLog } from "@/lib/api-types"

const Markdown = lazy(() => import("@/components/common/markdown"))

/**
 * 一条发送记录的正文和失败原因，通知页的展开行和总览的“最近通知”共用。
 * 倍率变动的正文是 CommonMark（backend/notify/policy.go BuildRateNotificationBatchMessage），按 Markdown 显示；
 * 其余事件是按行拼的纯文本，原样换行显示。
 */
export function NotificationBody({ log }: { log: NotificationLog }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {log.event === "rate_changed" && log.body ? (
        <Suspense fallback={<Spin />}>
          <Markdown content={log.body} />
        </Suspense>
      ) : (
        <Typography.Paragraph className="pre-wrap" style={{ margin: 0 }}>
          {log.body || "—"}
        </Typography.Paragraph>
      )}
      {!log.success && log.error_message ? (
        <Typography.Paragraph type="danger" className="pre-wrap" style={{ margin: 0 }}>
          {log.error_message}
        </Typography.Paragraph>
      ) : null}
    </div>
  )
}
