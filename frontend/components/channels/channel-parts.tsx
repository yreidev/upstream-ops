import { useState } from "react"
import { Button, Chip, Dropdown, EmptyState, Label, Spinner, Surface, Table, Tooltip } from "@heroui/react"
import { ArrowRightArrowLeft, Check, Key, Plus, Xmark } from "@gravity-ui/icons"
import type { BackgroundJob, Channel, ProgressEvent, RateSnapshot } from "@/lib/api-types"
import type { ChipColor } from "@/lib/labels"
import { decimal, formatRatio, relativeTime } from "@/lib/format"
import { useChannelRates } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"
import { PaginationBar } from "@/components/common/pagination-bar"

export type ChannelHealth = "healthy" | "low" | "failed" | "idle"

/** 与后端 status 筛选同一套规则（backend/storage/channel_list.go）。 */
export function healthOf(c: Channel): ChannelHealth {
  if (c.last_error) return "failed"
  if (c.last_balance == null) return "idle"
  if (c.balance_threshold > 0 && c.last_balance < c.balance_threshold) return "low"
  return "healthy"
}

export const healthMeta: Record<ChannelHealth, { label: string; color: ChipColor }> = {
  healthy: { label: "健康", color: "success" },
  low: { label: "低余额", color: "warning" },
  failed: { label: "登录失败", color: "danger" },
  idle: { label: "尚未采集", color: "default" },
}

/** 倍率越低越绿，越高越红；1 附近不着色。 */
export function ratioColor(r: number): ChipColor {
  if (r <= 0.8) return "success"
  if (r > 2) return "danger"
  if (r > 1.2) return "warning"
  return "default"
}

export function rechargeMultiplierTip(c: Channel) {
  const mode = c.recharge_multiplier_mode === "multiply" ? "余额 × 倍率" : "余额 / 倍率"
  if (c.recharge_multiplier != null && c.recharge_multiplier > 0) {
    return `充值倍率：${decimal(c.recharge_multiplier, 4)}（${mode}）`
  }
  return `充值倍率：跟随上游（${mode}）`
}

// —— 同步 / 测试登录进度 ——

export interface ChannelSyncState {
  running: boolean
  events: ProgressEvent[]
  latest: ProgressEvent | null
  finalOk: boolean | null
}

export function emptySyncState(): ChannelSyncState {
  return { running: false, events: [], latest: null, finalOk: null }
}

/** 单个渠道任务的进度：跑完后补一条结论，失败原因显示在最后。 */
export function syncStateOf(job: BackgroundJob): ChannelSyncState {
  const events = job.events ?? []
  if (job.status === "running") return { running: true, events, latest: events.at(-1) ?? null, finalOk: null }
  const ok = job.status === "succeeded"
  const final: ProgressEvent = {
    stage: ok ? "done" : "error",
    message: job.message || (ok ? "完成" : "失败"),
    time: job.finished_at ?? job.started_at,
  }
  // 失败原因已经写在出错的那一步里时，不再重复一行“失败”
  const shownInStep = !ok && events.some((ev) => (ev.stage === "error" || ev.ok === false) && ev.message === final.message)
  return { running: false, events: shownInStep ? events : [...events, final], latest: final, finalOk: ok }
}

export const stageLabel: Record<ProgressEvent["stage"], string> = {
  captcha: "打码",
  session: "会话",
  login: "登录",
  balance: "余额",
  cost: "消费",
  rates: "倍率",
  done: "完成",
  skipped: "跳过",
  error: "失败",
}

const stageOrder: Record<ProgressEvent["stage"], number> = {
  captcha: 1,
  session: 2,
  login: 3,
  balance: 4,
  cost: 5,
  rates: 7,
  done: 9,
  skipped: 9,
  error: 9,
}

/** 按阶段去重，每个阶段只留最后一条（“进行中”会被“完成”覆盖）。 */
function deriveSteps(events: ProgressEvent[]): ProgressEvent[] {
  const byStage = new Map<ProgressEvent["stage"], ProgressEvent>()
  for (const ev of events) byStage.set(ev.stage, ev)
  return [...byStage.values()].sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage])
}

