import type { TagColor } from "@douyinfe/semi-ui/lib/es/tag"
import type { MonitorJob, NotificationEvent } from "@/lib/api-types"

/** 通知事件的中文名和标签颜色。 */
export const notificationEventMeta: Record<NotificationEvent, { label: string; color: TagColor }> = {
  balance_low: { label: "余额不足", color: "orange" },
  rate_changed: { label: "倍率变化", color: "blue" },
  rate_structure_changed: { label: "分组变动", color: "light-blue" },
  rate_added: { label: "新增分组", color: "light-blue" },
  rate_removed: { label: "移除分组", color: "light-blue" },
  announcement: { label: "上游公告", color: "violet" },
  login_failed: { label: "登录失败", color: "red" },
  captcha_failed: { label: "验证码失败", color: "red" },
  monitor_failed: { label: "采集失败", color: "red" },
  recovered: { label: "故障恢复", color: "green" },
  cch_sync: { label: "CCH 倍率同步", color: "cyan" },
}

export function notificationEventLabel(event: string) {
  return notificationEventMeta[event as NotificationEvent] ?? { label: event, color: "grey" as TagColor }
}

/** 监控日志的任务类型（backend/storage/model.go MonitorJob*）。 */
export const monitorJobLabel: Record<MonitorJob, string> = {
  login: "登录",
  session: "校验会话",
  balance: "余额",
  costs: "消费",
  rates: "倍率",
  cch_sync: "CCH 同步",
}
