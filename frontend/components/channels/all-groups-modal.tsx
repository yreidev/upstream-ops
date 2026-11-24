import { useEffect, useMemo, useState } from "react"
import { Chip, EmptyState, ListBox, Modal, ScrollShadow, SearchField, Select, Spinner, Table } from "@heroui/react"
import { apiFetch } from "@/lib/api"
import type { Channel, RateSnapshot } from "@/lib/api-types"
import { channelTypeLabel, formatRatio, relativeTime } from "@/lib/format"
import { GroupKeyActions, ratioColor, type APIKeyAction } from "@/components/channels/channel-parts"

type GroupSortMode = "channel-asc" | "channel-desc" | "ratio-asc" | "ratio-desc"

interface GroupRow {
  key: string
  channel: Channel
  rate: RateSnapshot
}

const sortOptions: { value: GroupSortMode; label: string }[] = [
  { value: "channel-asc", label: "渠道 A→Z" },
  { value: "channel-desc", label: "渠道 Z→A" },
  { value: "ratio-asc", label: "倍率从低到高" },
  { value: "ratio-desc", label: "倍率从高到低" },
]

/** 所有渠道的分组倍率放在一张表里，方便横向比较、找最便宜的分组。 */
export function AllGroupsModal({
  visible,
  onClose,
  channels,
  onAPIKeyAction,
}: {
  visible: boolean
  onClose: () => void
  channels: Channel[]
  onAPIKeyAction: APIKeyAction
}) {
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
        return [
          channel.name,
          channelTypeLabel(channel.type),
          rate.model_name,
          rate.description ?? "",
          formatRatio(rate.ratio),
        ].some((v) => v.toLowerCase().includes(q))
      })
      .sort((a, b) => {
        if (sortMode === "ratio-asc" || sortMode === "ratio-desc") {
          const diff = a.rate.ratio - b.rate.ratio
          return sortMode === "ratio-asc" ? diff : -diff
        }
        const diff =
          a.channel.name.localeCompare(b.channel.name, "zh-CN") ||
          a.rate.model_name.localeCompare(b.rate.model_name, "zh-CN")
        return sortMode === "channel-asc" ? diff : -diff
      })
  }, [query, rows, sortMode])

  const channelCount = new Set(rows.map((row) => row.channel.id)).size

  return (
    <Modal.Backdrop isOpen={visible} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="lg" scroll="inside" className="w-[min(960px,calc(100vw-24px))] max-w-none">
        <Modal.Dialog className="w-full max-w-none">
          <Modal.CloseTrigger />
          <Modal.Header className="flex flex-col items-start gap-0.5">
            <Modal.Heading>全部分组</Modal.Heading>
            <span className="text-xs font-normal text-muted">
              {loading ? "正在加载全部渠道的分组" : `${rows.length} 个分组 · ${channelCount} 个渠道`}
            </span>
          </Modal.Header>
          <Modal.Body className="pb-4">
            <div className="stack gap-3">
              <div className="row flex-wrap">
                <SearchField
                  aria-label="搜索分组"
                  variant="secondary"
                  value={query}
                  onChange={setQuery}
                  className="min-w-[200px] flex-1"
                >
                  <SearchField.Group>
                    <SearchField.SearchIcon />
                    <SearchField.Input placeholder="搜索渠道、分组或倍率" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
                <Select
                  aria-label="排序方式"
                  variant="secondary"
                  value={sortMode}
                  onChange={(k) => k != null && setSortMode(String(k) as GroupSortMode)}
                  className="w-40"
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {sortOptions.map((o) => (
                        <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                          {o.label}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>

              {loading ? (
                <div className="flex justify-center py-12">
                  <Spinner />
                </div>
              ) : (
                <ScrollShadow className="max-h-[55vh]" size={24}>
                  <Table variant="secondary">
                    <Table.ScrollContainer>
                      <Table.Content aria-label="全部渠道分组倍率" className="min-w-[680px]">
                        <Table.Header>
                          <Table.Column isRowHeader className="w-40">
                            渠道
                          </Table.Column>
                          <Table.Column className="w-24">类型</Table.Column>
                          <Table.Column>分组</Table.Column>
                          <Table.Column className="w-24">倍率</Table.Column>
                          <Table.Column className="w-28">更新</Table.Column>
                          <Table.Column className="w-16">密钥</Table.Column>
                        </Table.Header>
                        <Table.Body
                          items={filteredRows}
                          renderEmptyState={() => (
                            <EmptyState className="py-10 text-sm text-muted">
                              {error ?? (rows.length === 0 ? "暂无分组数据" : "没有匹配的分组")}
                            </EmptyState>
                          )}
                        >
                          {(r) => (
                            <Table.Row key={r.key} id={r.key}>
                              <Table.Cell>
                                <span className="font-medium text-foreground">{r.channel.name}</span>
                              </Table.Cell>
                              <Table.Cell>
                                <Chip color={r.channel.type === "newapi" ? "accent" : "default"} variant="soft" size="sm">
                                  {channelTypeLabel(r.channel.type)}
                                </Chip>
                              </Table.Cell>
                              <Table.Cell>
                                <div className="stack gap-0">
                                  <span className="text-xs font-semibold text-foreground">{r.rate.model_name}</span>
                                  {r.rate.description ? (
                                    <span className="line-clamp-2 text-xs text-muted" title={r.rate.description}>
                                      {r.rate.description}
                                    </span>
                                  ) : null}
                                </div>
                              </Table.Cell>
                              <Table.Cell>
                                <Chip color={ratioColor(r.rate.ratio)} variant="soft" size="sm" className="num">
                                  {formatRatio(r.rate.ratio)}
                                </Chip>
                              </Table.Cell>
                              <Table.Cell>
                                <span className="text-xs text-muted">{relativeTime(r.rate.last_seen_at)}</span>
                              </Table.Cell>
                              <Table.Cell>
                                <GroupKeyActions channel={r.channel} rate={r.rate} onAction={onAPIKeyAction} />
                              </Table.Cell>
                            </Table.Row>
                          )}
                        </Table.Body>
                      </Table.Content>
                    </Table.ScrollContainer>
                  </Table>
                </ScrollShadow>
              )}
            </div>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
