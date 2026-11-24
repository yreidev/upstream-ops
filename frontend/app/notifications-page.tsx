import { useMemo, useState } from "react"
import { Accordion, Button, Chip, EmptyState, Spinner, Surface, Table, Tooltip, toast } from "@heroui/react"
import { PaperPlane, Pencil, Plus, TrashBin } from "@gravity-ui/icons"
import { PageHeader } from "@/components/layout/page-header"
import { PaginationBar } from "@/components/common/pagination-bar"
import { NotificationBody } from "@/components/monitor/notification-body"
import { NotificationFormModal } from "@/components/monitor/notification-form-modal"
import { apiFetch } from "@/lib/api"
import type { NotificationChannel } from "@/lib/api-types"
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
      <NotificationChannelsSection />
      <NotificationLogsSection />
    </div>
  )
}

function NotificationChannelsSection() {
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
      const res = await apiFetch<{ ok: boolean; error?: string }>(`/notifications/channels/${c.id}/test`, {
        method: "POST",
      })
      if (res.ok) toast.success(`已发送测试消息到 ${c.name}`)
      else toast.danger(`测试失败：${res.error ?? "未知错误"}`)
      refresh()
    } catch (e) {
      toast.danger((e as Error).message || "测试失败")
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
      toast.success(`已删除 ${c.name}`)
      refresh()
    } catch (e) {
      toast.danger((e as Error).message || "删除失败")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="stack gap-2.5">
      <div className="row-between">
        <div className="row gap-2">
          <h2 className="m-0 text-sm font-semibold text-foreground">通知渠道</h2>
          {data ? (
            <Chip size="sm" variant="soft" className="num">
              {data.length}
            </Chip>
          ) : null}
        </div>
        <Button variant="primary" size="sm" onPress={() => openForm(null)}>
          <Plus className="size-4" />
          新增
        </Button>
      </div>

      {loading && !data ? (
        <Surface className="flex justify-center rounded-[20px] py-12">
          <Spinner />
        </Surface>
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="通知渠道列表" className="min-w-[600px]">
              <Table.Header>
                <Table.Column isRowHeader>名称</Table.Column>
                <Table.Column className="w-32">类型</Table.Column>
                <Table.Column className="w-36">订阅</Table.Column>
                <Table.Column className="w-24">状态</Table.Column>
                <Table.Column className="w-36">操作</Table.Column>
              </Table.Header>
              <Table.Body
                items={data ?? []}
                renderEmptyState={() => <EmptyState className="py-10 text-sm text-muted">还没有通知渠道</EmptyState>}
              >
                {(c) => {
                  const n = parseSubCount(c.subscriptions)
                  return (
                    <Table.Row key={c.id} id={c.id}>
                      <Table.Cell>
                        <span className="font-semibold text-foreground">{c.name}</span>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="text-sm text-foreground">{notifyTypeLabel[c.type] ?? c.type}</span>
                      </Table.Cell>
                      <Table.Cell>
                        {n === 0 ? (
                          <span className="text-xs text-muted">全部事件</span>
                        ) : (
                          <span className="text-xs text-foreground">{n} 条规则</span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Chip color={c.enabled ? "success" : "default"} variant="soft" size="sm">
                          {c.enabled ? "已启用" : "已禁用"}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="row gap-0.5">
                          <Tooltip>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label="发送测试消息"
                              isPending={busy === c.id}
                              isDisabled={busy === c.id}
                              onPress={() => void handleTest(c)}
                            >
                              {busy === c.id ? <Spinner size="sm" color="current" /> : <PaperPlane className="size-4" />}
                            </Button>
                            <Tooltip.Content>发送测试消息</Tooltip.Content>
                          </Tooltip>
                          <Tooltip>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label="编辑"
                              onPress={() => openForm(c)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Tooltip.Content>编辑</Tooltip.Content>
                          </Tooltip>
                          <Tooltip>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label="删除"
                              className="text-danger"
                              isDisabled={busy === c.id}
                              onPress={() => void handleDelete(c)}
                            >
                              <TrashBin className="size-4" />
                            </Button>
                            <Tooltip.Content>删除</Tooltip.Content>
                          </Tooltip>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  )
                }}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
      <NotificationFormModal visible={formOpen} onClose={() => setFormOpen(false)} channel={editing} />
    </section>
  )
}

const LOGS_GRID = "grid grid-cols-[86px_84px_minmax(140px,1.5fr)_116px_110px_68px] items-center gap-2"

function NotificationLogsSection() {
  const isMobile = useIsMobile()
  const [page, setPage] = useState(1)
  const logs = useNotificationLogs(page, PAGE_SIZE)
  const channels = useChannels()
  const channelMap = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c.name] as const)), [channels.data])
  const items = logs.data?.items ?? []
  const total = logs.data?.total ?? 0

  return (
    <section className="stack gap-2.5">
      <div className="row gap-2">
        <h2 className="m-0 text-sm font-semibold text-foreground">发送记录</h2>
        {logs.data ? (
          <Chip size="sm" variant="soft" className="num">
            {total}
          </Chip>
        ) : null}
      </div>

      {logs.loading && !logs.data ? (
        <Surface className="flex justify-center rounded-[20px] py-12">
          <Spinner />
        </Surface>
      ) : (
        <div className={`expandable-table transition-opacity ${logs.stale ? "opacity-60" : "opacity-100"}`}>
          <div className="expandable-table__scroll">
            <div className="min-w-[720px]">
              <div className="expandable-table__header flex items-center gap-2">
                <span className="w-4 shrink-0" />
                <div className={`${LOGS_GRID} flex-1`}>
                  <span>时间</span>
                  <span>事件</span>
                  <span>标题</span>
                  <span>上游渠道</span>
                  <span>发往</span>
                  <span>结果</span>
                </div>
              </div>
              <div className="expandable-table__body">
                {items.length === 0 ? (
                  <EmptyState className="py-12 text-sm text-muted">还没有发送记录</EmptyState>
                ) : (
                  <Accordion allowsMultipleExpanded className="w-full">
                    {items.map((l) => {
                      const meta = notificationEventLabel(l.event)
                      return (
                        <Accordion.Item key={l.id} id={String(l.id)}>
                          <Accordion.Heading>
                            <Accordion.Trigger className="gap-2 px-3.5 py-2.5 font-normal">
                              <Accordion.Indicator className="ms-0 shrink-0" />
                              <div className={`${LOGS_GRID} min-w-0 flex-1`}>
                                <span className="truncate text-xs text-muted" title={fullDateTime(l.sent_at)}>
                                  {relativeTime(l.sent_at)}
                                </span>
                                <div>
                                  <Chip color={meta.color} variant="soft" size="sm">
                                    {meta.label}
                                  </Chip>
                                </div>
                                <span className="truncate text-sm text-foreground" title={l.subject}>
                                  {l.subject}
                                </span>
                                <span className="truncate text-xs text-muted">
                                  {l.upstream_channel_id
                                    ? (channelMap.get(l.upstream_channel_id) ?? `渠道 #${l.upstream_channel_id}`)
                                    : "—"}
                                </span>
                                <span className="truncate text-xs text-foreground">
                                  {l.channel_name || `通知渠道 #${l.channel_id}`}
                                </span>
                                <div>
                                  <Chip color={l.success ? "success" : "danger"} variant="soft" size="sm">
                                    {l.success ? "已送达" : "失败"}
                                  </Chip>
                                </div>
                              </div>
                            </Accordion.Trigger>
                          </Accordion.Heading>
                          <Accordion.Panel>
                            <Accordion.Body className="border-t border-separator/70 bg-surface-secondary/45 px-4 py-3 pl-10 text-foreground">
                              <NotificationBody log={l} />
                            </Accordion.Body>
                          </Accordion.Panel>
                        </Accordion.Item>
                      )
                    })}
                  </Accordion>
                )}
              </div>
            </div>
          </div>
          {total > PAGE_SIZE ? (
            <div className="expandable-table__footer">
              <PaginationBar
                page={page}
                total={total}
                pageSize={PAGE_SIZE}
                onChange={setPage}
                compact={isMobile}
              />
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
