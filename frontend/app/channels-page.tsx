import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Banner,
  Button,
  Card,
  Dropdown,
  Empty,
  Input,
  Pagination,
  Select,
  Table,
  Tag,
  Toast,
  Tooltip,
  Typography,
} from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { IllustrationNoContent, IllustrationNoContentDark, IllustrationNoResult, IllustrationNoResultDark } from "@douyinfe/semi-illustrations"
import {
  IconClear,
  IconCreditCard,
  IconDelete,
  IconEdit,
  IconExternalOpen,
  IconFilter,
  IconGift,
  IconKey,
  IconList,
  IconMore,
  IconPause,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconUser,
} from "@douyinfe/semi-icons"
import { PageHeader } from "@/components/layout/page-header"
import { AllGroupsModal } from "@/components/channels/all-groups-modal"
import { ChannelAPIKeysSheet, type ChannelAPIKeyInitialAction } from "@/components/channels/channel-api-keys-sheet"
import { ChannelFormModal } from "@/components/channels/channel-form-modal"
import {
  ChannelRatesTable,
  ChannelStatusTags,
  SyncProgress,
  emptySyncState,
  syncStateOf,
  healthMeta,
  rechargeMultiplierTip,
  type APIKeyAction,
  type ChannelSyncState,
} from "@/components/channels/channel-parts"
import { ChannelRechargeModal } from "@/components/channels/channel-recharge-modal"
import { ChannelRedeemModal } from "@/components/channels/channel-redeem-modal"
import { apiFetch } from "@/lib/api"
import type { BackgroundJob, Channel, ChannelListOrder, ChannelListSort, ChannelListStatus, ProgressEvent } from "@/lib/api-types"
import { channelTagKey } from "@/lib/channel-tags"
import { confirm } from "@/lib/confirm"
import { channelTypeLabel, fullDateTime, money, relativeTime } from "@/lib/format"
import { useChannels, useChannelsPage } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { fetchRunningJobs, isAbort, startJob, watchJob } from "@/lib/jobs"
import { useIsMobile } from "@/hooks/use-mobile"

type ChannelPageSize = 10 | 20 | 50 | 100 | "all"
type ChannelStatusFilter = "all" | ChannelListStatus
type ChannelSortMode =
  | "default"
  | "name-asc"
  | "name-desc"
  | "username-asc"
  | "username-desc"
  | "health-asc"
  | "balance-asc"
  | "balance-desc"

const pageSizeOptions: ChannelPageSize[] = [10, 20, 50, 100, "all"]
const DEFAULT_PAGE_SIZE: ChannelPageSize = 20
const PAGE_SIZE_STORAGE_KEY = "monitor-channel-page-size-v1"
const SORT_STORAGE_KEY = "monitor-channel-sort-v1"
// 与后端 storage.MaxChannelListQueryRunes 一致；maxLength 按 UTF-16 计数，不会超过后端按字符计的上限。
const MAX_SEARCH_LENGTH = 200

const statusFilterOptions: { value: ChannelStatusFilter; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "healthy", label: healthMeta.healthy.label },
  { value: "low", label: healthMeta.low.label },
  { value: "failed", label: healthMeta.failed.label },
  { value: "idle", label: healthMeta.idle.label },
  { value: "paused", label: "已暂停" },
]

const sortOptions: { value: ChannelSortMode; label: string; sort?: ChannelListSort; order?: ChannelListOrder }[] = [
  { value: "default", label: "默认排序" },
  { value: "name-asc", label: "名称 A→Z", sort: "name", order: "asc" },
  { value: "name-desc", label: "名称 Z→A", sort: "name", order: "desc" },
  { value: "username-asc", label: "账号 A→Z", sort: "username", order: "asc" },
  { value: "username-desc", label: "账号 Z→A", sort: "username", order: "desc" },
  { value: "health-asc", label: "健康状态（异常优先）", sort: "health", order: "asc" },
  { value: "balance-asc", label: "余额从低到高", sort: "balance", order: "asc" },
  { value: "balance-desc", label: "余额从高到低", sort: "balance", order: "desc" },
]

function loadStored<T>(key: string, options: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return options.find((v) => String(v) === raw) ?? fallback
  } catch {
    return fallback
  }
}

function saveStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // 存不下就只在本次会话生效
  }
}

interface APIKeySheetState {
  channel: Channel
  initialAction?: ChannelAPIKeyInitialAction
}

/** 渠道列表：搜索、筛选、排序和分页都在后端做，跨页结果才准确。 */
export default function ChannelsPage() {
  const isMobile = useIsMobile()
  const { data: channels, loading: channelsLoading } = useChannels()
  const refresh = useTriggerRefresh()

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<ChannelPageSize>(() => loadStored(PAGE_SIZE_STORAGE_KEY, pageSizeOptions, DEFAULT_PAGE_SIZE))
  // searchInput 是输入框的即时值，search 是停顿后真正拿去查的值
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  // 输入法组字中（拼音还没选词）不发起搜索
  const [composing, setComposing] = useState(false)
  const [statusFilter, setStatusFilter] = useState<ChannelStatusFilter>("all")
  const [tagFilter, setTagFilter] = useState("")
  const [sortMode, setSortMode] = useState<ChannelSortMode>(() =>
    loadStored(SORT_STORAGE_KEY, sortOptions.map((o) => o.value), "default"),
  )

  // 标签候选取自全量渠道，只忽略 ASCII 大小写去重（与后端规则一致，见 channelTagKey）
  const tagOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const c of channels ?? []) {
      for (const tag of c.tags ?? []) {
        const key = channelTagKey(tag)
        if (!seen.has(key)) seen.set(key, tag)
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, "zh-CN"))
  }, [channels])
  // 选中的标签被删掉后当作“全部”
  const activeTag = tagFilter ? (tagOptions.find((t) => channelTagKey(t) === channelTagKey(tagFilter)) ?? "") : ""
  const sortOption = sortOptions.find((o) => o.value === sortMode) ?? sortOptions[0]
  const filtersActive = search !== "" || statusFilter !== "all" || activeTag !== ""

  const pageQuery = useChannelsPage(page, pageSize === "all" ? -1 : pageSize, {
    q: search,
    status: statusFilter === "all" ? undefined : statusFilter,
    tag: activeTag,
    sort: sortOption.sort,
    order: sortOption.order,
  })
  const channelPage = pageQuery.data
  // 换了条件、新结果还没到时，channelPage 还是旧条件的数据：pageStale 时旧列表只作占位；
  // countsStale 时旧的数量、页码和“没有匹配”都不能展示。
  const pageStale = pageQuery.stale
  const countsReady = channelPage != null && !pageQuery.countsStale
  const pageError = pageQuery.error
  const visibleChannels = channelPage?.items ?? []
  const totalChannels = channelPage?.total ?? 0
  const pageSizeAll = pageSize === "all"
  const totalPages = pageSizeAll ? 1 : (channelPage?.pages ?? 1)
  const currentPage = pageSizeAll ? 1 : Math.min(page, totalPages)

  const [editing, setEditing] = useState<Channel | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [redeeming, setRedeeming] = useState<Channel | null>(null)
  const [recharging, setRecharging] = useState<Channel | null>(null)
  const [apiKeySheet, setAPIKeySheet] = useState<APIKeySheetState | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<number[]>([])
  const [syncState, setSyncState] = useState<Record<number, ChannelSyncState>>({})
  const [bulkSync, setBulkSync] = useState({ running: false, completed: 0, total: 0 })
  const anySyncRunning = bulkSync.running || Object.values(syncState).some((s) => s.running)
  // 成功的进度 5 秒后自动收起
  const hideTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  // 同步、测试登录都是后端的后台任务，页面只轮询进度；离开页面就停止轮询，任务照常跑完。
  // 测试登录在编辑弹窗里发起，刷新页面后在这里接上
  const watchAbort = useRef<AbortController | null>(null)
  const watching = useRef<Set<number>>(new Set())

  useEffect(() => {
    const timers = hideTimers.current
    const ctrl = new AbortController()
    watchAbort.current = ctrl
    // 接上还在跑的任务：刷新页面、从别的页回来、另一台设备上发起的
    fetchRunningJobs()
      .then((list) => {
        for (const job of list) {
          if (job.kind === "channel_sync_all") void followBulkJob(job)
          else if (job.kind === "channel_sync" || job.kind === "channel_test_login") void followChannelJob(job)
        }
      })
      .catch(() => {})
    return () => {
      ctrl.abort()
      timers.forEach((t) => clearTimeout(t))
      timers.clear()
    }
  }, [])

  useEffect(() => {
    setPage((prev) => Math.min(prev, totalPages))
  }, [totalPages])

  // 输入停顿 300ms 后才搜索，并回到第一页；组字期间不计时
  useEffect(() => {
    if (composing) return
    const next = searchInput.trim()
    if (next === search) return
    const timer = setTimeout(() => {
      setSearch(next)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput, search, composing])

  /** 清除搜索与筛选；排序是个人偏好，保留。 */
  function clearFilters() {
    setSearchInput("")
    setComposing(false)
    setSearch("")
    setStatusFilter("all")
    setTagFilter("")
    setPage(1)
  }

  function clearHideTimer(id: number) {
    const t = hideTimers.current.get(id)
    if (t != null) {
      clearTimeout(t)
      hideTimers.current.delete(id)
    }
  }

  function scheduleHide(id: number) {
    clearHideTimer(id)
    hideTimers.current.set(
      id,
      setTimeout(() => {
        setSyncState((s) => {
          const next = { ...s }
          delete next[id]
          return next
        })
        hideTimers.current.delete(id)
      }, 5000),
    )
  }

  function patchSync(id: number, fn: (prev: ChannelSyncState) => ChannelSyncState) {
    setSyncState((s) => ({ ...s, [id]: fn(s[id] ?? emptySyncState()) }))
  }

  function expandRow(id: number) {
    setExpandedKeys((keys) => (keys.includes(id) ? keys : [...keys, id]))
  }

  async function followChannelJob(job: BackgroundJob) {
    const id = job.channel_id
    if (!id || watching.current.has(job.id)) return
    watching.current.add(job.id)
    const signal = watchAbort.current?.signal
    clearHideTimer(id)
    expandRow(id)
    try {
      const done = await watchJob(job.id, (j) => patchSync(id, () => syncStateOf(j)), signal)
      if (done.status === "succeeded") scheduleHide(id)
      refresh()
    } catch (e) {
      if (isAbort(e, signal)) return
      patchSync(id, (prev) => ({
        ...prev,
        running: false,
        finalOk: false,
        latest: {
          stage: "error",
          message: `查不到任务进度：${(e as Error).message}。任务仍在后台运行，可到“后台任务”页查看结果`,
          time: new Date().toISOString(),
        },
      }))
    } finally {
      watching.current.delete(job.id)
    }
  }

  async function syncChannel(channel: Channel) {
    clearHideTimer(channel.id)
    patchSync(channel.id, () => ({ running: true, events: [], latest: null, finalOk: null }))
    expandRow(channel.id)
    try {
      const { job, started } = await startJob(`/channels/${channel.id}/sync`)
      if (!started) Toast.info(`${channel.name} 已有任务在跑（${job.title}），显示它的进度`)
      await followChannelJob(job)
    } catch (e) {
      patchSync(channel.id, (prev) => ({
        ...prev,
        running: false,
        finalOk: false,
        latest: {
          stage: "error",
          message: (e as Error).message || "同步失败",
          time: new Date().toISOString(),
        },
      }))
    }
  }

  /** 全部同步的事件带渠道和序号，按渠道拆开显示在各行；每个渠道最后一条是结论。 */
  function applyBulkJob(job: BackgroundJob) {
    const byChannel = new Map<number, ProgressEvent[]>()
    let total = 0
    for (const ev of job.events ?? []) {
      if (!ev.channel_id) continue
      total = ev.total ?? total
      byChannel.set(ev.channel_id, [...(byChannel.get(ev.channel_id) ?? []), ev])
    }
    const running = job.status === "running"
    const states: Record<number, ChannelSyncState> = {}
    let completed = 0
    for (const [id, events] of byChannel) {
      const last = events[events.length - 1]
      const finished = last.stage === "done" || last.stage === "error" || last.stage === "skipped"
      if (finished) completed++
      if (finished || running) {
        states[id] = { running: !finished, events, latest: last, finalOk: finished ? last.stage !== "error" : null }
      } else {
        // 任务已结束但这个渠道没出结论（服务停止时正在跑）
        const final: ProgressEvent = { stage: "error", message: job.message || "失败", time: job.finished_at ?? job.started_at }
        states[id] = { running: false, events: [...events, final], latest: final, finalOk: false }
      }
    }
    setSyncState((s) => ({ ...s, ...states }))
    setBulkSync((prev) => ({ running, completed, total: total || prev.total }))
  }

  async function followBulkJob(job: BackgroundJob) {
    if (watching.current.has(job.id)) return
    watching.current.add(job.id)
    const signal = watchAbort.current?.signal
    setBulkSync((prev) => ({ ...prev, running: true }))
    try {
      const done = await watchJob(job.id, applyBulkJob, signal)
      if (done.status === "succeeded") Toast.success(done.message || "全部同步完成")
      else Toast.error(done.message || "全部同步失败")
      // 成功和跳过的行 5 秒后收起，失败的留着
      const lastByChannel = new Map<number, ProgressEvent>()
      for (const ev of done.events ?? []) if (ev.channel_id) lastByChannel.set(ev.channel_id, ev)
      for (const [id, ev] of lastByChannel) if (ev.stage === "done" || ev.stage === "skipped") scheduleHide(id)
      refresh()
    } catch (e) {
      if (isAbort(e, signal)) return
      Toast.error(`查不到全部同步的进度：${(e as Error).message}。任务仍在后台运行，可到“后台任务”页查看结果`)
    } finally {
      watching.current.delete(job.id)
      if (!signal?.aborted) setBulkSync((prev) => ({ ...prev, running: false }))
    }
  }

  async function startBulkSync() {
    const list = channels ?? []
    if (list.length === 0) return
    for (const c of list) clearHideTimer(c.id)
    setBulkSync({ running: true, completed: 0, total: list.length })
    try {
      const { job, started } = await startJob("/channels/sync-all")
      if (!started) Toast.info("全部同步已经在跑，显示它的进度")
      await followBulkJob(job)
    } catch (e) {
      Toast.error((e as Error).message || "全部同步失败")
      setBulkSync((prev) => ({ ...prev, running: false }))
    }
  }

  async function withBusy(key: string, fn: () => Promise<unknown>) {
    setBusyAction(key)
    try {
      await fn()
      refresh()
    } catch (e) {
      Toast.error((e as Error).message || "操作失败")
    } finally {
      setBusyAction(null)
    }
  }

  function openForm(c: Channel | null) {
    setEditing(c)
    setFormOpen(true)
  }

  async function toggleMonitor(c: Channel) {
    await withBusy(`toggle-${c.id}`, () => apiFetch(`/channels/${c.id}/${c.monitor_enabled ? "disable" : "enable"}`, { method: "POST" }))
  }

  async function clearLoginInfo(c: Channel) {
    const ok = await confirm({
      title: `清空 ${c.name} 的登录信息？`,
      description: "会清空缓存的会话；Token 模式还会清空保存的 Access Token、Refresh Token 和 NewAPI Cookie。账号密码本身不删。",
      confirmLabel: "清空",
      destructive: true,
    })
    if (!ok) return
    await withBusy(`clear-login-${c.id}`, async () => {
      await apiFetch(`/channels/${c.id}/clear-login-info`, { method: "POST" })
      Toast.success("已清空登录信息")
    })
  }

  async function deleteChannel(c: Channel) {
    const ok = await confirm({
      title: `删除渠道 ${c.name}？`,
      description: "这个渠道的余额历史、倍率快照和登录凭据会一起删除，无法恢复。",
      confirmLabel: "删除",
      destructive: true,
    })
    if (!ok) return
    await withBusy(`delete-${c.id}`, () => apiFetch(`/channels/${c.id}`, { method: "DELETE" }))
  }

  const onAPIKeyAction: APIKeyAction = (channel, rate, type) => {
    setAPIKeySheet({
      channel,
      initialAction: { type, targetGroup: { id: rate.remote_group_id ?? null, name: rate.model_name } },
    })
  }

  function actionsFor(c: Channel, compact: boolean) {
    const syncing = !!syncState[c.id]?.running
    const disabled = syncing || anySyncRunning
    const busy = busyAction?.endsWith(`-${c.id}`) ?? false
    const button = (key: string, label: string, icon: ReactNode, onClick: () => void, opts: { disabled?: boolean; loading?: boolean } = {}) =>
      compact ? (
        <Button key={key} size="small" icon={icon} disabled={opts.disabled} loading={opts.loading} onClick={onClick}>
          {label}
        </Button>
      ) : (
        <Tooltip key={key} content={label}>
          <Button theme="borderless" size="small" icon={icon} disabled={opts.disabled} loading={opts.loading} onClick={onClick} aria-label={label} />
        </Tooltip>
      )
    return [
      button("sync", "同步", <IconRefresh spin={syncing} />, () => void syncChannel(c), { disabled }),
      button("keys", "密钥", <IconKey />, () => setAPIKeySheet({ channel: c })),
      button("edit", "编辑", <IconEdit />, () => openForm(c)),
      <Dropdown
        key="more"
        position="bottomRight"
        trigger="click"
        clickToHide
        render={
          <Dropdown.Menu>
            <Dropdown.Item icon={<IconCreditCard />} onClick={() => setRecharging(c)}>
              充值
            </Dropdown.Item>
            <Dropdown.Item icon={<IconGift />} onClick={() => setRedeeming(c)}>
              兑换码
            </Dropdown.Item>
            <Dropdown.Item icon={<IconExternalOpen />} onClick={() => window.open(c.site_url, "_blank", "noopener,noreferrer")}>
              打开站点
            </Dropdown.Item>
            <Dropdown.Item icon={c.monitor_enabled ? <IconPause /> : <IconPlay />} onClick={() => void toggleMonitor(c)}>
              {c.monitor_enabled ? "暂停监控" : "恢复监控"}
            </Dropdown.Item>
            <Dropdown.Divider />
            <Dropdown.Item icon={<IconClear />} onClick={() => void clearLoginInfo(c)}>
              清空登录信息
            </Dropdown.Item>
            <Dropdown.Item icon={<IconDelete />} type="danger" onClick={() => void deleteChannel(c)}>
              删除
            </Dropdown.Item>
          </Dropdown.Menu>
        }
      >
        {compact ? (
          <Button size="small" icon={<IconMore />} loading={busy}>
            更多
          </Button>
        ) : (
          <Button theme="borderless" size="small" icon={<IconMore />} loading={busy} aria-label="更多操作" />
        )}
      </Dropdown>,
    ]
  }

  function expandedContent(c: Channel) {
    const state = syncState[c.id]
    return (
      <div className="stack" style={{ gap: 12, padding: "4px 0" }}>
        {state ? <SyncProgress state={state} /> : null}
        {c.last_error ? (
          <Banner fullMode={false} type="danger" closeIcon={null} title="最近一次报错" description={<span className="pre-wrap">{c.last_error}</span>} />
        ) : null}
        {c.notes ? (
          <div>
            <Typography.Text type="tertiary" size="small">
              备注
            </Typography.Text>
            <Typography.Paragraph className="pre-wrap" style={{ margin: 0 }}>
              {c.notes}
            </Typography.Paragraph>
          </div>
        ) : null}
        <ChannelRatesTable channel={c} onAPIKeyAction={onAPIKeyAction} />
      </div>
    )
  }

  const columns: ColumnProps<Channel>[] = [
    {
      title: "渠道",
      dataIndex: "name",
      width: 260,
      render: (_: unknown, c: Channel) => (
        <div className="stack" style={{ gap: 2 }}>
          <Typography.Text strong ellipsis={{ showTooltip: true }}>
            {c.name}
          </Typography.Text>
          {/* 账号参与搜索和“账号 A→Z”排序，显示出来才看得出命中和排序依据；token 模式常为空 */}
          {c.username.trim() ? (
            <Typography.Text type="tertiary" size="small" icon={<IconUser size="small" />} ellipsis={{ showTooltip: true }}>
              {c.username}
            </Typography.Text>
          ) : null}
          {c.tags?.length ? (
            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              {c.tags.map((tag) => (
                <Tag key={tag} size="small" color="white">
                  {tag}
                </Tag>
              ))}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: "类型",
      dataIndex: "type",
      width: 100,
      render: (v: Channel["type"]) => <Tag color={v === "newapi" ? "violet" : "light-blue"}>{channelTypeLabel(v)}</Tag>,
    },
    {
      title: "余额",
      dataIndex: "last_balance",
      width: 140,
      render: (_: unknown, c: Channel) => (
        <div className="stack" style={{ gap: 2 }}>
          <Tooltip content={rechargeMultiplierTip(c)}>
            <Typography.Text strong className="num">
              {money(c.last_balance)}
            </Typography.Text>
          </Tooltip>
          <Typography.Text type="tertiary" size="small">
            {c.balance_threshold > 0 ? `低于 ${money(c.balance_threshold)} 告警` : "不告警"}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "今日 / 累计消费",
      key: "cost",
      width: 150,
      render: (_: unknown, c: Channel) => (
        <div className="stack num" style={{ gap: 2 }}>
          <Typography.Text>{money(c.today_cost)}</Typography.Text>
          <Typography.Text type="tertiary" size="small">
            累计 {money(c.total_cost)}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 150,
      render: (_: unknown, c: Channel) => <ChannelStatusTags channel={c} sync={syncState[c.id]} />,
    },
    {
      title: "更新",
      key: "updated",
      width: 110,
      render: (_: unknown, c: Channel) => {
        const at = c.last_balance_at ?? c.updated_at
        return (
          <Tooltip content={fullDateTime(at)}>
            <Typography.Text type="tertiary" size="small">
              {relativeTime(at)}
            </Typography.Text>
          </Tooltip>
        )
      },
    },
    {
      title: "操作",
      key: "actions",
      width: 200,
      fixed: "right",
      render: (_: unknown, c: Channel) => <div className="row" style={{ gap: 0 }}>{actionsFor(c, false)}</div>,
    },
  ]

  const countText = filtersActive
    ? `筛选出 ${countsReady ? totalChannels : pageError ? "-" : "…"} 个 / 共 ${channels?.length ?? "-"} 个渠道`
    : `${channels?.length ?? (countsReady ? totalChannels : "-")} 个渠道`

  let body: ReactNode
  if (channels?.length === 0) {
    // “还没有任何渠道”只看全量列表：分页结果可能还是上一组筛选条件的
    body = (
      <Card>
        <Empty
          image={<IllustrationNoContent style={{ width: 150, height: 150 }} />}
          darkModeImage={<IllustrationNoContentDark style={{ width: 150, height: 150 }} />}
          title="还没有任何渠道"
          description="添加一个上游账号，开启监控后会按计划自动登录、采集余额和倍率。"
        >
          <Button theme="solid" icon={<IconPlus />} onClick={() => openForm(null)}>
            添加第一个渠道
          </Button>
        </Empty>
      </Card>
    )
  } else if (pageError && (!channelPage || pageStale)) {
    body = (
      <Card>
        <Empty title="渠道列表加载失败" description={pageError}>
          <Button icon={<IconRefresh />} onClick={pageQuery.refetch}>
            重试
          </Button>
        </Empty>
      </Card>
    )
  } else if (countsReady && totalChannels === 0 && filtersActive) {
    body = (
      <Card>
        <Empty
          image={<IllustrationNoResult style={{ width: 150, height: 150 }} />}
          darkModeImage={<IllustrationNoResultDark style={{ width: 150, height: 150 }} />}
          title="没有匹配的渠道"
        >
          <Button icon={<IconFilter />} onClick={clearFilters}>
            清除筛选
          </Button>
        </Empty>
      </Card>
    )
  } else {
    // 未筛选却是 0 个而全量列表不为空（或还没到）：两次响应暂时不一致，当作加载中
    const loading = !channelPage || (!countsReady && visibleChannels.length === 0) || (countsReady && totalChannels === 0 && !filtersActive)
    const list = isMobile ? (
      <div className="stack" style={{ gap: 12 }}>
        {loading ? (
          <Card loading />
        ) : (
          visibleChannels.map((c) => (
            <ChannelCard
              key={c.id}
              channel={c}
              sync={syncState[c.id]}
              actions={actionsFor(c, true)}
              expanded={expandedKeys.includes(c.id)}
              onToggle={() => setExpandedKeys((keys) => (keys.includes(c.id) ? keys.filter((k) => k !== c.id) : [...keys, c.id]))}
              expandedContent={expandedContent(c)}
            />
          ))
        )}
      </div>
    ) : (
      <Card bodyStyle={{ padding: 0 }}>
        <Table<Channel>
          rowKey="id"
          columns={columns}
          dataSource={loading ? [] : visibleChannels}
          loading={loading}
          scroll={{ x: 1160 }}
          pagination={false}
          // 展开按钮单独占一列；默认塞进第一列时会被多行的渠道信息挤到上面
          hideExpandedColumn={false}
          expandedRowKeys={expandedKeys}
          onExpand={(expanded, record) => {
            const id = (record as Channel | undefined)?.id
            if (id == null) return
            setExpandedKeys((keys) => (expanded ? [...keys, id] : keys.filter((k) => k !== id)))
          }}
          expandedRowRender={(c?: Channel) => (c ? expandedContent(c) : null)}
          rowExpandable={() => true}
        />
      </Card>
    )
    body = (
      // 新条件的结果到达前先显示旧列表并变暗
      <div className="stack" style={{ gap: 12, opacity: pageStale ? 0.6 : 1, transition: "opacity .2s ease .15s" }} aria-busy={pageStale}>
        {list}
        <div className="row-between" style={{ flexWrap: "wrap" }}>
          <Typography.Text type="tertiary" size="small">
            {!countsReady
              ? "加载中…"
              : pageSizeAll
                ? `显示全部 ${totalChannels} 个渠道`
                : `第 ${currentPage}/${totalPages} 页，共 ${totalChannels} 个渠道`}
          </Typography.Text>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {!pageSizeAll && countsReady && totalPages > 1 ? (
              <Pagination
                size={isMobile ? "small" : "default"}
                currentPage={currentPage}
                pageSize={pageSize as number}
                total={totalChannels}
                onPageChange={setPage}
              />
            ) : null}
            <Select
              size="small"
              value={String(pageSize)}
              onChange={(v) => {
                const next = pageSizeOptions.find((o) => String(o) === v) ?? DEFAULT_PAGE_SIZE
                setPageSize(next)
                saveStored(PAGE_SIZE_STORAGE_KEY, next)
                setPage(1)
              }}
              style={{ width: 130 }}
              optionList={pageSizeOptions.map((o) => ({ value: String(o), label: o === "all" ? "全部显示" : `每页 ${o} 个` }))}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader
        title="渠道"
        description={countText}
        actions={
          <>
            <Button icon={<IconList />} disabled={channelsLoading || !channels?.length} onClick={() => setGroupsOpen(true)}>
              全部分组
            </Button>
            <Button icon={<IconRefresh spin={bulkSync.running} />} disabled={anySyncRunning || !channels?.length} onClick={() => void startBulkSync()}>
              {bulkSync.running ? `同步中 ${bulkSync.completed}/${bulkSync.total}` : "全部同步"}
            </Button>
            <Button theme="solid" icon={<IconPlus />} onClick={() => openForm(null)}>
              新增渠道
            </Button>
          </>
        }
      />

      {filtersActive || channels == null || channels.length > 0 ? (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <Input
            prefix={<IconSearch />}
            value={searchInput}
            onChange={setSearchInput}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(e) => {
              // 以确认后的文字为准；各浏览器 compositionend 与最后一次 input 的先后不同
              setComposing(false)
              setSearchInput(e.currentTarget.value)
            }}
            maxLength={MAX_SEARCH_LENGTH}
            showClear
            placeholder="搜索名称、账号、站点、备注或标签"
            aria-label="搜索渠道"
            style={{ flex: "1 1 260px", minWidth: 200 }}
          />
          <Select
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v as ChannelStatusFilter)
              setPage(1)
            }}
            optionList={statusFilterOptions}
            style={{ width: 130 }}
            aria-label="按状态筛选"
          />
          {tagOptions.length > 0 ? (
            <Select
              value={activeTag || undefined}
              onChange={(v) => {
                setTagFilter((v as string | undefined) ?? "")
                setPage(1)
              }}
              placeholder="全部标签"
              showClear
              filter
              optionList={tagOptions.map((t) => ({ value: t, label: t }))}
              style={{ width: 150 }}
              aria-label="按标签筛选"
            />
          ) : null}
          <Select
            value={sortMode}
            onChange={(v) => {
              const next = (v as ChannelSortMode) ?? "default"
              setSortMode(next)
              saveStored(SORT_STORAGE_KEY, next)
              setPage(1)
            }}
            optionList={sortOptions.map((o) => ({ value: o.value, label: o.label }))}
            style={{ width: 180 }}
            aria-label="排序方式"
          />
          {filtersActive ? (
            <Button theme="borderless" icon={<IconFilter />} onClick={clearFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>
      ) : null}

      {body}

      <ChannelFormModal visible={formOpen} onClose={() => setFormOpen(false)} channel={editing} />
      <AllGroupsModal visible={groupsOpen} onClose={() => setGroupsOpen(false)} channels={channels ?? []} onAPIKeyAction={onAPIKeyAction} />
      <ChannelRedeemModal channel={redeeming} onClose={() => setRedeeming(null)} />
      <ChannelRechargeModal channel={recharging} onClose={() => setRecharging(null)} />
      <ChannelAPIKeysSheet channel={apiKeySheet?.channel ?? null} initialAction={apiKeySheet?.initialAction} onClose={() => setAPIKeySheet(null)} />
    </div>
  )
}

/** 窄屏下的渠道卡片：字段和操作与表格一致，分组倍率点开再看。 */
function ChannelCard({ channel: c, sync, actions, expanded, onToggle, expandedContent }: {
  channel: Channel
  sync?: ChannelSyncState
  actions: ReactNode[]
  expanded: boolean
  onToggle: () => void
  expandedContent: ReactNode
}) {
  const at = c.last_balance_at ?? c.updated_at
  return (
    <Card bodyStyle={{ padding: 12 }}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row-between" style={{ alignItems: "flex-start" }}>
          <div className="stack" style={{ gap: 2, minWidth: 0 }}>
            <div className="row" style={{ gap: 6, minWidth: 0 }}>
              <Typography.Text strong ellipsis={{ showTooltip: true }} style={{ minWidth: 0 }}>
                {c.name}
              </Typography.Text>
              <Tag size="small" color={c.type === "newapi" ? "violet" : "light-blue"} style={{ flexShrink: 0 }}>
                {channelTypeLabel(c.type)}
              </Tag>
            </div>
            {c.username.trim() ? (
              <Typography.Text type="tertiary" size="small" ellipsis={{ showTooltip: true }}>
                {c.username}
              </Typography.Text>
            ) : null}
          </div>
          {/* 名字再长也只截名字，状态标签保持完整 */}
          <div style={{ flexShrink: 0 }}>
            <ChannelStatusTags channel={c} sync={sync} />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          <Stat label="余额" value={money(c.last_balance)} />
          <Stat label="今日消费" value={money(c.today_cost)} />
          <Stat label="累计消费" value={money(c.total_cost)} />
        </div>

        {c.tags?.length ? (
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            {c.tags.map((tag) => (
              <Tag key={tag} size="small" color="white">
                {tag}
              </Tag>
            ))}
          </div>
        ) : null}

        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {actions}
        </div>

        <div className="row-between">
          <Typography.Text type="tertiary" size="small">
            更新于 {relativeTime(at)}
          </Typography.Text>
          <Button theme="borderless" size="small" onClick={onToggle}>
            {expanded ? "收起详情" : c.last_error ? "详情（有报错）" : "分组与详情"}
          </Button>
        </div>
        {expanded ? expandedContent : sync ? <SyncProgress state={sync} /> : null}
      </div>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "6px 8px", borderRadius: 6, background: "var(--semi-color-fill-0)", minWidth: 0 }}>
      <Typography.Text type="tertiary" size="small" style={{ display: "block" }}>
        {label}
      </Typography.Text>
      <Typography.Text strong className="num truncate" style={{ display: "block" }}>
        {value}
      </Typography.Text>
    </div>
  )
}
