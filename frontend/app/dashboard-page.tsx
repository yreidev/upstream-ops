import { lazy, Suspense, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { Card, Collapsible, Empty, Skeleton, Spin, Tag, Typography } from "@douyinfe/semi-ui"
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconCoinMoneyStroked,
  IconCreditCard,
  IconLineChartStroked,
  IconServer,
} from "@douyinfe/semi-icons"
import { PageHeader } from "@/components/layout/page-header"
import type { BalanceCostPoint } from "@/components/charts/balance-cost-chart"
import { NotificationBody } from "@/components/monitor/notification-body"
import { notificationEventLabel } from "@/lib/labels"
import { channelTypeLabel, formatRatio, money, ratioDelta, relativeTime } from "@/lib/format"
import { useBalanceTrend, useChannels, useCostTrend, useDashboardSummary, useNotificationLogs, useRateChanges } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const BalanceCostChart = lazy(() => import("@/components/charts/balance-cost-chart"))

const TREND_DAYS = 7
const PREVIEW_SIZE = 8

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

function KpiCard({ label, value, icon, color, footer, loading }: {
  label: string
  value: ReactNode
  icon: ReactNode
  color: string
  footer: ReactNode
  loading: boolean
}) {
  // 手机上两列卡片很窄，去掉图标、字号降一级，金额才放得下
  const isMobile = useIsMobile()
  return (
    <Card bodyStyle={{ padding: isMobile ? 12 : 16 }}>
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 4, minWidth: 0 }}>
          <Typography.Text type="tertiary" size="small">
            {label}
          </Typography.Text>
          <Skeleton loading={loading} placeholder={<Skeleton.Title style={{ width: 120, height: 28 }} />} active>
            {/* 金额很大时在卡片内换行，不压到右边的图标 */}
            <Typography.Title heading={isMobile ? 4 : 3} className="num" style={{ margin: 0, overflowWrap: "anywhere" }}>
              {value}
            </Typography.Title>
          </Skeleton>
          <Typography.Text type="tertiary" size="small" ellipsis={{ showTooltip: true }}>
            {footer}
          </Typography.Text>
        </div>
        {isMobile ? null : (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 40,
              height: 40,
              flexShrink: 0,
              borderRadius: 10,
              color: `var(--semi-color-${color})`,
              background: `var(--semi-color-${color}-light-default)`,
              fontSize: 20,
            }}
          >
            {icon}
          </span>
        )}
      </div>
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
        icon={<IconCoinMoneyStroked />}
        color="primary"
        loading={loading}
        footer={d?.lowest_balance ? `最低：${d.lowest_balance.name} ${money(d.lowest_balance.balance)}` : "—"}
      />
      <KpiCard
        label="今日总消费"
        value={money(d?.today_total_cost ?? 0)}
        icon={<IconCreditCard />}
        color="warning"
        loading={loading}
        footer={(d?.today_total_cost ?? 0) > 0 ? "按实际扣费统计" : "今日暂无消费"}
      />
      <KpiCard
        label="累计消费"
        value={money(d?.total_cost ?? 0)}
        icon={<IconCoinMoneyStroked />}
        color="primary"
        loading={loading}
        footer={(d?.total_cost ?? 0) > 0 ? "全渠道累计实际扣费" : "暂无累计消费"}
      />
      <KpiCard
        label="渠道状态"
        value={
          <>
            {d?.active_channels ?? 0}
            <Typography.Text type="tertiary" style={{ fontSize: 18, fontWeight: 400 }}>
              {" / "}
              {d?.total_channels ?? 0}
            </Typography.Text>
          </>
        }
        icon={<IconServer />}
        color="success"
        loading={loading}
        footer={failed > 0 ? `${d?.active_channels ?? 0} 健康 · ${failed} 失败` : `${d?.active_channels ?? 0} 健康`}
      />
      <KpiCard
        label="今日倍率变动"
        value={
          <span style={{ color: todayChanges > 0 ? "var(--semi-color-danger)" : undefined }}>{todayChanges}</span>
        }
        icon={<IconLineChartStroked />}
        color="danger"
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
    <Card
      title="余额与消费"
      headerExtraContent={<Typography.Text type="tertiary" size="small">最近 {TREND_DAYS} 天</Typography.Text>}
      bodyStyle={{ padding: isMobile ? 8 : 16 }}
    >
      <div style={{ height: 280 }}>
        {loading ? (
          <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center" }}>
            <Spin />
          </div>
        ) : data.length === 0 ? (
          <Empty description="暂无趋势采样，等待下次采集或到渠道页手动同步" style={{ paddingTop: 80 }} />
        ) : (
          <Suspense fallback={<Spin />}>
            <BalanceCostChart data={data} compact={isMobile} />
          </Suspense>
        )}
      </div>
      {channels.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--semi-color-border)",
            maxHeight: 96,
            overflowY: "auto",
          }}
        >
          {channels.map((c) => (
            <Tag
              key={c.id}
              color={c.last_error ? "red" : c.last_balance == null ? "grey" : "green"}
              type="light"
              size="large"
              className="num"
              // 子元素是纯字符串时 Tag 才会超长省略，手机上长渠道名不会撑出卡片
              style={{ maxWidth: "100%" }}
            >
              {`${c.name} · ${money(c.last_balance)} · 今日 ${money(c.today_cost)}`}
            </Tag>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

function SeeAll({ to }: { to: string }) {
  return (
    <Link to={to}>
      <Typography.Text link>查看全部</Typography.Text>
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
    <Card className="fill-card" title="最近倍率变动" headerExtraContent={<SeeAll to="/rates" />} bodyStyle={{ padding: 0 }}>
      {summary.loading && !summary.data ? (
        <div style={{ padding: 16 }}>
          <Skeleton placeholder={<Skeleton.Paragraph rows={6} />} loading active />
        </div>
      ) : items.length === 0 ? (
        <Empty description="暂无倍率变动记录" style={{ padding: 32 }} />
      ) : (
        <div className="list-rows fit-rows">
          {items.map((item) => {
            const ch = channelMap.get(item.channel_id)
            const delta = ratioDelta(item.old_ratio, item.new_ratio)
            const up = delta.direction === "up"
            return (
              <div key={item.id} className="row-between" style={{ padding: "10px 16px" }}>
                <div className="stack" style={{ gap: 2 }}>
                  <Typography.Text strong ellipsis={{ showTooltip: true }}>
                    {item.model_name}
                  </Typography.Text>
                  <Typography.Text type="tertiary" size="small" ellipsis={{ showTooltip: true }}>
                    {ch ? `${ch.name} · ${channelTypeLabel(ch.type)}` : `渠道 #${item.channel_id}`} · {relativeTime(item.changed_at)}
                  </Typography.Text>
                </div>
                <div className="stack" style={{ gap: 2, alignItems: "flex-end", flexShrink: 0 }}>
                  <Tag color={up ? "red" : "green"} prefixIcon={up ? <IconArrowUp /> : <IconArrowDown />}>
                    {delta.pct}
                  </Tag>
                  <Typography.Text type="tertiary" size="small" className="num">
                    {formatRatio(item.old_ratio)} → {formatRatio(item.new_ratio)}
                  </Typography.Text>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function RecentNotifications() {
  const logs = useNotificationLogs(1, PREVIEW_SIZE)
  const items = logs.data?.items ?? []
  // 点一行展开正文，同一时间只展开一条
  const [openId, setOpenId] = useState<number | null>(null)

  return (
    <Card title="最近通知" headerExtraContent={<SeeAll to="/notifications" />} bodyStyle={{ padding: 0 }}>
      {logs.loading && !logs.data ? (
        <div style={{ padding: 16 }}>
          <Skeleton placeholder={<Skeleton.Paragraph rows={4} />} loading active />
        </div>
      ) : items.length === 0 ? (
        <Empty description="暂无通知记录" style={{ padding: 32 }} />
      ) : (
        <div className="list-rows">
          {items.map((a) => {
            const ev = notificationEventLabel(a.event)
            const open = openId === a.id
            const toggle = () => setOpenId(open ? null : a.id)
            return (
              <div key={a.id}>
                <div
                  className="row-between clickable-row"
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      toggle()
                    }
                  }}
                  style={{ padding: "10px 16px" }}
                >
                  <div className="row" style={{ minWidth: 0 }}>
                    {open ? <IconChevronDown className="row-chevron" /> : <IconChevronRight className="row-chevron" />}
                    <Tag color={ev.color} style={{ flexShrink: 0 }}>
                      {ev.label}
                    </Tag>
                    <Typography.Text ellipsis={{ showTooltip: true }}>{a.subject}</Typography.Text>
                    {a.success ? null : (
                      <Tag color="red" type="ghost" style={{ flexShrink: 0 }}>
                        发送失败
                      </Tag>
                    )}
                  </div>
                  <Typography.Text type="tertiary" size="small" style={{ flexShrink: 0 }}>
                    {a.channel_name ?? `渠道 #${a.channel_id}`} · {relativeTime(a.sent_at)}
                  </Typography.Text>
                </div>
                <Collapsible isOpen={open} lazyRender>
                  <div style={{ padding: "0 16px 12px 40px" }}>
                    <NotificationBody log={a} />
                  </div>
                </Collapsible>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
