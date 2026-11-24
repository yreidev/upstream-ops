import { lazy, Suspense } from "react"
import { Spinner } from "@heroui/react"
import type { NotificationLog } from "@/lib/api-types"

const Markdown = lazy(() => import("@/components/common/markdown"))

/**
 * 一条发送记录的正文和失败原因，通知页的展开行和总览的“最近通知”共用。
 * 倍率变动的正文是 CommonMark（backend/notify/policy.go BuildRateNotificationBatchMessage），按 Markdown 显示；
 * 其余事件是按行拼的纯文本，原样换行显示。
 */
export function NotificationBody({ log }: { log: NotificationLog }) {
  return (
    <div className="stack gap-2">
      {log.event === "rate_changed" && log.body ? (
        <Suspense fallback={<Spinner size="sm" />}>
          <Markdown content={log.body} />
        </Suspense>
      ) : (
        <p className="pre-wrap m-0 text-sm text-foreground">{log.body || "—"}</p>
      )}
      {!log.success && log.error_message ? (
        <p className="pre-wrap m-0 text-sm text-danger">{log.error_message}</p>
      ) : null}
    </div>
  )
}
