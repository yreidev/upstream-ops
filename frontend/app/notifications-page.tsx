import { useMemo, useState } from "react"
import { Button, Card, Table, Tag, Toast, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { IconDelete, IconEdit, IconPlus, IconSend } from "@douyinfe/semi-icons"
import { PageHeader } from "@/components/layout/page-header"
import { NotificationBody } from "@/components/monitor/notification-body"
import { NotificationFormModal } from "@/components/monitor/notification-form-modal"
import { apiFetch } from "@/lib/api"
import type { NotificationChannel, NotificationLog } from "@/lib/api-types"
import { confirm } from "@/lib/confirm"
import { fullDateTime, relativeTime } from "@/lib/format"
import { notificationEventLabel } from "@/lib/labels"
import { useChannels, useNotificationChannels, useNotificationLogs } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { useIsMobile } from "@/hooks/use-mobile"

const PAGE_SIZE = 20

const notifyTypeLabel: Record<string, string> = {
  telegram: "Telegram",
  wecom: "企业微信",
}

function parseSubCount(raw?: string): number {
  if (!raw) return 0
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return 0
  }
}

export default function NotificationsPage() {
  return (
    <div className="page">
      <PageHeader title="通知" description="Telegram / 企业微信。每个通知渠道可以单独订阅指定渠道、事件和分组。" />
      <NotificationChannelsCard />
      <NotificationLogsCard />
    </div>
  )
}

function NotificationChannelsCard() {
  const isMobile = useIsMobile()
  const { data, loading } = useNotificationChannels()
  const refresh = useTriggerRefresh()
  const [editing, setEditing] = useState<NotificationChannel | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)

  function openForm(c: NotificationChannel | null) {
    setEditing(c)
    setFormOpen(true)
  }

  async function handleTest(c: NotificationChannel) {
    setBusy(c.id)
    try {
      const res = await apiFetch<{ ok: boolean; error?: string }>(`/notifications/channels/${c.id}/test`, { method: "POST" })
      if (res.ok) Toast.success(`已发送测试消息到 ${c.name}`)
      else Toast.error(`测试失败：${res.error ?? "未知错误"}`)
      refresh()
    } catch (e) {
      Toast.error((e as Error).message || "测试失败")
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(c: NotificationChannel) {
    const ok = await confirm({
      title: `删除通知渠道 ${c.name}？`,
      description: "删除后不再向这个渠道推送，历史发送记录会保留。",
      confirmLabel: "删除",
      destructive: true,
    })
    if (!ok) return
    setBusy(c.id)
    try {
      await apiFetch(`/notifications/channels/${c.id}`, { method: "DELETE" })
      Toast.success(`已删除 ${c.name}`)
      refresh()
    } catch (e) {
      Toast.error((e as Error).message || "删除失败")
    } finally {
      setBusy(null)
    }
  }

  const columns: ColumnProps<NotificationChannel>[] = [
    { title: "名称", dataIndex: "name", render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    { title: "类型", dataIndex: "type", width: 120, render: (v: string) => notifyTypeLabel[v] ?? v },
    {
      title: "订阅",
      dataIndex: "subscriptions",
      width: 140,
      render: (v?: string) => {
        const n = parseSubCount(v)
        return n === 0 ? <Typography.Text type="tertiary">全部事件</Typography.Text> : `${n} 条规则`
      },
    },
    {
      title: "状态",
      dataIndex: "enabled",
      width: 90,
      render: (v: boolean) => <Tag color={v ? "green" : "grey"}>{v ? "已启用" : "已禁用"}</Tag>,
    },
    {
      title: "操作",
      key: "actions",
      width: 140,
      fixed: isMobile ? undefined : "right",
      render: (_: unknown, c: NotificationChannel) => (
        <div className="row" style={{ gap: 4 }}>
          <Tooltip content="发送测试消息">
            <Button
              aria-label="发送测试消息"
              theme="borderless"
              size="small"
              icon={<IconSend />}
              loading={busy === c.id}
              disabled={busy === c.id}
              onClick={() => handleTest(c)}
            />
          </Tooltip>
          <Tooltip content="编辑">
            <Button theme="borderless" size="small" icon={<IconEdit />} onClick={() => openForm(c)} aria-label="编辑" />
          </Tooltip>
          <Tooltip content="删除">
            <Button
              aria-label="删除"
              theme="borderless"
              type="danger"
              size="small"
              icon={<IconDelete />}
              disabled={busy === c.id}
              onClick={() => handleDelete(c)}
            />
          </Tooltip>
        </div>
      ),
    },
  ]

  return (
    <Card
      title="通知渠道"
      headerExtraContent={
        <Button theme="solid" size="small" icon={<IconPlus />} onClick={() => openForm(null)}>
          新增
        </Button>
      }
      bodyStyle={{ padding: 0 }}
    >
      <Table<NotificationChannel>
        rowKey="id"
        size={isMobile ? "small" : "default"}
        columns={columns}
        dataSource={data ?? []}
        loading={loading && !data}
        scroll={{ x: 650 }}
        pagination={false}
        empty="还没有通知渠道"
      />
      <NotificationFormModal visible={formOpen} onClose={() => setFormOpen(false)} channel={editing} />
    </Card>
  )
}

function NotificationLogsCard() {
  const isMobile = useIsMobile()
  const [page, setPage] = useState(1)
  const logs = useNotificationLogs(page, PAGE_SIZE)
  const channels = useChannels()
  const channelMap = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c.name] as const)), [channels.data])

  const columns: ColumnProps<NotificationLog>[] = [
    {
      title: "时间",
      dataIndex: "sent_at",
      width: 130,
      render: (v: string) => (
        <Tooltip content={fullDateTime(v)}>
          <span>{relativeTime(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: "事件",
      dataIndex: "event",
      width: 110,
      render: (v: string) => {
        const meta = notificationEventLabel(v)
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: "标题",
      dataIndex: "subject",
      render: (v: string) => <Typography.Text ellipsis={{ showTooltip: true }}>{v}</Typography.Text>,
    },
    {
      title: "上游渠道",
      dataIndex: "upstream_channel_id",
      width: 160,
      render: (id?: number) =>
        id ? channelMap.get(id) ?? `渠道 #${id}` : <Typography.Text type="tertiary">—</Typography.Text>,
    },
    {
      title: "发往",
      dataIndex: "channel_name",
      width: 150,
      render: (v: string | undefined, l: NotificationLog) => v || `通知渠道 #${l.channel_id}`,
    },
    {
      title: "结果",
      dataIndex: "success",
      width: 90,
      render: (v: boolean) => <Tag color={v ? "green" : "red"}>{v ? "已送达" : "失败"}</Tag>,
    },
  ]

  return (
    <Card title="发送记录" bodyStyle={{ padding: 0 }}>
      <Table<NotificationLog>
        rowKey="id"
        size={isMobile ? "small" : "default"}
        columns={columns}
        dataSource={logs.data?.items ?? []}
        loading={logs.loading && !logs.data}
        scroll={{ x: 760 }}
        empty="还没有发送记录"
        expandedRowRender={(l?: NotificationLog) => (l ? <NotificationBody log={l} /> : null)}
        pagination={{
          currentPage: page,
          pageSize: PAGE_SIZE,
          total: logs.data?.total ?? 0,
          onPageChange: setPage,
          // 手机上用紧凑分页，放不下“显示第几条”
          showTotal: !isMobile,
          size: isMobile ? "small" : "default",
        }}
      />
    </Card>
  )
}
