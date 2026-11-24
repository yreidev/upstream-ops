import { useMemo, useState } from "react"
import { Chip, EmptyState, ListBox, Select, Spinner, Surface, Table, Tooltip } from "@heroui/react"
import { PageHeader } from "@/components/layout/page-header"
import { ChannelSelect } from "@/components/common/channel-select"
import { PaginationBar } from "@/components/common/pagination-bar"
import type { MonitorJob } from "@/lib/api-types"
import { channelTypeLabel, formatDurationMS, fullDateTime, relativeTime } from "@/lib/format"
import { monitorJobLabel } from "@/lib/labels"
import { useChannels, useMonitorLogs } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const LIMIT_OPTIONS = [100, 300, 1000]
const PAGE_SIZE = 50
type ResultFilter = "all" | "failed" | "ok"

const resultOptions: { value: ResultFilter; label: string }[] = [
  { value: "all", label: "全部结果" },
  { value: "failed", label: "只看失败" },
  { value: "ok", label: "只看成功" },
]

export default function MonitorLogsPage() {
  const isMobile = useIsMobile()
  const [channelID, setChannelID] = useState<number | undefined>()
  const [limit, setLimit] = useState(100)
  const [job, setJob] = useState<MonitorJob | undefined>()
  const [result, setResult] = useState<ResultFilter>("all")
  const [page, setPage] = useState(1)
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

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagedRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  return (
    <div className="page">
      <PageHeader
        title="监控日志"
        description="每次登录、校验会话、采集余额、消费和倍率都会记一条，按设置里的保留天数自动清理。"
        actions={
          <>
            <ChannelSelect
              value={channelID}
              onChange={(id) => {
                setChannelID(id)
                setPage(1)
              }}
            />

            <Select
              aria-label="按任务筛选"
              placeholder="全部任务"
              value={job ?? null}
              onChange={(k) => {
                setJob(k == null || k === "" ? undefined : (String(k) as MonitorJob))
                setPage(1)
              }}
              onClear={() => {
                setJob(undefined)
                setPage(1)
              }}
              className="w-32"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.ClearButton />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {Object.entries(monitorJobLabel).map(([value, label]) => (
                    <ListBox.Item key={value} id={value} textValue={label}>
                      {label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            <Select
              aria-label="按结果筛选"
              value={result}
              onChange={(k) => {
                if (k != null) {
                  setResult(String(k) as ResultFilter)
                  setPage(1)
                }
              }}
              className="w-28"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {resultOptions.map((o) => (
                    <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                      {o.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            <Select
              aria-label="拉取条数"
              value={String(limit)}
              onChange={(k) => {
                if (k != null) {
                  setLimit(Number(k))
                  setPage(1)
                }
              }}
              className="w-32"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {LIMIT_OPTIONS.map((n) => (
                    <ListBox.Item key={n} id={String(n)} textValue={`最近 ${n} 条`}>
                      最近 {n} 条
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </>
        }
      />

      {logs.loading && !logs.data ? (
        <Surface className="flex justify-center rounded-[20px] py-16">
          <Spinner />
        </Surface>
      ) : (
        <Table className={`transition-opacity ${logs.stale ? "opacity-60" : "opacity-100"}`}>
          <Table.ScrollContainer>
            <Table.Content aria-label="监控日志列表" className="min-w-[820px]">
              <Table.Header>
                <Table.Column className="w-32">开始时间</Table.Column>
                <Table.Column isRowHeader className="w-52">
                  渠道
                </Table.Column>
                <Table.Column className="w-24">任务</Table.Column>
                <Table.Column className="w-20">结果</Table.Column>
                <Table.Column className="w-24">耗时</Table.Column>
                <Table.Column>错误</Table.Column>
              </Table.Header>
              <Table.Body
                items={pagedRows}
                renderEmptyState={() => (
                  <EmptyState className="py-12 text-sm text-muted">没有符合条件的监控日志</EmptyState>
                )}
              >
                {(l) => {
                  const ch = channelMap.get(l.channel_id)
                  return (
                    <Table.Row key={l.id} id={l.id}>
                      <Table.Cell>
                        <Tooltip>
                          <Tooltip.Trigger className="inline-flex">
                            <span className="text-xs text-muted">{relativeTime(l.started_at)}</span>
                          </Tooltip.Trigger>
                          <Tooltip.Content>{fullDateTime(l.started_at)}</Tooltip.Content>
                        </Tooltip>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="text-sm text-foreground">
                          {ch ? `${ch.name} · ${channelTypeLabel(ch.type)}` : `渠道 #${l.channel_id}`}
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="text-xs text-foreground">{monitorJobLabel[l.job] ?? l.job}</span>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip color={l.success ? "success" : "danger"} variant="soft" size="sm">
                          {l.success ? "成功" : "失败"}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="num text-xs text-foreground">{formatDurationMS(l.duration_ms)}</span>
                      </Table.Cell>
                      <Table.Cell>
                        {l.error_message ? (
                          <span title={l.error_message} className="line-clamp-2 text-xs text-danger">
                            {l.error_message}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  )
                }}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
          {rows.length > PAGE_SIZE ? (
            <Table.Footer>
              <PaginationBar
                page={safePage}
                total={rows.length}
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
