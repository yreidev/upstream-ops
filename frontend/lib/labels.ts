import type { ChipProps } from "@heroui/react"
import type {
  JobKind,
  JobSource,
  JobStatus,
  MonitorJob,
  NotificationEvent,
} from "@/lib/api-types"

export type ChipColor = NonNullable<ChipProps["color"]>

/** 通知事件的中文名和标签颜色。 */
export const notificationEventMeta: Record<NotificationEvent, { label: string; color: ChipColor }> = {
  balance_low: { label: "余额不足", color: "warning" },
  rate_changed: { label: "倍率变化", color: "accent" },
  rate_structure_changed: { label: "分组变动", color: "accent" },
  rate_added: { label: "新增分组", color: "accent" },
  rate_removed: { label: "移除分组", color: "warning" },
  announcement: { label: "上游公告", color: "default" },
  login_failed: { label: "登录失败", color: "danger" },
  captcha_failed: { label: "验证码失败", color: "danger" },
  monitor_failed: { label: "采集失败", color: "danger" },
  recovered: { label: "故障恢复", color: "success" },
}

export function notificationEventLabel(event: string) {
  return notificationEventMeta[event as NotificationEvent] ?? { label: event, color: "default" as ChipColor }
}

/** 监控日志的任务类型（backend/storage/model.go MonitorJob*）。 */
export const monitorJobLabel: Record<MonitorJob, string> = {
  login: "登录",
  session: "校验会话",
  balance: "余额",
  costs: "消费",
  rates: "倍率",
}

/** 后台任务类型（backend/storage/background_jobs.go Job*）。 */
export const jobKindLabel: Record<JobKind, string> = {
  channel_sync: "同步渠道",
  channel_test_login: "测试登录",
  channel_sync_all: "全部同步",
  balance_scan: "余额采集",
  rate_scan: "倍率采集",
  retention: "清理历史",
}

export const jobSourceLabel: Record<JobSource, string> = {
  manual: "手动",
  scheduled: "定时",
}

export const jobStatusMeta: Record<JobStatus, { label: string; color: ChipColor }> = {
  running: { label: "运行中", color: "accent" },
  succeeded: { label: "成功", color: "success" },
  failed: { label: "失败", color: "danger" },
  interrupted: { label: "被中断", color: "warning" },
}

/** 上游密钥的状态（connector APIKey.Status）。 */
export const apiKeyStatusMeta: Record<string, { label: string; color: ChipColor }> = {
  active: { label: "启用", color: "success" },
  disabled: { label: "停用", color: "default" },
  expired: { label: "已过期", color: "warning" },
  quota_exhausted: { label: "额度耗尽", color: "warning" },
}
