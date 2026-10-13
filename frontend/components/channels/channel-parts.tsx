import { Button, Dropdown, Spin, Table, Tag, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import type { TagColor } from "@douyinfe/semi-ui/lib/es/tag"
import { IconClose, IconForward, IconKey, IconPlus, IconTick } from "@douyinfe/semi-icons"
import type { BackgroundJob, Channel, ProgressEvent, RateSnapshot } from "@/lib/api-types"
import { decimal, formatRatio, relativeTime } from "@/lib/format"
import { useChannelRates } from "@/lib/queries"

export type ChannelHealth = "healthy" | "low" | "failed" | "idle"

/** 与后端 status 筛选同一套规则（backend/storage/channel_list.go）。 */
export function healthOf(c: Channel): ChannelHealth {
  if (c.last_error) return "failed"
  if (c.last_balance == null) return "idle"
  if (c.balance_threshold > 0 && c.last_balance < c.balance_threshold) return "low"
  return "healthy"
}

export const healthMeta: Record<ChannelHealth, { label: string; color: TagColor }> = {
  healthy: { label: "健康", color: "green" },
  low: { label: "低余额", color: "orange" },
  failed: { label: "登录失败", color: "red" },
  idle: { label: "尚未采集", color: "grey" },
}

/** 倍率越低越绿，越高越红；1 附近不着色。 */
export function ratioColor(r: number): TagColor {
  if (r <= 0.8) return "green"
  if (r > 2) return "red"
  if (r > 1.2) return "orange"
  return "white"
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
    <div style={{ padding: "8px 12px", borderRadius: 6, background: "var(--semi-color-fill-0)" }}>
      {shown.length === 0 ? (
        <div className="row">
          <Spin size="small" />
          <Typography.Text size="small">准备中…</Typography.Text>
        </div>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          {shown.map((ev) => {
            const failed = ev.stage === "error" || ev.ok === false
            const succeeded = ev.stage === "done" || ev.ok === true
            const running = !failed && !succeeded
            return (
              <div key={ev.stage} className="row" style={{ alignItems: "flex-start" }}>
                <span style={{ width: 16, display: "inline-flex", justifyContent: "center", paddingTop: 2 }}>
                  {running ? (
                    <Spin size="small" />
                  ) : failed ? (
                    <IconClose size="small" style={{ color: "var(--semi-color-danger)" }} />
                  ) : (
                    <IconTick size="small" style={{ color: "var(--semi-color-success)" }} />
                  )}
                </span>
                <Typography.Text type="tertiary" size="small" style={{ width: 32, flexShrink: 0 }}>
                  {stageLabel[ev.stage]}
                </Typography.Text>
                <Typography.Text size="small" type={failed ? "danger" : undefined} className="pre-wrap" style={{ minWidth: 0 }}>
                  {ev.message}
                </Typography.Text>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 表格“状态”列：同步中显示当前阶段，失败显示失败，否则显示健康状态和是否暂停。 */
export function ChannelStatusTags({ channel, sync }: { channel: Channel; sync?: ChannelSyncState }) {
  const health = healthMeta[healthOf(channel)]
  return (
    <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
      {sync?.running ? (
        <Tag color="blue" prefixIcon={<Spin size="small" />}>
          {sync.latest ? stageLabel[sync.latest.stage] : "准备中"}
        </Tag>
      ) : sync?.finalOk === false ? (
        <Tooltip content={sync.latest?.message}>
          <Tag color="red">同步失败</Tag>
        </Tooltip>
      ) : (
        <Tag color={health.color}>{health.label}</Tag>
      )}
      {!channel.monitor_enabled ? <Tag color="amber">已暂停</Tag> : null}
    </div>
  )
}

export type APIKeyAction = (channel: Channel, rate: RateSnapshot, type: "create" | "migrate") => void

/** 分组的密钥操作：在这个分组下新建，或把已有密钥移过来。 */
export function GroupKeyActions({ channel, rate, onAction }: { channel: Channel; rate: RateSnapshot; onAction: APIKeyAction }) {
  return (
    <Dropdown
      position="bottomRight"
      trigger="click"
      clickToHide
      render={
        <Dropdown.Menu>
          <Dropdown.Item icon={<IconPlus />} onClick={() => onAction(channel, rate, "create")}>
            在此分组新建密钥
          </Dropdown.Item>
          <Dropdown.Item icon={<IconForward />} onClick={() => onAction(channel, rate, "migrate")}>
            把已有密钥移到此分组
          </Dropdown.Item>
        </Dropdown.Menu>
      }
    >
      <Button theme="borderless" size="small" icon={<IconKey />} aria-label="密钥操作" />
    </Dropdown>
  )
}

/** 展开行 / 卡片里的分组倍率表。开了“只看已建密钥的分组”时只列有密钥的分组。 */
export function ChannelRatesTable({ channel, onAPIKeyAction }: { channel: Channel; onAPIKeyAction: APIKeyAction }) {
  const { data, loading, error } = useChannelRates(channel.id, channel.only_created_key_groups_enabled)
  const rates = [...(data ?? [])].sort((a, b) => a.ratio - b.ratio)

  const columns: ColumnProps<RateSnapshot>[] = [
    {
      title: "分组",
      dataIndex: "model_name",
      render: (v: string, r: RateSnapshot) => (
        <div className="stack" style={{ gap: 0 }}>
          <Typography.Text strong size="small">
            {v}
          </Typography.Text>
          {r.description ? (
            <Typography.Text type="tertiary" size="small" ellipsis={{ rows: 2, showTooltip: true }}>
              {r.description}
            </Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: "倍率",
      dataIndex: "ratio",
      width: 100,
      render: (v: number) => (
        <Tag color={ratioColor(v)} className="num">
          {formatRatio(v)}
        </Tag>
      ),
    },
    {
      title: "更新",
      dataIndex: "last_seen_at",
      width: 110,
      render: (v: string) => <Typography.Text type="tertiary" size="small">{relativeTime(v)}</Typography.Text>,
    },
    {
      title: "密钥",
      key: "actions",
      width: 64,
      render: (_: unknown, r: RateSnapshot) => <GroupKeyActions channel={channel} rate={r} onAction={onAPIKeyAction} />,
    },
  ]

  return (
    <Table<RateSnapshot>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={rates}
      loading={loading && !data}
      pagination={rates.length > 20 ? { pageSize: 20 } : false}
      empty={
        error
          ? `分组加载失败：${error}`
          : channel.only_created_key_groups_enabled
            ? "还没有已建密钥的分组"
            : "还没采集到分组，点“同步”试试"
      }
    />
  )
}
