import { useMemo, useState } from "react"
import { Card, Table, Tag, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { IconArrowDown, IconArrowUp } from "@douyinfe/semi-icons"
import { PageHeader } from "@/components/layout/page-header"
import { ChannelSelect } from "@/components/common/channel-select"
import type { RateChangeLog } from "@/lib/api-types"
import { channelTypeLabel, formatRatio, fullDateTime, ratioDelta, relativeTime } from "@/lib/format"
import { useChannels, useRateChanges } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const PAGE_SIZE = 20

export default function RatesPage() {
  const isMobile = useIsMobile()
  const [page, setPage] = useState(1)
  const [channelID, setChannelID] = useState<number | undefined>()
  const changes = useRateChanges(page, PAGE_SIZE, channelID)
  const channels = useChannels()
  const channelMap = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c] as const)), [channels.data])

  const columns: ColumnProps<RateChangeLog>[] = [
    {
      title: "时间",
      dataIndex: "changed_at",
      width: 150,
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
      render: (id: number) => {
        const ch = channelMap.get(id)
        return ch ? (
          <span>
            {ch.name}{" "}
            <Typography.Text type="tertiary" size="small">
              {channelTypeLabel(ch.type)}
            </Typography.Text>
          </span>
        ) : (
          `渠道 #${id}`
        )
      },
    },
    { title: "模型 / 分组", dataIndex: "model_name", render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    {
      title: "倍率",
      key: "ratio",
      width: 200,
      render: (_: unknown, r: RateChangeLog) => (
        <span className="num">
          <Typography.Text type="tertiary">{formatRatio(r.old_ratio)}</Typography.Text>
          {" → "}
          <Typography.Text strong>{formatRatio(r.new_ratio)}</Typography.Text>
        </span>
      ),
    },
    {
      title: "变化",
      key: "delta",
      width: 110,
      render: (_: unknown, r: RateChangeLog) => {
        const d = ratioDelta(r.old_ratio, r.new_ratio)
        const up = d.direction === "up"
        return (
          <Tag color={up ? "red" : "green"} prefixIcon={up ? <IconArrowUp /> : <IconArrowDown />}>
            {d.pct}
          </Tag>
        )
      },
    },
  ]

  const data = changes.data
  return (
    <div className="page">
      <PageHeader
        title="倍率变化"
        description="每次采集发现分组倍率变化、新增分组时记录一条。"
        actions={
          <ChannelSelect
            value={channelID}
            onChange={(id) => {
              setChannelID(id)
              setPage(1)
            }}
          />
        }
      />
      <Card bodyStyle={{ padding: 0 }}>
        <Table<RateChangeLog>
          rowKey="id"
          size={isMobile ? "small" : "default"}
          columns={columns}
          dataSource={data?.items ?? []}
          loading={changes.loading || changes.stale}
          scroll={{ x: 760 }}
          empty="暂无倍率变动记录"
          pagination={{
            currentPage: page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            onPageChange: setPage,
            // 手机上用紧凑分页，放不下“显示第几条”
            showTotal: !isMobile,
            size: isMobile ? "small" : "default",
          }}
        />
      </Card>
    </div>
  )
}
