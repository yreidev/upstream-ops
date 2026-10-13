import { useMemo, useState } from "react"
import { Card, Select, Table, Tag, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { PageHeader } from "@/components/layout/page-header"
import { ChannelSelect } from "@/components/common/channel-select"
import type { MonitorJob, MonitorLog } from "@/lib/api-types"
import { channelTypeLabel, formatDurationMS, fullDateTime, relativeTime } from "@/lib/format"
import { monitorJobLabel } from "@/lib/labels"
import { useChannels, useMonitorLogs } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const LIMIT_OPTIONS = [100, 300, 1000]
type ResultFilter = "all" | "failed" | "ok"

export default function MonitorLogsPage() {
  const isMobile = useIsMobile()
  const [channelID, setChannelID] = useState<number | undefined>()
  const [limit, setLimit] = useState(100)
  const [job, setJob] = useState<MonitorJob | undefined>()
  const [result, setResult] = useState<ResultFilter>("all")
  const logs = useMonitorLogs(channelID, limit)
  const channels = useChannels()
  const channelMap = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c] as const)), [channels.data])

  // 接口只能按渠道筛、不分页；任务类型和结果在这里过滤。
  const rows = useMemo(
    () =>
      (logs.data ?? []).filter(
        (l) => (!job || l.job === job) && (result === "all" || (result === "ok") === l.success),
      ),
    [logs.data, job, result],
  )

  const columns: ColumnProps<MonitorLog>[] = [
    {
      title: "开始时间",
      dataIndex: "started_at",
      width: 130,
      render: (v: string) => (
        <Tooltip content={fullDateTime(v)}>
          <span>{relativeTime(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: "渠道",
      dataIndex: "channel_id",
      width: 200,
      render: (id: number, row: MonitorLog) => {
        // CCH 同步不属于某个渠道，channel_id 为 0
        if (id === 0 && row.job === "cch_sync") return "CCH"
        const ch = channelMap.get(id)
        return ch ? `${ch.name} · ${channelTypeLabel(ch.type)}` : `渠道 #${id}`
      },
    },
    { title: "任务", dataIndex: "job", width: 100, render: (v: MonitorJob) => monitorJobLabel[v] ?? v },
    {
      title: "结果",
      dataIndex: "success",
      width: 80,
      render: (ok: boolean) => <Tag color={ok ? "green" : "red"}>{ok ? "成功" : "失败"}</Tag>,
    },
    {
      title: "耗时",
      dataIndex: "duration_ms",
      width: 90,
      render: (v: number) => <span className="num">{formatDurationMS(v)}</span>,
    },
    {
      title: "错误",
      dataIndex: "error_message",
      render: (v?: string) =>
        v ? (
          <Typography.Text type="danger" size="small" ellipsis={{ rows: 2, showTooltip: { opts: { style: { maxWidth: 560 } } } }}>
            {v}
          </Typography.Text>
        ) : (
          <Typography.Text type="tertiary">—</Typography.Text>
        ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="监控日志"
        description="每次登录、校验会话、采集余额、消费和倍率，以及同步成本倍率到 CCH，都会记一条，按设置里的保留天数自动清理。"
        actions={
          <>
            <ChannelSelect value={channelID} onChange={setChannelID} />
            <Select
              placeholder="全部任务"
              showClear
              value={job}
              onChange={(v) => setJob((v as MonitorJob | undefined) ?? undefined)}
              style={{ width: 120 }}
              optionList={Object.entries(monitorJobLabel).map(([value, label]) => ({ value, label }))}
            />
            <Select
              value={result}
              onChange={(v) => setResult(v as ResultFilter)}
              style={{ width: 110 }}
              optionList={[
                { value: "all", label: "全部结果" },
                { value: "failed", label: "只看失败" },
                { value: "ok", label: "只看成功" },
              ]}
            />
            <Select
              value={limit}
              onChange={(v) => setLimit(Number(v))}
              style={{ width: 130 }}
              optionList={LIMIT_OPTIONS.map((n) => ({ value: n, label: `最近 ${n} 条` }))}
            />
          </>
        }
      />
      <Card bodyStyle={{ padding: 0 }}>
        <Table<MonitorLog>
          rowKey="id"
          size={isMobile ? "small" : "default"}
          columns={columns}
          dataSource={rows}
          loading={logs.loading || logs.stale}
          scroll={{ x: 860 }}
          empty="没有符合条件的监控日志"
          pagination={{ pageSize: 50, showTotal: !isMobile, size: isMobile ? "small" : "default" }}
        />
      </Card>
    </div>
  )
}
