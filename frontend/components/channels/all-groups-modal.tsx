import { useEffect, useMemo, useState } from "react"
import { Input, Modal, Select, Table, Tag, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { IconSearch } from "@douyinfe/semi-icons"
import { apiFetch } from "@/lib/api"
import type { Channel, RateSnapshot } from "@/lib/api-types"
import { channelTypeLabel, formatRatio, relativeTime } from "@/lib/format"
import { useIsMobile } from "@/hooks/use-mobile"
import { GroupKeyActions, ratioColor, type APIKeyAction } from "@/components/channels/channel-parts"

type GroupSortMode = "channel-asc" | "channel-desc" | "ratio-asc" | "ratio-desc"

interface GroupRow {
  key: string
  channel: Channel
  rate: RateSnapshot
}

/** 所有渠道的分组倍率放在一张表里，方便横向比较、找最便宜的分组。 */
export function AllGroupsModal({ visible, onClose, channels, onAPIKeyAction }: {
  visible: boolean
  onClose: () => void
  channels: Channel[]
  onAPIKeyAction: APIKeyAction
}) {
  const isMobile = useIsMobile()
  const [query, setQuery] = useState("")
  const [sortMode, setSortMode] = useState<GroupSortMode>("channel-asc")
  const [rows, setRows] = useState<GroupRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all(
      channels.map(async (channel) => {
        const rates = await apiFetch<RateSnapshot[]>(
          `/channels/${channel.id}/rates${channel.only_created_key_groups_enabled ? "?only_with_keys=1" : ""}`,
        )
        return rates.map((rate) => ({ key: `${channel.id}-${rate.id}`, channel, rate }))
      }),
    )
      .then((result) => {
        if (!cancelled) setRows(result.flat())
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || "加载分组失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [visible, channels])

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter(({ channel, rate }) => {
        if (!q) return true
        return [channel.name, channelTypeLabel(channel.type), rate.model_name, rate.description ?? "", formatRatio(rate.ratio)].some((v) =>
          v.toLowerCase().includes(q),
        )
      })
      .sort((a, b) => {
        if (sortMode === "ratio-asc" || sortMode === "ratio-desc") {
          const diff = a.rate.ratio - b.rate.ratio
          return sortMode === "ratio-asc" ? diff : -diff
        }
        const diff =
          a.channel.name.localeCompare(b.channel.name, "zh-CN") || a.rate.model_name.localeCompare(b.rate.model_name, "zh-CN")
        return sortMode === "channel-asc" ? diff : -diff
      })
  }, [query, rows, sortMode])

  const channelCount = new Set(rows.map((row) => row.channel.id)).size

  const columns: ColumnProps<GroupRow>[] = [
    { title: "渠道", key: "channel", width: 160, render: (_: unknown, r: GroupRow) => r.channel.name },
    {
      title: "类型",
      key: "type",
      width: 90,
      render: (_: unknown, r: GroupRow) => <Tag size="small">{channelTypeLabel(r.channel.type)}</Tag>,
    },
    {
      title: "分组",
      key: "group",
      render: (_: unknown, r: GroupRow) => (
        <div className="stack" style={{ gap: 0 }}>
          <Typography.Text strong size="small">
            {r.rate.model_name}
          </Typography.Text>
          {r.rate.description ? (
            <Typography.Text type="tertiary" size="small" ellipsis={{ rows: 2, showTooltip: true }}>
              {r.rate.description}
            </Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: "倍率",
      key: "ratio",
      width: 100,
      render: (_: unknown, r: GroupRow) => <Tag color={ratioColor(r.rate.ratio)}>{formatRatio(r.rate.ratio)}</Tag>,
    },
    {
      title: "更新",
      key: "seen",
      width: 110,
      render: (_: unknown, r: GroupRow) => <Typography.Text type="tertiary" size="small">{relativeTime(r.rate.last_seen_at)}</Typography.Text>,
    },
    {
      title: "密钥",
      key: "actions",
      width: 64,
      render: (_: unknown, r: GroupRow) => <GroupKeyActions channel={r.channel} rate={r.rate} onAction={onAPIKeyAction} />,
    },
  ]

  return (
    <Modal
      visible={visible}
      onCancel={onClose}
      footer={null}
      width={isMobile ? "100%" : 960}
      title={
        <div className="stack" style={{ gap: 2 }}>
          <span>全部分组</span>
          <Typography.Text type="tertiary" size="small" style={{ fontWeight: "normal" }}>
            {loading ? "正在加载全部渠道的分组" : `${rows.length} 个分组 · ${channelCount} 个渠道`}
          </Typography.Text>
        </div>
      }
      bodyStyle={{ paddingBottom: 16 }}
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <Input prefix={<IconSearch />} value={query} onChange={setQuery} showClear placeholder="搜索渠道、分组或倍率" style={{ flex: 1, minWidth: 200 }} />
          <Select
            value={sortMode}
            onChange={(v) => setSortMode(v as GroupSortMode)}
            style={{ width: 160 }}
            optionList={[
              { value: "channel-asc", label: "渠道 A→Z" },
              { value: "channel-desc", label: "渠道 Z→A" },
              { value: "ratio-asc", label: "倍率从低到高" },
              { value: "ratio-desc", label: "倍率从高到低" },
            ]}
          />
        </div>
        <Table<GroupRow>
          rowKey="key"
          size="small"
          columns={columns}
          dataSource={filteredRows}
          loading={loading}
          scroll={{ x: 720, y: "55vh" }}
          pagination={false}
          empty={error ?? (rows.length === 0 ? "暂无分组数据" : "没有匹配的分组")}
        />
      </div>
    </Modal>
  )
}
