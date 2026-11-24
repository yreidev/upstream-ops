import { lazy, Suspense, useMemo, type ReactNode } from "react"
import { Link } from "react-router-dom"
import {
  Accordion,
  Card,
  Chip,
  EmptyState,
  ScrollShadow,
  Separator,
  Skeleton,
  Spinner,
} from "@heroui/react"
import {
  ArrowDown,
  ArrowUp,
  ChartLine,
  CreditCard,
  Layers,
  Server,
} from "@gravity-ui/icons"
import { PageHeader } from "@/components/layout/page-header"
import type { BalanceCostPoint } from "@/components/charts/balance-cost-chart"
import { NotificationBody } from "@/components/monitor/notification-body"
import { notificationEventLabel } from "@/lib/labels"
import { channelTypeLabel, formatRatio, money, ratioDelta, relativeTime } from "@/lib/format"
import {
  useBalanceTrend,
  useChannels,
  useCostTrend,
  useDashboardSummary,
  useNotificationLogs,
  useRateChanges,
} from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const BalanceCostChart = lazy(() => import("@/components/charts/balance-cost-chart"))

const TREND_DAYS = 7
const PREVIEW_SIZE = 8

type KpiTone = "accent" | "warning" | "success" | "danger"

const toneClass: Record<KpiTone, string> = {
  accent: "bg-accent/10 text-accent",
  warning: "bg-warning/15 text-warning",
  success: "bg-success/12 text-success",
  danger: "bg-danger/10 text-danger",
}

export default function DashboardPage() {
  return (
    <div className="page">
      <PageHeader title="总览" description="全部渠道的余额、消费和最近的变化。" />
      <KpiCards />
      <div className="grid-2">
        <TrendCard />
        <RecentRateChanges />
      </div>
      <RecentNotifications />
    </div>
  )
}

