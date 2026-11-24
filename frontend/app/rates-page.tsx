import { useMemo, useState } from "react"
import { Chip, EmptyState, Spinner, Surface, Table, Tooltip } from "@heroui/react"
import { ArrowDown, ArrowUp } from "@gravity-ui/icons"
import { PageHeader } from "@/components/layout/page-header"
import { ChannelSelect } from "@/components/common/channel-select"
import { PaginationBar } from "@/components/common/pagination-bar"
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

  const data = changes.data
  const items = data?.items ?? []
  const total = data?.total ?? 0
  const loading = changes.loading && !data

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

      {loading ? (
        <Surface className="flex justify-center rounded-[20px] py-16">
          <Spinner />
        </Surface>
      ) : (
        <Table className={`transition-opacity ${changes.stale ? "opacity-60" : "opacity-100"}`}>
          <Table.ScrollContainer>
            <Table.Content aria-label="倍率变化列表" className="min-w-[740px]">
              <Table.Header>
                <Table.Column className="w-36">时间</Table.Column>
                <Table.Column className="w-52">渠道</Table.Column>
                <Table.Column isRowHeader>模型 / 分组</Table.Column>
                <Table.Column className="w-48">倍率</Table.Column>
                <Table.Column className="w-28">变化</Table.Column>
              </Table.Header>
              <Table.Body
                items={items}
                renderEmptyState={() => (
                  <EmptyState className="py-12 text-sm text-muted">暂无倍率变动记录</EmptyState>
                )}
              >
                {(r) => {
                  const ch = channelMap.get(r.channel_id)
                  const d = ratioDelta(r.old_ratio, r.new_ratio)
                  const up = d.direction === "up"
                  return (
                    <Table.Row key={r.id} id={r.id}>
                      <Table.Cell>
                        <Tooltip>
                          <Tooltip.Trigger className="inline-flex">
                            <span className="text-xs text-muted">{relativeTime(r.changed_at)}</span>
                          </Tooltip.Trigger>
                          <Tooltip.Content>{fullDateTime(r.changed_at)}</Tooltip.Content>
                        </Tooltip>
                      </Table.Cell>
                      <Table.Cell>
                        {ch ? (
                          <span className="text-sm text-foreground">
                            {ch.name}{" "}
                            <span className="text-xs text-muted">{channelTypeLabel(ch.type)}</span>
                          </span>
                        ) : (
                          <span className="text-sm text-muted">渠道 #{r.channel_id}</span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <span className="font-semibold text-foreground">{r.model_name}</span>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="num text-sm">
                          <span className="text-muted">{formatRatio(r.old_ratio)}</span>
                          {" → "}
                          <span className="font-semibold text-foreground">{formatRatio(r.new_ratio)}</span>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip color={up ? "danger" : "success"} variant="soft" size="sm" className="num">
                          {up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
                          <Chip.Label>{d.pct}</Chip.Label>
                        </Chip>
                      </Table.Cell>
                    </Table.Row>
                  )
                }}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
          {total > PAGE_SIZE ? (
            <Table.Footer>
              <PaginationBar
                page={page}
                total={total}
                pageSize={PAGE_SIZE}
                onChange={setPage}
                compact={isMobile}
              />
            </Table.Footer>
          ) : null}
        </Table>
      )}
    </div>
  )
}
