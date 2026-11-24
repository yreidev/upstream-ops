import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Alert,
  Button,
  Card,
  Chip,
  Disclosure,
  Dropdown,
  EmptyState,
  Label,
  ListBox,
  SearchField,
  Select,
  Separator,
  Spinner,
  Surface,
  Tag,
  TagGroup,
  Tooltip,
  toast,
} from "@heroui/react"
import {
  ArrowUpRightFromSquare,
  ArrowsRotateRight,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Ellipsis,
  Eraser,
  Key,
  ListUl,
  Pause,
  Pencil,
  Play,
  Plus,
  Server,
  Sliders,
  Ticket,
  TrashBin,
} from "@gravity-ui/icons"
import { PageHeader } from "@/components/layout/page-header"
import { PaginationBar } from "@/components/common/pagination-bar"
import { AllGroupsModal } from "@/components/channels/all-groups-modal"
import { ChannelAPIKeysSheet, type ChannelAPIKeyInitialAction } from "@/components/channels/channel-api-keys-sheet"
import { ChannelFormModal } from "@/components/channels/channel-form-modal"
import { ChannelGroupsSheet } from "@/components/channels/channel-groups-sheet"
import {
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
import type {
  BackgroundJob,
  Channel,
  ChannelListOrder,
  ChannelListSort,
  ChannelListStatus,
  ProgressEvent,
} from "@/lib/api-types"
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

const DESKTOP_GRID = "grid grid-cols-[24px_minmax(136px,1.4fr)_70px_104px_104px_80px_60px_170px] items-center gap-1.5"

/** 渠道列表：搜索、筛选、排序和分页都在后端做，跨页结果才准确。 */
export default function ChannelsPage() {
  const isMobile = useIsMobile()
  const { data: channels, loading: channelsLoading } = useChannels()
  const refresh = useTriggerRefresh()

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<ChannelPageSize>(() =>
    loadStored(PAGE_SIZE_STORAGE_KEY, pageSizeOptions, DEFAULT_PAGE_SIZE),
  )
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
  const [groupsOf, setGroupsOf] = useState<Channel | null>(null)
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

  function toggleRow(id: number) {
    setExpandedKeys((keys) => (keys.includes(id) ? keys.filter((k) => k !== id) : [...keys, id]))
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
      if (!started) toast.info(`${channel.name} 已有任务在跑（${job.title}），显示它的进度`)
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
      if (done.status === "succeeded") toast.success(done.message || "全部同步完成")
      else toast.danger(done.message || "全部同步失败")
      // 成功和跳过的行 5 秒后收起，失败的留着
      const lastByChannel = new Map<number, ProgressEvent>()
      for (const ev of done.events ?? []) if (ev.channel_id) lastByChannel.set(ev.channel_id, ev)
      for (const [id, ev] of lastByChannel) if (ev.stage === "done" || ev.stage === "skipped") scheduleHide(id)
      refresh()
    } catch (e) {
      if (isAbort(e, signal)) return
      toast.danger(`查不到全部同步的进度：${(e as Error).message}。任务仍在后台运行，可到“后台任务”页查看结果`)
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
      if (!started) toast.info("全部同步已经在跑，显示它的进度")
      await followBulkJob(job)
    } catch (e) {
      toast.danger((e as Error).message || "全部同步失败")
      setBulkSync((prev) => ({ ...prev, running: false }))
    }
  }

  async function withBusy(key: string, fn: () => Promise<unknown>) {
    setBusyAction(key)
    try {
      await fn()
      refresh()
    } catch (e) {
      toast.danger((e as Error).message || "操作失败")
    } finally {
      setBusyAction(null)
    }
  }

  function openForm(c: Channel | null) {
    setEditing(c)
    setFormOpen(true)
  }

  async function toggleMonitor(c: Channel) {
    await withBusy(`toggle-${c.id}`, () =>
      apiFetch(`/channels/${c.id}/${c.monitor_enabled ? "disable" : "enable"}`, { method: "POST" }),
    )
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
      toast.success("已清空登录信息")
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

    const actionButton = (
      key: string,
      label: string,
      icon: ReactNode,
      onPress: () => void,
      opts: { disabled?: boolean } = {},
    ) =>
      compact ? (
        <Button key={key} size="sm" variant="tertiary" isDisabled={opts.disabled} onPress={onPress}>
          {icon}
          {label}
        </Button>
      ) : (
        <Tooltip key={key}>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            isDisabled={opts.disabled}
            onPress={onPress}
            aria-label={label}
          >
            {icon}
          </Button>
          <Tooltip.Content>{label}</Tooltip.Content>
        </Tooltip>
      )

    return [
      actionButton(
        "sync",
        "同步",
        <ArrowsRotateRight className={`size-4 ${syncing ? "animate-spin" : ""}`} />,
        () => void syncChannel(c),
        { disabled },
      ),
      actionButton("groups", "分组", <ListUl className="size-4" />, () => setGroupsOf(c)),
      actionButton("keys", "密钥", <Key className="size-4" />, () => setAPIKeySheet({ channel: c })),
      actionButton("edit", "编辑", <Pencil className="size-4" />, () => openForm(c)),
      <Dropdown key="more">
        {compact ? (
          <Button size="sm" variant="tertiary" isPending={busy}>
            {busy ? <Spinner size="sm" color="current" /> : <Ellipsis className="size-4" />}
            更多
          </Button>
        ) : (
          <Button isIconOnly variant="ghost" size="sm" isPending={busy} aria-label="更多操作">
            {busy ? <Spinner size="sm" color="current" /> : <Ellipsis className="size-4" />}
          </Button>
        )}
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={`${c.name} 更多操作`}
            onAction={(key) => {
              switch (key) {
                case "recharge":
                  setRecharging(c)
                  break
                case "redeem":
                  setRedeeming(c)
                  break
                case "open-site":
                  window.open(c.site_url, "_blank", "noopener,noreferrer")
                  break
                case "toggle-monitor":
                  void toggleMonitor(c)
                  break
                case "clear-login":
                  void clearLoginInfo(c)
                  break
                case "delete":
                  void deleteChannel(c)
                  break
              }
            }}
          >
            <Dropdown.Item id="recharge" textValue="充值">
              <CreditCard className="size-4" />
              <Label>充值</Label>
            </Dropdown.Item>
            <Dropdown.Item id="redeem" textValue="兑换码">
              <Ticket className="size-4" />
              <Label>兑换码</Label>
            </Dropdown.Item>
            <Dropdown.Item id="open-site" textValue="打开站点">
              <ArrowUpRightFromSquare className="size-4" />
              <Label>打开站点</Label>
            </Dropdown.Item>
            <Dropdown.Item id="toggle-monitor" textValue={c.monitor_enabled ? "暂停监控" : "恢复监控"}>
              {c.monitor_enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
              <Label>{c.monitor_enabled ? "暂停监控" : "恢复监控"}</Label>
            </Dropdown.Item>
            <Separator />
            <Dropdown.Item id="clear-login" textValue="清空登录信息">
              <Eraser className="size-4" />
              <Label>清空登录信息</Label>
            </Dropdown.Item>
            <Dropdown.Item id="delete" textValue="删除" variant="danger">
              <TrashBin className="size-4" />
              <Label>删除</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>,
    ]
  }

  function expandedContent(c: Channel) {
    const state = syncState[c.id]
    return (
      <div className="stack gap-3">
        {state ? <SyncProgress state={state} /> : null}
        {c.last_error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>最近一次报错</Alert.Title>
              <Alert.Description className="pre-wrap">{c.last_error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        {c.notes ? (
          <div className="stack gap-0.5">
            <span className="text-xs text-muted">备注</span>
            <p className="pre-wrap m-0 text-sm text-foreground">{c.notes}</p>
          </div>
        ) : null}
      </div>
    )
  }

  const countText = filtersActive
    ? `筛选出 ${countsReady ? totalChannels : pageError ? "-" : "…"} 个 / 共 ${channels?.length ?? "-"} 个渠道`
    : `${channels?.length ?? (countsReady ? totalChannels : "-")} 个渠道`

  let body: ReactNode
  if (channels?.length === 0) {
    // “还没有任何渠道”只看全量列表：分页结果可能还是上一组筛选条件的
    body = (
      <Card className="rounded-2xl py-12">
        <EmptyState className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-surface-secondary text-muted">
            <Server className="size-6" />
          </div>
          <div className="text-base font-semibold text-foreground">还没有任何渠道</div>
          <div className="max-w-sm text-sm text-muted">
            添加一个上游账号，开启监控后会按计划自动登录、采集余额和倍率。
          </div>
          <Button variant="primary" onPress={() => openForm(null)} className="mt-1">
            <Plus className="size-4" />
            添加第一个渠道
          </Button>
        </EmptyState>
      </Card>
    )
  } else if (pageError && (!channelPage || pageStale)) {
    body = (
      <Card className="rounded-2xl py-12">
        <EmptyState className="flex flex-col items-center gap-3 text-center">
          <div className="text-base font-semibold text-foreground">渠道列表加载失败</div>
          <div className="text-sm text-muted">{pageError}</div>
          <Button variant="secondary" onPress={pageQuery.refetch}>
            <ArrowsRotateRight className="size-4" />
            重试
          </Button>
        </EmptyState>
      </Card>
    )
  } else if (countsReady && totalChannels === 0 && filtersActive) {
    body = (
      <Card className="rounded-2xl py-12">
        <EmptyState className="flex flex-col items-center gap-3 text-center">
          <div className="text-base font-semibold text-foreground">没有匹配的渠道</div>
          <Button variant="secondary" onPress={clearFilters}>
            <Sliders className="size-4" />
            清除筛选
          </Button>
        </EmptyState>
      </Card>
    )
  } else {
    // 未筛选却是 0 个而全量列表不为空（或还没到）：两次响应暂时不一致，当作加载中
    const loading =
      !channelPage || (!countsReady && visibleChannels.length === 0) || (countsReady && totalChannels === 0 && !filtersActive)

    const list = isMobile ? (
      <div className="stack gap-3">
        {loading ? (
          <Card className="flex justify-center rounded-2xl py-12">
            <Spinner />
          </Card>
        ) : (
          visibleChannels.map((c) => (
            <ChannelCard
              key={c.id}
              channel={c}
              sync={syncState[c.id]}
              actions={actionsFor(c, true)}
              expanded={expandedKeys.includes(c.id)}
              onToggle={() => toggleRow(c.id)}
              expandedContent={expandedContent(c)}
            />
          ))
        )}
      </div>
    ) : (
      <div className="expandable-table">
        {loading ? (
          <div className="expandable-table__body flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <div className="expandable-table__scroll">
            <div className="min-w-[830px]">
              <div className={`${DESKTOP_GRID} expandable-table__header`}>
                <span />
                <span>渠道</span>
                <span>类型</span>
                <span>余额</span>
                <span>今日 / 累计消费</span>
                <span>状态</span>
                <span>更新</span>
                <span>操作</span>
              </div>
              <div className="expandable-table__body list-rows">
                {visibleChannels.map((c) => {
                  const expandable = hasDetails(c, syncState[c.id])
                  const expanded = expandable && expandedKeys.includes(c.id)
                  const at = c.last_balance_at ?? c.updated_at

                  return (
                    <div key={c.id}>
                      <div className={`${DESKTOP_GRID} px-3.5 py-3 transition-colors hover:bg-default/40`}>
                        <div className="flex justify-center">
                          {expandable ? (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={expanded ? "收起详情" : "展开详情"}
                              aria-expanded={expanded}
                              className="size-7 min-w-0 text-muted"
                              onPress={() => toggleRow(c.id)}
                            >
                              {expanded ? (
                                <ChevronDown className="size-4" />
                              ) : (
                                <ChevronRight className="size-4" />
                              )}
                            </Button>
                          ) : null}
                        </div>

                        <div className="stack min-w-0 gap-0.5">
                          <span className="truncate text-sm font-semibold text-foreground" title={c.name}>
                            {c.name}
                          </span>
                          {/* 账号参与搜索和“账号 A→Z”排序，显示出来才看得出命中和排序依据；token 模式常为空 */}
                          {c.username.trim() ? (
                            <span className="truncate text-xs text-muted" title={c.username}>
                              {c.username}
                            </span>
                          ) : null}
                          {c.tags?.length ? (
                            <TagGroup aria-label={`${c.name} 标签`} size="sm" className="mt-0.5">
                              <TagGroup.List>
                                {c.tags.map((tag) => (
                                  <Tag key={tag} id={tag} textValue={tag}>
                                    {tag}
                                  </Tag>
                                ))}
                              </TagGroup.List>
                            </TagGroup>
                          ) : null}
                        </div>

                        <div>
                          <Chip color={c.type === "newapi" ? "accent" : "default"} variant="soft" size="sm">
                            {channelTypeLabel(c.type)}
                          </Chip>
                        </div>

                        <div className="stack gap-0.5">
                          <Tooltip>
                            <Tooltip.Trigger className="inline-flex w-fit">
                              <span className="num text-sm font-semibold text-foreground">
                                {money(c.last_balance)}
                              </span>
                            </Tooltip.Trigger>
                            <Tooltip.Content>{rechargeMultiplierTip(c)}</Tooltip.Content>
                          </Tooltip>
                          <span className="text-xs text-muted">
                            {c.balance_threshold > 0 ? `低于 ${money(c.balance_threshold)} 告警` : "不告警"}
                          </span>
                        </div>

                        <div className="stack num gap-0.5">
                          <span className="text-sm text-foreground">{money(c.today_cost)}</span>
                          <span className="text-xs text-muted">累计 {money(c.total_cost)}</span>
                        </div>

                        <div>
                          <ChannelStatusTags channel={c} sync={syncState[c.id]} />
                        </div>

                        <div>
                          <Tooltip>
                            <Tooltip.Trigger className="inline-flex">
                              <span className="text-xs text-muted">{relativeTime(at)}</span>
                            </Tooltip.Trigger>
                            <Tooltip.Content>{fullDateTime(at)}</Tooltip.Content>
                          </Tooltip>
                        </div>

                        <div className="row flex-nowrap gap-0.5">{actionsFor(c, false)}</div>
                      </div>

                      {expandable ? (
                        <Disclosure isExpanded={expanded}>
                          <Disclosure.Content>
                            <Disclosure.Body className="border-t border-separator/70 bg-surface-secondary/45 px-4 py-3 pl-11">
                              {expandedContent(c)}
                            </Disclosure.Body>
                          </Disclosure.Content>
                        </Disclosure>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    )

    body = (
      // 新条件的结果到达前先显示旧列表并变暗
      <div
        className={`stack gap-3 transition-opacity duration-200 ${pageStale ? "opacity-60" : "opacity-100"}`}
        aria-busy={pageStale}
      >
        {list}
        <div className="row-between flex-wrap gap-3">
          <span className="num text-xs text-muted">
            {!countsReady
              ? "加载中…"
              : pageSizeAll
                ? `显示全部 ${totalChannels} 个渠道`
                : `第 ${currentPage}/${totalPages} 页，共 ${totalChannels} 个渠道`}
          </span>
          <div className="row flex-wrap gap-2">
            {!pageSizeAll && countsReady && totalPages > 1 ? (
              <div className="w-auto">
                <PaginationBar
                  page={currentPage}
                  total={totalChannels}
                  pageSize={pageSize as number}
                  onChange={setPage}
                  compact={isMobile}
                />
              </div>
            ) : null}
            <Select
              aria-label="每页显示数量"
              value={String(pageSize)}
              onChange={(k) => {
                if (k == null) return
                const next = pageSizeOptions.find((o) => String(o) === String(k)) ?? DEFAULT_PAGE_SIZE
                setPageSize(next)
                saveStored(PAGE_SIZE_STORAGE_KEY, next)
                setPage(1)
              }}
              className="w-32"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {pageSizeOptions.map((o) => {
                    const label = o === "all" ? "全部显示" : `每页 ${o} 个`
                    return (
                      <ListBox.Item key={String(o)} id={String(o)} textValue={label}>
                        {label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    )
                  })}
                </ListBox>
              </Select.Popover>
            </Select>
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
            <Button
              variant="tertiary"
              size="sm"
              isDisabled={channelsLoading || !channels?.length}
              onPress={() => setGroupsOpen(true)}
            >
              <ListUl className="size-4" />
              全部分组
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              isDisabled={anySyncRunning || !channels?.length}
              onPress={() => void startBulkSync()}
            >
              <ArrowsRotateRight className={`size-4 ${bulkSync.running ? "animate-spin" : ""}`} />
              {bulkSync.running ? `同步中 ${bulkSync.completed}/${bulkSync.total}` : "全部同步"}
            </Button>
            <Button variant="primary" size="sm" onPress={() => openForm(null)}>
              <Plus className="size-4" />
              新增渠道
            </Button>
          </>
        }
      />

      {filtersActive || channels == null || channels.length > 0 ? (
        <div className="row flex-wrap gap-2">
          <SearchField
            aria-label="搜索渠道"
            value={searchInput}
            onChange={setSearchInput}
            className="min-w-[200px] flex-1 basis-[260px]"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input
                maxLength={MAX_SEARCH_LENGTH}
                placeholder="搜索名称、账号、站点、备注或标签"
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={(e) => {
                  // 以确认后的文字为准；各浏览器 compositionend 与最后一次 input 的先后不同
                  setComposing(false)
                  setSearchInput(e.currentTarget.value)
                }}
              />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>

          <Select
            aria-label="按状态筛选"
            value={statusFilter}
            onChange={(k) => {
              if (k != null) {
                setStatusFilter(String(k) as ChannelStatusFilter)
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
                {statusFilterOptions.map((o) => (
                  <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                    {o.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>

          {tagOptions.length > 0 ? (
            <Select
              aria-label="按标签筛选"
              placeholder="全部标签"
              value={activeTag || null}
              onChange={(k) => {
                setTagFilter(k == null ? "" : String(k))
                setPage(1)
              }}
              onClear={() => {
                setTagFilter("")
                setPage(1)
              }}
              className="w-36"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.ClearButton />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {tagOptions.map((t) => (
                    <ListBox.Item key={t} id={t} textValue={t}>
                      {t}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          ) : null}

          <Select
            aria-label="排序方式"
            value={sortMode}
            onChange={(k) => {
              if (k == null) return
              const next = String(k) as ChannelSortMode
              setSortMode(next)
              saveStored(SORT_STORAGE_KEY, next)
              setPage(1)
            }}
            className="w-44"
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

          {filtersActive ? (
            <Button variant="ghost" size="sm" onPress={clearFilters}>
              <Sliders className="size-4" />
              清除筛选
            </Button>
          ) : null}
        </div>
      ) : null}

      {body}

      <ChannelFormModal visible={formOpen} onClose={() => setFormOpen(false)} channel={editing} />
      <AllGroupsModal
        visible={groupsOpen}
        onClose={() => setGroupsOpen(false)}
        channels={channels ?? []}
        onAPIKeyAction={onAPIKeyAction}
      />
      <ChannelRedeemModal channel={redeeming} onClose={() => setRedeeming(null)} />
      <ChannelRechargeModal channel={recharging} onClose={() => setRecharging(null)} />
      <ChannelGroupsSheet channel={groupsOf} onClose={() => setGroupsOf(null)} onAPIKeyAction={onAPIKeyAction} />
      <ChannelAPIKeysSheet
        channel={apiKeySheet?.channel ?? null}
        initialAction={apiKeySheet?.initialAction}
        onClose={() => setAPIKeySheet(null)}
      />
    </div>
  )
}

/** 展开行放同步进度、最近报错和备注，都没有时不给展开。 */
function hasDetails(c: Channel, sync?: ChannelSyncState): boolean {
  return !!sync || !!c.last_error || !!c.notes
}

/** 窄屏下的渠道卡片：字段和操作与表格一致，报错和备注点开再看。 */
function ChannelCard({
  channel: c,
  sync,
  actions,
  expanded,
  onToggle,
  expandedContent,
}: {
  channel: Channel
  sync?: ChannelSyncState
  actions: ReactNode[]
  expanded: boolean
  onToggle: () => void
  expandedContent: ReactNode
}) {
  const at = c.last_balance_at ?? c.updated_at
  const canExpand = Boolean(c.last_error || c.notes)

  return (
    <Card className="gap-2.5 rounded-2xl p-3.5">
      <Card.Header className="flex-row items-start justify-between gap-2">
        <div className="stack min-w-0 gap-0.5">
          <div className="row min-w-0 gap-1.5">
            <Card.Title className="min-w-0 truncate text-sm font-semibold" title={c.name}>
              {c.name}
            </Card.Title>
            <Chip
              size="sm"
              variant="soft"
              color={c.type === "newapi" ? "accent" : "default"}
              className="shrink-0"
            >
              {channelTypeLabel(c.type)}
            </Chip>
          </div>
          {c.username.trim() ? (
            <Card.Description className="truncate text-xs" title={c.username}>
              {c.username}
            </Card.Description>
          ) : null}
        </div>
        {/* 名字再长也只截名字，状态标签保持完整 */}
        <div className="shrink-0">
          <ChannelStatusTags channel={c} sync={sync} />
        </div>
      </Card.Header>

      <Card.Content className="gap-2.5">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="余额" value={money(c.last_balance)} />
          <Stat label="今日消费" value={money(c.today_cost)} />
          <Stat label="累计消费" value={money(c.total_cost)} />
        </div>

        {c.tags?.length ? (
          <TagGroup aria-label={`${c.name} 标签`} size="sm">
            <TagGroup.List>
              {c.tags.map((tag) => (
                <Tag key={tag} id={tag} textValue={tag}>
                  {tag}
                </Tag>
              ))}
            </TagGroup.List>
          </TagGroup>
        ) : null}

        <div className="row flex-wrap gap-1.5">{actions}</div>
      </Card.Content>

      <Card.Footer className="justify-between gap-2 pt-0.5">
        <span className="text-xs text-muted">更新于 {relativeTime(at)}</span>
        {canExpand ? (
          <Button variant="ghost" size="sm" onPress={onToggle}>
            {expanded ? "收起详情" : c.last_error ? "详情（有报错）" : "详情"}
          </Button>
        ) : null}
      </Card.Footer>

      {canExpand ? (
        <Disclosure isExpanded={expanded}>
          <Disclosure.Content>
            <Disclosure.Body className="pt-1">{expandedContent}</Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      ) : sync ? (
        <SyncProgress state={sync} />
      ) : null}
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Surface variant="secondary" className="min-w-0 rounded-xl px-2.5 py-1.5">
      <span className="block text-[11px] text-muted">{label}</span>
      <span className="num block truncate text-sm font-semibold text-foreground">{value}</span>
    </Surface>
  )
}