function KpiCard({
  label,
  value,
  icon,
  tone,
  footer,
  loading,
}: {
  label: string
  value: ReactNode
  icon: ReactNode
  tone: KpiTone
  footer: ReactNode
  loading: boolean
}) {
  // 手机上两列卡片很窄，去掉图标、字号降一级，金额才放得下
  const isMobile = useIsMobile()
  return (
    <Card className={`rounded-2xl ${isMobile ? "gap-1.5 p-3" : "gap-1.5 p-4"}`}>
      <Card.Header className="flex-row items-center justify-between gap-2">
        <Card.Title className="text-xs leading-tight font-medium text-muted">{label}</Card.Title>
        {!isMobile ? (
          <span
            className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg ${toneClass[tone]}`}
          >
            {icon}
          </span>
        ) : null}
      </Card.Header>
      <Card.Content className="gap-1">
        {loading ? (
          <Skeleton className="h-7 w-28 rounded-lg" />
        ) : (
          <div
            className={`num font-semibold tracking-tight text-foreground ${
              isMobile ? "text-lg" : "text-2xl"
            }`}
            style={{ overflowWrap: "anywhere" }}
          >
            {value}
          </div>
        )}
        <span className="truncate text-xs text-muted" title={typeof footer === "string" ? footer : undefined}>
          {footer}
        </span>
      </Card.Content>
    </Card>
  )
}

function countToday(changes: { changed_at: string }[]) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return changes.filter((c) => new Date(c.changed_at) >= start).length
}

function KpiCards() {
  const summary = useDashboardSummary()
  const recentChanges = useRateChanges(1, 100)
  const d = summary.data
  const loading = summary.loading && !d
  const todayChanges = countToday(recentChanges.data?.items ?? [])
  const failed = d?.failed_channels ?? 0

  return (
    <div className="grid-auto">
      <KpiCard
        label="总余额"
        value={money(d?.total_balance ?? 0)}
        icon={<Layers className="size-4" />}
        tone="accent"
        loading={loading}
        footer={d?.lowest_balance ? `最低：${d.lowest_balance.name} ${money(d.lowest_balance.balance)}` : "—"}
      />
      <KpiCard
        label="今日总消费"
        value={money(d?.today_total_cost ?? 0)}
        icon={<CreditCard className="size-4" />}
        tone="warning"
        loading={loading}
        footer={(d?.today_total_cost ?? 0) > 0 ? "按实际扣费统计" : "今日暂无消费"}
      />
      <KpiCard
        label="累计消费"
        value={money(d?.total_cost ?? 0)}
        icon={<CreditCard className="size-4" />}
        tone="accent"
        loading={loading}
        footer={(d?.total_cost ?? 0) > 0 ? "全渠道累计实际扣费" : "暂无累计消费"}
      />
      <KpiCard
        label="渠道状态"
        value={
          <>
            {d?.active_channels ?? 0}
            <span className="text-base font-normal text-muted">
              {" / "}
              {d?.total_channels ?? 0}
            </span>
          </>
        }
        icon={<Server className="size-4" />}
        tone="success"
        loading={loading}
        footer={failed > 0 ? `${d?.active_channels ?? 0} 健康 · ${failed} 失败` : `${d?.active_channels ?? 0} 健康`}
      />
      <KpiCard
        label="今日倍率变动"
        value={<span className={todayChanges > 0 ? "text-danger" : undefined}>{todayChanges}</span>}
        icon={<ChartLine className="size-4" />}
        tone="danger"
        loading={loading}
        footer={todayChanges > 0 ? `检测到 ${todayChanges} 次变动` : "今日无变动"}
      />
    </div>
  )
}

function formatDay(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function TrendCard() {
  const isMobile = useIsMobile()
  const trend = useBalanceTrend(TREND_DAYS)
  const costTrend = useCostTrend(TREND_DAYS)
  const summary = useDashboardSummary()
  const channels = summary.data?.channels ?? []

  // 按日期合并余额和消费两条序列；某天只有一边有数据时另一边留空。
  const data = useMemo(() => {
    const byDay = new Map<string, { balance: number | null; cost: number | null }>()
    for (const p of trend.data ?? []) byDay.set(p.day, { balance: p.balance, cost: byDay.get(p.day)?.cost ?? null })
    for (const p of costTrend.data ?? []) byDay.set(p.day, { balance: byDay.get(p.day)?.balance ?? null, cost: p.cost })
    return Array.from(byDay.entries())
      .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
      .map(([day, v]): BalanceCostPoint => ({ day: formatDay(day), ...v }))
  }, [trend.data, costTrend.data])

  const loading = (trend.loading && !trend.data) || (costTrend.loading && !costTrend.data)

  return (
    <Card className="rounded-2xl p-4">
      <Card.Header className="flex-row items-center justify-between gap-2">
        <Card.Title className="text-base font-semibold">余额与消费</Card.Title>
        <Chip size="sm" variant="soft">
          最近 {TREND_DAYS} 天
        </Chip>
      </Card.Header>
      <Card.Content className="gap-3">
        <div className="h-[280px]">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : data.length === 0 ? (
            <EmptyState className="flex h-full items-center justify-center text-sm text-muted">
              暂无趋势采样，等待下次采集或到渠道页手动同步
            </EmptyState>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              <BalanceCostChart data={data} compact={isMobile} />
            </Suspense>
          )}
        </div>
        {channels.length > 0 ? (
          <>
            <Separator />
            <ScrollShadow className="max-h-24" size={20}>
              <div className="flex flex-wrap gap-1.5 py-0.5">
                {channels.map((c) => (
                  <Chip
                    key={c.id}
                    color={c.last_error ? "danger" : c.last_balance == null ? "default" : "success"}
                    variant="soft"
                    size="sm"
                    className="num max-w-full"
                  >
                    <Chip.Label className="truncate">
                      {`${c.name} · ${money(c.last_balance)} · 今日 ${money(c.today_cost)}`}
                    </Chip.Label>
                  </Chip>
                ))}
              </div>
            </ScrollShadow>
          </>
        ) : null}
      </Card.Content>
    </Card>
  )
}

function SeeAll({ to }: { to: string }) {
  return (
    <Link to={to} className="link text-xs font-medium text-accent">
      查看全部
    </Link>
  )
}

function RecentRateChanges() {
  const summary = useDashboardSummary()
  const channels = useChannels()
  const channelMap = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c] as const)), [channels.data])
  const items = (summary.data?.recent_rate_changes ?? []).slice(0, PREVIEW_SIZE)

  // 高度跟左边的走势卡片对齐，放不下的几条不显示，点“查看全部”看
  return (
    <Card className="fill-card rounded-2xl p-4">
      <Card.Header className="shrink-0 flex-row items-center justify-between gap-2">
        <Card.Title className="text-base font-semibold">最近倍率变动</Card.Title>
        <SeeAll to="/rates" />
      </Card.Header>
      <Separator />
      <Card.Content className="fill-card-body -mx-4 -mb-4">
        {summary.loading && !summary.data ? (
          <div className="stack gap-3 p-4">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState className="py-10 text-sm text-muted">暂无倍率变动记录</EmptyState>
        ) : (
          <div className="list-rows fit-rows">
            {items.map((item) => {
              const ch = channelMap.get(item.channel_id)
              const delta = ratioDelta(item.old_ratio, item.new_ratio)
              const up = delta.direction === "up"
              const subtitle = `${ch ? `${ch.name} · ${channelTypeLabel(ch.type)}` : `渠道 #${item.channel_id}`} · ${relativeTime(item.changed_at)}`
              return (
                <div key={item.id} className="row-between px-4 py-2.5">
                  <div className="stack min-w-0 gap-0.5">
                    <span className="truncate text-sm font-medium text-foreground" title={item.model_name}>
                      {item.model_name}
                    </span>
                    <span className="truncate text-xs text-muted" title={subtitle}>
                      {subtitle}
                    </span>
                  </div>
                  <div className="stack shrink-0 items-end gap-0.5">
                    <Chip color={up ? "danger" : "success"} variant="soft" size="sm" className="num">
                      {up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
                      <Chip.Label>{delta.pct}</Chip.Label>
                    </Chip>
                    <span className="num text-xs text-muted">
                      {formatRatio(item.old_ratio)} → {formatRatio(item.new_ratio)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card.Content>
    </Card>
  )
}

function RecentNotifications() {
  const logs = useNotificationLogs(1, PREVIEW_SIZE)
  const items = logs.data?.items ?? []

  return (
    <Card className="rounded-2xl p-4">
      <Card.Header className="flex-row items-center justify-between gap-2">
        <Card.Title className="text-base font-semibold">最近通知</Card.Title>
        <SeeAll to="/notifications" />
      </Card.Header>
      <Card.Content>
        {logs.loading && !logs.data ? (
          <div className="stack gap-2.5 pt-1">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState className="py-8 text-sm text-muted">暂无通知记录</EmptyState>
        ) : (
          <Accordion className="w-full">
            {items.map((a) => {
              const ev = notificationEventLabel(a.event)
              return (
                <Accordion.Item key={a.id} id={String(a.id)}>
                  <Accordion.Heading>
                    <Accordion.Trigger className="px-1 py-2.5">
                      <div className="row-between min-w-0 flex-1 gap-3 pr-2">
                        <div className="row min-w-0">
                          <Chip color={ev.color} variant="soft" size="sm" className="shrink-0">
                            {ev.label}
                          </Chip>
                          <span className="truncate text-sm font-normal text-foreground" title={a.subject}>
                            {a.subject}
                          </span>
                          {!a.success ? (
                            <Chip color="danger" variant="tertiary" size="sm" className="shrink-0">
                              发送失败
                            </Chip>
                          ) : null}
                        </div>
                        <span className="shrink-0 text-xs font-normal text-muted">
                          {a.channel_name ?? `渠道 #${a.channel_id}`} · {relativeTime(a.sent_at)}
                        </span>
                      </div>
                      <Accordion.Indicator />
                    </Accordion.Trigger>
                  </Accordion.Heading>
                  <Accordion.Panel>
                    <Accordion.Body className="px-2 pb-3 pt-1">
                      <NotificationBody log={a} />
                    </Accordion.Body>
                  </Accordion.Panel>
                </Accordion.Item>
              )
            })}
          </Accordion>
        )}
      </Card.Content>
    </Card>
  )
}