/** 同步或测试登录的分步进度。 */
export function SyncProgress({ state }: { state: ChannelSyncState }) {
  if (!state.running && state.latest == null) return null
  const steps = deriveSteps(state.events)
  // 任务失败但没有分步事件（如没找到渠道）时只有 latest
  const shown = steps.length === 0 && state.latest ? [state.latest] : steps
  return (
    <Surface variant="secondary" className="rounded-xl px-3 py-2.5">
      {shown.length === 0 ? (
        <div className="row text-xs text-muted">
          <Spinner size="sm" />
          <span>准备中…</span>
        </div>
      ) : (
        <div className="stack gap-1">
          {shown.map((ev) => {
            const failed = ev.stage === "error" || ev.ok === false
            const succeeded = ev.stage === "done" || ev.ok === true
            const running = !failed && !succeeded
            return (
              <div key={ev.stage} className="row items-start text-xs">
                <span className="inline-flex w-4 shrink-0 justify-center pt-0.5">
                  {running ? (
                    <Spinner size="sm" />
                  ) : failed ? (
                    <Xmark className="size-3.5 text-danger" />
                  ) : (
                    <Check className="size-3.5 text-success" />
                  )}
                </span>
                <span className="w-8 shrink-0 text-muted">{stageLabel[ev.stage]}</span>
                <span className={`pre-wrap min-w-0 ${failed ? "text-danger" : "text-foreground"}`}>
                  {ev.message}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Surface>
  )
}

/** 表格“状态”列：同步中显示当前阶段，失败显示失败，否则显示健康状态和是否暂停。 */
export function ChannelStatusTags({ channel, sync }: { channel: Channel; sync?: ChannelSyncState }) {
  const health = healthMeta[healthOf(channel)]
  return (
    <div className="row flex-wrap gap-1">
      {sync?.running ? (
        <Chip color="accent" variant="soft" size="sm">
          <Spinner size="sm" color="current" />
          <Chip.Label>{sync.latest ? stageLabel[sync.latest.stage] : "准备中"}</Chip.Label>
        </Chip>
      ) : sync?.finalOk === false ? (
        <Tooltip>
          <Tooltip.Trigger className="inline-flex">
            <Chip color="danger" variant="soft" size="sm">
              同步失败
            </Chip>
          </Tooltip.Trigger>
          {sync.latest?.message ? <Tooltip.Content className="max-w-xs">{sync.latest.message}</Tooltip.Content> : null}
        </Tooltip>
      ) : (
        <Chip color={health.color} variant="soft" size="sm">
          {health.label}
        </Chip>
      )}
      {!channel.monitor_enabled ? (
        <Chip color="warning" variant="soft" size="sm">
          已暂停
        </Chip>
      ) : null}
    </div>
  )
}

export type APIKeyAction = (channel: Channel, rate: RateSnapshot, type: "create" | "migrate") => void

/** 分组的密钥操作：在这个分组下新建，或把已有密钥移过来。 */
export function GroupKeyActions({
  channel,
  rate,
  onAction,
}: {
  channel: Channel
  rate: RateSnapshot
  onAction: APIKeyAction
}) {
  return (
    <Dropdown>
      <Button isIconOnly variant="ghost" size="sm" aria-label="密钥操作">
        <Key className="size-4" />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label="分组密钥操作"
          onAction={(key) => {
            if (key === "create") onAction(channel, rate, "create")
            else if (key === "migrate") onAction(channel, rate, "migrate")
          }}
        >
          <Dropdown.Item id="create" textValue="在此分组新建密钥">
            <Plus className="size-4" />
            <Label>在此分组新建密钥</Label>
          </Dropdown.Item>
          <Dropdown.Item id="migrate" textValue="把已有密钥移到此分组">
            <ArrowRightArrowLeft className="size-4" />
            <Label>把已有密钥移到此分组</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

const RATES_PAGE_SIZE = 20

/** 单个渠道的分组倍率表，在渠道行尾“分组”打开的抽屉里。开了“只看已建密钥的分组”时只列有密钥的分组。 */
export function ChannelRatesTable({
  channel,
  onAPIKeyAction,
}: {
  channel: Channel
  onAPIKeyAction: APIKeyAction
}) {
  const { data, loading, error } = useChannelRates(channel.id, channel.only_created_key_groups_enabled)
  const rates = [...(data ?? [])].sort((a, b) => a.ratio - b.ratio)
  const isMobile = useIsMobile()
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(rates.length / RATES_PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pagedRates = rates.slice((safePage - 1) * RATES_PAGE_SIZE, safePage * RATES_PAGE_SIZE)

  if (loading && !data) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }

  return (
    <Table variant="secondary">
      <Table.ScrollContainer>
        <Table.Content aria-label={`${channel.name} 分组倍率`}>
          <Table.Header>
            <Table.Column isRowHeader>分组</Table.Column>
            <Table.Column className={isMobile ? "w-20" : "w-24"}>倍率</Table.Column>
            <Table.Column className={isMobile ? "w-20" : "w-28"}>更新</Table.Column>
            <Table.Column className="w-16">密钥</Table.Column>
          </Table.Header>
          <Table.Body
            items={pagedRates}
            renderEmptyState={() => (
              <EmptyState className="py-8 text-sm text-muted">
                {error
                  ? `分组加载失败：${error}`
                  : channel.only_created_key_groups_enabled
                    ? "还没有已建密钥的分组"
                    : "还没采集到分组，点“同步”试试"}
              </EmptyState>
            )}
          >
            {(r) => (
              <Table.Row key={r.id} id={r.id}>
                <Table.Cell>
                  <div className="stack gap-0">
                    <span className="text-xs font-semibold text-foreground">{r.model_name}</span>
                    {r.description ? (
                      <span className="line-clamp-2 text-xs text-muted" title={r.description}>
                        {r.description}
                      </span>
                    ) : null}
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <Chip color={ratioColor(r.ratio)} variant="soft" size="sm" className="num">
                    {formatRatio(r.ratio)}
                  </Chip>
                </Table.Cell>
                <Table.Cell>
                  <span className="text-xs text-muted">{relativeTime(r.last_seen_at)}</span>
                </Table.Cell>
                <Table.Cell>
                  <GroupKeyActions channel={channel} rate={r} onAction={onAPIKeyAction} />
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
      {rates.length > RATES_PAGE_SIZE ? (
        <Table.Footer>
          <PaginationBar
            page={safePage}
            total={rates.length}
            pageSize={RATES_PAGE_SIZE}
            onChange={setPage}
            compact={isMobile}
          />
        </Table.Footer>
      ) : null}
    </Table>
  )
}
