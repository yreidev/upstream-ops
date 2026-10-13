import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react"
import {
  Banner,
  Button,
  Input,
  Radio,
  Select,
  SideSheet,
  Switch,
  Table,
  Tag,
  TextArea,
  Toast,
  Tooltip,
  Typography,
} from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import type { TagColor } from "@douyinfe/semi-ui/lib/es/tag"
import { IconCopy, IconDelete, IconEdit, IconExternalOpen, IconPlus, IconPriceTag, IconRefresh, IconSearch } from "@douyinfe/semi-icons"
import { apiFetch } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { confirm } from "@/lib/confirm"
import { channelTypeLabel, dateTime, decimal, formatRatio } from "@/lib/format"
import { apiKeyStatusMeta } from "@/lib/labels"
import type {
  Channel,
  ChannelAPIKey,
  ChannelAPIKeyGroup,
  ChannelAPIKeyPage,
  ChannelAPIKeyRenameIssue,
  ChannelAPIKeyRenameResult,
  ChannelAPIKeyReveal,
  ChannelAPIKeyStatus,
} from "@/lib/api-types"
import { useIsMobile } from "@/hooks/use-mobile"
import { FormError } from "@/components/common/form-error"

export interface ChannelAPIKeyTargetGroup {
  id: number | null
  name: string
}

/** 从分组列表直接进来时要做的事：在这个分组下新建密钥，或把已有密钥迁到这个分组。 */
export type ChannelAPIKeyInitialAction = {
  type: "create" | "migrate"
  targetGroup: ChannelAPIKeyTargetGroup
}

type Mode = "list" | "create" | "edit" | "migrate"

interface KeyForm {
  name: string
  custom_key: string
  status: "active" | "disabled"
  group: string
  group_id: string
  remain_quota: string
  quota: string
  unlimited_quota: boolean
  expired_time: string
  expires_in_days: string
  expires_at: string
  model_limits_enabled: boolean
  model_limits: string
  allow_ips: string
  ip_whitelist: string
  ip_blacklist: string
  cross_group_retry: boolean
  rate_limit_5h: string
  rate_limit_1d: string
  rate_limit_7d: string
  reset_quota: boolean
  reset_rate_limit_usage: boolean
}

const PAGE_SIZE = 10

const emptyForm: KeyForm = {
  name: "",
  custom_key: "",
  status: "active",
  group: "",
  group_id: "",
  remain_quota: "",
  quota: "",
  unlimited_quota: false,
  expired_time: "-1",
  expires_in_days: "",
  expires_at: "",
  model_limits_enabled: false,
  model_limits: "",
  allow_ips: "",
  ip_whitelist: "",
  ip_blacklist: "",
  cross_group_retry: false,
  rate_limit_5h: "",
  rate_limit_1d: "",
  rate_limit_7d: "",
  reset_quota: false,
  reset_rate_limit_usage: false,
}

function formFromKey(key: ChannelAPIKey, channel: Channel): KeyForm {
  const base = { ...emptyForm }
  base.name = key.name ?? ""
  base.status = key.status === "disabled" ? "disabled" : "active"
  if (channel.type === "newapi") {
    base.group = key.group ?? ""
    base.remain_quota = key.quota ? String(key.quota) : "0"
    base.unlimited_quota = !!key.unlimited_quota
    base.expired_time = key.expired_time != null ? String(key.expired_time) : "-1"
    base.model_limits_enabled = !!key.model_limits_enabled
    base.model_limits = key.model_limits ?? ""
    base.allow_ips = key.allow_ips ?? ""
    base.cross_group_retry = !!key.cross_group_retry
  } else {
    base.group_id = key.group_id != null ? String(key.group_id) : ""
    base.quota = key.quota ? String(key.quota) : "0"
    base.expires_at = key.expires_at ? toDateTimeLocal(key.expires_at) : ""
    base.ip_whitelist = (key.ip_whitelist ?? []).join("\n")
    base.ip_blacklist = (key.ip_blacklist ?? []).join("\n")
    base.rate_limit_5h = key.rate_limit_5h ? String(key.rate_limit_5h) : "0"
    base.rate_limit_1d = key.rate_limit_1d ? String(key.rate_limit_1d) : "0"
    base.rate_limit_7d = key.rate_limit_7d ? String(key.rate_limit_7d) : "0"
  }
  return base
}

/**
 * 上游站点自己的密钥管理页。Sub2API 和 NewAPI 现在的网页界面都是 /keys；
 * NewAPI 旧界面是 /console/token，官方新界面会把它跳到 /keys，但魔改版不一定有这个跳转，所以直接用 /keys。
 */
function siteKeysURL(channel: Channel) {
  return `${channel.site_url.replace(/\/+$/, "")}/keys`
}

function groupDisplayName(key: ChannelAPIKey) {
  return key.group_name || key.group || (key.group_id != null ? `#${key.group_id}` : "—")
}

function keyMatchesGroup(key: ChannelAPIKey, channel: Channel, group: ChannelAPIKeyTargetGroup) {
  if (channel.type === "newapi") return (key.group ?? "").trim() === group.name.trim()
  return key.group_id != null && group.id != null && key.group_id === group.id
}

function sourceGroupLabel(key: ChannelAPIKey, channel: Channel, groups: ChannelAPIKeyGroup[]) {
  if (channel.type === "newapi") {
    const name = (key.group ?? "").trim()
    if (!name) return "未分组"
    return groups.some((group) => group.name === name) ? name : `已失效：${name}`
  }
  if (key.group_id == null) return "未分组"
  const liveGroup = groups.find((group) => group.id === key.group_id)
  if (liveGroup) return liveGroup.name
  return `已失效：${key.group_name?.trim() || `#${key.group_id}`}`
}

const RENAME_ISSUE_LIMIT = 8

// 一键改名后在提示里列出跳过或失败的密钥：原因相同的合成一行，太多时只列前几个。
function renameIssueText(issues: ChannelAPIKeyRenameIssue[]) {
  const byReason = new Map<string, string[]>()
  for (const item of issues) {
    const names = byReason.get(item.reason) ?? []
    names.push(item.name || String(item.id))
    byReason.set(item.reason, names)
  }
  const lines = [...byReason].slice(0, RENAME_ISSUE_LIMIT).map(([reason, names]) => {
    const shown = names.slice(0, RENAME_ISSUE_LIMIT).join("、")
    const more = names.length > RENAME_ISSUE_LIMIT ? ` 等 ${names.length} 个` : ""
    return `${shown}${more}：${reason}`
  })
  if (byReason.size > RENAME_ISSUE_LIMIT) lines.push(`…还有 ${byReason.size - RENAME_ISSUE_LIMIT} 种原因`)
  return lines.join("\n")
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function optionalInt(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) throw new Error("请输入有效整数")
  return Math.trunc(n)
}

function optionalFloat(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) throw new Error("请输入有效数字")
  return n
}

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localDateTimeToISO(value: string): string | undefined {
  if (!value.trim()) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error("过期时间格式无效")
  return d.toISOString()
}

/** “密钥”列平时的宽度，够放打码后的密钥。 */
const KEY_COL_WIDTH = 200

function maskKey(key: string) {
  if (!key) return "—"
  if (key.length <= 12) return key
  return `${key.slice(0, 8)}…${key.slice(-6)}`
}

/** 渠道在上游的 API 密钥：列表、新建、编辑、删除、迁移分组、一键把名称改成分组名。channel 为空时不显示。 */
export function ChannelAPIKeysSheet({ channel, initialAction, onClose }: {
  channel: Channel | null
  initialAction?: ChannelAPIKeyInitialAction
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  const open = channel != null
  const [mode, setMode] = useState<Mode>("list")
  const [editing, setEditing] = useState<ChannelAPIKey | null>(null)
  const [form, setForm] = useState<KeyForm>(emptyForm)
  const [page, setPage] = useState(1)
  const [reloadTick, setReloadTick] = useState(0)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<ChannelAPIKeyStatus | "all">("all")
  const [data, setData] = useState<ChannelAPIKeyPage | null>(null)
  const [groups, setGroups] = useState<ChannelAPIKeyGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [groupsReloadTick, setGroupsReloadTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [revealingID, setRevealingID] = useState<number | null>(null)
  const [revealedKeys, setRevealedKeys] = useState<Record<number, string>>({})
  const [selectedKey, setSelectedKey] = useState<ChannelAPIKey | null>(null)

  const items = data?.items ?? []
  const isNewAPI = channel?.type === "newapi"
  const groupByName = new Map(groups.map((g) => [g.name, g]))
  const groupByID = new Map(groups.filter((g) => g.id != null).map((g) => [String(g.id), g]))
  const actionType = initialAction?.type
  const targetGroup = initialAction?.targetGroup
  const targetGroupID = targetGroup?.id ?? null
  const targetGroupName = targetGroup?.name ?? ""
  const liveTargetGroup = isNewAPI
    ? groupByName.get(targetGroupName)
    : targetGroupID == null
      ? undefined
      : groupByID.get(String(targetGroupID))
  const targetValidationRequired = initialAction != null && (mode === "create" || mode === "migrate")
  const targetValidationError = targetValidationRequired
    ? groupsError || (!groupsLoading && !liveTargetGroup ? "目标分组已失效，请先同步渠道分组。" : null)
    : null
  const visibleGroupsError = targetValidationError || (mode === "create" || mode === "edit" ? groupsError : null)

  // 打开或换了渠道 / 入口动作时重置
  useEffect(() => {
    if (!open) return
    setMode(actionType ?? "list")
    setEditing(null)
    setForm(() => {
      const next = { ...emptyForm }
      if (actionType === "create") {
        if (channel?.type === "newapi") next.group = targetGroupName
        else if (targetGroupID != null) next.group_id = String(targetGroupID)
      }
      return next
    })
    setPage(1)
    setSearchInput("")
    setSearch("")
    setStatus("all")
    setData(null)
    setError(null)
    setListError(null)
    setGroups([])
    setGroupsError(null)
    setGroupsLoading(true)
    setRevealingID(null)
    setRevealedKeys({})
    setSelectedKey(null)
  }, [open, channel?.id, channel?.type, actionType, targetGroupID, targetGroupName])

  useEffect(() => {
    if (!channel) return
    let cancelled = false
    setGroupsLoading(true)
    setGroupsError(null)
    apiFetch<ChannelAPIKeyGroup[]>(`/channels/${channel.id}/api-keys/groups`)
      .then((res) => {
        if (!cancelled) setGroups(Array.isArray(res) ? res : [])
      })
      .catch((e) => {
        if (cancelled) return
        setGroupsError((e as Error).message || "加载分组失败")
        setGroups([])
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channel, groupsReloadTick])

  // 搜索框停顿 300ms 再查
  useEffect(() => {
    const next = searchInput.trim()
    if (next === search) return
    const timer = setTimeout(() => {
      setSearch(next)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput, search])

  useEffect(() => {
    if (!channel || (mode !== "list" && mode !== "migrate")) return
    let cancelled = false
    const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
    if (search) params.set("search", search)
    if (status !== "all") params.set("status", status)
    setLoading(true)
    setListError(null)
    apiFetch<ChannelAPIKeyPage>(`/channels/${channel.id}/api-keys?${params.toString()}`)
      .then((res) => {
        if (cancelled) return
        setData({
          items: Array.isArray(res?.items) ? res.items : [],
          total: res?.total ?? 0,
          page: res?.page ?? page,
          page_size: res?.page_size ?? PAGE_SIZE,
          pages: res?.pages ?? 1,
        })
      })
      .catch((e) => {
        if (!cancelled) setListError((e as Error).message || "加载密钥失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channel, mode, page, search, status, reloadTick])

  function reload() {
    setReloadTick((tick) => tick + 1)
  }

  function backToList() {
    setMode("list")
    setEditing(null)
    setError(null)
  }

  function openCreate() {
    setEditing(null)
    setForm(() => {
      const next = { ...emptyForm }
      if (actionType === "create" && targetGroup) {
        if (isNewAPI) next.group = targetGroup.name
        else if (targetGroup.id != null) next.group_id = String(targetGroup.id)
      } else {
        const first = groups[0]
        if (first) {
          if (isNewAPI) next.group = first.name
          else if (first.id != null) next.group_id = String(first.id)
        }
      }
      return next
    })
    setError(null)
    setMode("create")
  }

  function openEdit(key: ChannelAPIKey) {
    if (!channel) return
    setEditing(key)
    setForm(formFromKey(key, channel))
    setError(null)
    setMode("edit")
  }

  function buildPayload() {
    if (!channel) return {}
    if (!form.name.trim()) throw new Error("密钥名称不能为空")
    if (channel.type === "newapi") {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        group: form.group.trim(),
        remain_quota: optionalInt(form.remain_quota) ?? 0,
        unlimited_quota: form.unlimited_quota,
        expired_time: optionalInt(form.expired_time) ?? -1,
        model_limits_enabled: form.model_limits_enabled,
        model_limits: form.model_limits.trim(),
        allow_ips: form.allow_ips.trim(),
        cross_group_retry: form.cross_group_retry,
      }
      if (mode === "create" && form.custom_key.trim()) payload.custom_key = form.custom_key.trim()
      if (mode === "edit") payload.status = form.status
      return payload
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      group_id: optionalInt(form.group_id),
      quota: optionalFloat(form.quota) ?? 0,
      ip_whitelist: splitLines(form.ip_whitelist),
      ip_blacklist: splitLines(form.ip_blacklist),
      rate_limit_5h: optionalFloat(form.rate_limit_5h) ?? 0,
      rate_limit_1d: optionalFloat(form.rate_limit_1d) ?? 0,
      rate_limit_7d: optionalFloat(form.rate_limit_7d) ?? 0,
    }
    if (mode === "create") {
      if (form.custom_key.trim()) payload.custom_key = form.custom_key.trim()
      const days = optionalInt(form.expires_in_days)
      if (days != null) payload.expires_in_days = days
    } else {
      payload.status = form.status
      payload.expires_at = localDateTimeToISO(form.expires_at) ?? ""
      payload.reset_quota = form.reset_quota
      payload.reset_rate_limit_usage = form.reset_rate_limit_usage
    }
    return payload
  }

  async function handleSubmit() {
    if (!channel) return
    if (mode === "create" && initialAction && !liveTargetGroup) {
      setError(targetValidationError || "目标分组还没通过校验。")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const payload = buildPayload()
      if (mode === "create") {
        const created = await apiFetch<ChannelAPIKey>(`/channels/${channel.id}/api-keys`, {
          method: "POST",
          body: JSON.stringify(payload),
        })
        if (created?.key) {
          if (created.id) setRevealedKeys((prev) => ({ ...prev, [created.id]: created.key }))
          copyText(created.key)
            .then(() => Toast.success("密钥已创建并复制"))
            .catch((err: Error) => {
              Toast.success("密钥已创建")
              Toast.error(err?.message || "自动复制失败，请手动复制")
            })
        }
      } else if (editing) {
        await apiFetch<ChannelAPIKey>(`/channels/${channel.id}/api-keys/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        })
        Toast.success("密钥已更新")
      }
      setMode("list")
      setEditing(null)
      setForm(emptyForm)
      setPage(1)
      reload()
    } catch (e) {
      setError((e as Error).message || "保存密钥失败")
    } finally {
      setSubmitting(false)
    }
  }

  async function migrateSelectedKey() {
    if (!channel || !selectedKey || !targetGroup || !liveTargetGroup) {
      setError(targetValidationError || "请选择要迁移的密钥。")
      return
    }
    const sourceGroup = sourceGroupLabel(selectedKey, channel, groups)
    const ok = await confirm({
      title: `迁移密钥“${selectedKey.name || selectedKey.id}”？`,
      description: `${sourceGroup} → ${liveTargetGroup.name}`,
      confirmLabel: "确认迁移",
    })
    if (!ok) return
    setSubmitting(true)
    setError(null)
    try {
      const payload = isNewAPI ? { group: liveTargetGroup.name } : { group_id: targetGroupID }
      await apiFetch<ChannelAPIKey>(`/channels/${channel.id}/api-keys/${selectedKey.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      Toast.success(`密钥“${selectedKey.name || selectedKey.id}”已从“${sourceGroup}”迁到“${liveTargetGroup.name}”`)
      onClose()
    } catch (e) {
      setError((e as Error).message || "迁移密钥失败")
    } finally {
      setSubmitting(false)
    }
  }

  async function revealKey(key: ChannelAPIKey) {
    if (!channel) throw new Error("渠道不存在")
    const cached = revealedKeys[key.id]
    if (cached) return cached
    setRevealingID(key.id)
    try {
      const res = await apiFetch<ChannelAPIKeyReveal>(`/channels/${channel.id}/api-keys/${key.id}/reveal`, { method: "POST" })
      if (!res?.key) throw new Error("上游没有返回完整密钥")
      setRevealedKeys((prev) => ({ ...prev, [key.id]: res.key }))
      return res.key
    } finally {
      setRevealingID((current) => (current === key.id ? null : current))
    }
  }

  async function revealAndShow(key: ChannelAPIKey) {
    try {
      await revealKey(key)
    } catch (e) {
      Toast.error((e as Error).message || "获取完整密钥失败")
    }
  }

  async function revealAndCopy(key: ChannelAPIKey) {
    try {
      await copyText(await revealKey(key))
      Toast.success("已复制")
    } catch (e) {
      Toast.error((e as Error).message || "获取完整密钥失败")
    }
  }

  async function deleteKey(key: ChannelAPIKey) {
    if (!channel) return
    const ok = await confirm({
      title: `删除密钥 ${key.name || key.id}？`,
      description: "删除后上游的这个密钥无法恢复。",
      confirmLabel: "删除",
      destructive: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/channels/${channel.id}/api-keys/${key.id}`, { method: "DELETE" })
      Toast.success("密钥已删除")
      reload()
    } catch (e) {
      Toast.error((e as Error).message || "删除密钥失败")
    }
  }

  async function renameKeysToGroup() {
    if (!channel) return
    const ok = await confirm({
      title: "把所有密钥的名称改成所属分组名？",
      description: "会修改这个渠道在上游的全部密钥名称。已经同名、未分组、分组不在上游现有分组里的密钥会跳过。",
      confirmLabel: "确认修改",
    })
    if (!ok) return
    setRenaming(true)
    try {
      const res = await apiFetch<ChannelAPIKeyRenameResult>(`/channels/${channel.id}/api-keys/rename-to-group`, { method: "POST" })
      const parts = [`已改名 ${res.renamed} 个`]
      if (res.unchanged > 0) parts.push(`${res.unchanged} 个本来就同名`)
      if (res.skipped.length > 0) parts.push(`跳过 ${res.skipped.length} 个`)
      if (res.failed.length > 0) parts.push(`${res.failed.length} 个修改失败`)
      // 有失败时只弹一条错误提示，不再同时弹“已改名 0 个”的成功提示
      const content = (
        <div className="stack" style={{ gap: 4 }}>
          <span>{parts.join("，")}</span>
          {res.failed.length > 0 ? (
            <span className="pre-wrap" style={{ fontSize: 12 }}>{`修改失败：\n${renameIssueText(res.failed)}`}</span>
          ) : null}
          {res.skipped.length > 0 ? (
            <span className="pre-wrap" style={{ fontSize: 12 }}>{`跳过：\n${renameIssueText(res.skipped)}`}</span>
          ) : null}
        </div>
      )
      if (res.failed.length > 0) {
        Toast.error({ content, duration: 8 })
      } else {
        Toast.success({ content, duration: res.skipped.length > 0 ? 8 : 3 })
      }
      reload()
    } catch (e) {
      Toast.error((e as Error).message || "修改密钥名称失败")
    } finally {
      setRenaming(false)
    }
  }

  const isMigrate = mode === "migrate"
  const isForm = mode === "create" || mode === "edit"
  const targetLocked = mode === "create" && actionType === "create" && targetGroup != null
  const title = isMigrate ? "迁移密钥" : mode === "create" ? "新建密钥" : mode === "edit" ? "编辑密钥" : "密钥管理"

  // 点开完整密钥后“密钥”列按这一页最长的那把放宽，尽量一行显示（Sub2API 的密钥 67 个字符）
  const revealedLen = isMigrate ? 0 : Math.max(0, ...items.map((k) => revealedKeys[k.id]?.length ?? 0))
  const keyColWidth = revealedLen ? Math.min(Math.max(KEY_COL_WIDTH, Math.ceil(revealedLen * 7.3) + 56), 560) : KEY_COL_WIDTH

  const columns: ColumnProps<ChannelAPIKey>[] = []
  if (isMigrate) {
    columns.push({
      title: "",
      key: "pick",
      width: 48,
      render: (_: unknown, item: ChannelAPIKey) => {
        const isCurrentTarget = !!(channel && targetGroup && keyMatchesGroup(item, channel, targetGroup))
        return (
          <Radio
            checked={selectedKey?.id === item.id}
            disabled={isCurrentTarget || groupsLoading || targetValidationError != null}
            onChange={() => setSelectedKey(item)}
            aria-label={`选择 ${item.name || item.id}`}
          />
        )
      },
    })
  }
  columns.push(
    { title: "名称", dataIndex: "name", width: 140, render: (v: string) => <Typography.Text strong>{v || "未命名"}</Typography.Text> },
    {
      title: "密钥",
      key: "key",
      width: keyColWidth,
      render: (_: unknown, item: ChannelAPIKey) => {
        if (isMigrate) return <span className="mono" style={{ fontSize: 12 }}>{maskKey(item.key)}</span>
        const full = revealedKeys[item.id]
        if (full) {
          return (
            <Typography.Text className="mono" size="small" copyable={{ content: full }} style={{ wordBreak: "break-all" }}>
              {full}
            </Typography.Text>
          )
        }
        return (
          <Tooltip content="点击显示完整密钥">
            <Button
              theme="borderless"
              size="small"
              loading={revealingID === item.id}
              onClick={() => void revealAndShow(item)}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, padding: "0 4px" }}
            >
              {maskKey(item.key)}
            </Button>
          </Tooltip>
        )
      },
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 80,
      render: (v: string) => {
        const meta = apiKeyStatusMeta[v] ?? { label: v || "未知", color: "grey" as TagColor }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: "分组",
      key: "group",
      render: (_: unknown, item: ChannelAPIKey) => {
        const isCurrentTarget = !!(isMigrate && channel && targetGroup && keyMatchesGroup(item, channel, targetGroup))
        // 分组名可以复制：有的站点只允许在网页上改密钥，复制过去当密钥名称用
        const groupName = (item.group_name || item.group || "").trim()
        return (
          <div className="stack" style={{ gap: 2 }}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Typography.Text size="small" strong copyable={!isMigrate && groupName ? { content: groupName, copyTip: "复制分组名" } : false}>
                {isMigrate && channel ? sourceGroupLabel(item, channel, groups) : groupDisplayName(item)}
              </Typography.Text>
              {isCurrentTarget ? <Tag size="small">已在目标分组</Tag> : null}
            </div>
            <Typography.Text type="tertiary" size="small">
              {item.group_description || "无描述"}
              {item.group_ratio > 0 ? ` · 倍率 ${formatRatio(item.group_ratio)}` : ""}
            </Typography.Text>
          </div>
        )
      },
    },
    {
      title: "额度",
      key: "quota",
      width: 110,
      render: (_: unknown, item: ChannelAPIKey) => (
        <span className="num">
          {isNewAPI
            ? item.unlimited_quota
              ? "无限"
              : decimal(item.quota, 0)
            : `${decimal(item.quota_used)}/${item.quota > 0 ? decimal(item.quota) : "无限"}`}
        </span>
      ),
    },
    {
      title: "过期",
      key: "expire",
      width: 120,
      render: (_: unknown, item: ChannelAPIKey) =>
        isNewAPI
          ? item.expired_time === -1 || !item.expired_time
            ? "永不过期"
            : dateTime(new Date(item.expired_time * 1000).toISOString())
          : item.expires_at
            ? dateTime(item.expires_at)
            : "永不过期",
    },
  )
  if (!isMigrate) {
    columns.push({
      title: "操作",
      key: "actions",
      width: 110,
      fixed: isMobile ? undefined : "right",
      render: (_: unknown, item: ChannelAPIKey) => (
        <div className="row" style={{ gap: 2 }}>
          <Tooltip content="复制完整密钥">
            <Button theme="borderless" size="small" icon={<IconCopy />} loading={revealingID === item.id} onClick={() => void revealAndCopy(item)} aria-label="复制完整密钥" />
          </Tooltip>
          <Tooltip content="编辑">
            <Button theme="borderless" size="small" icon={<IconEdit />} onClick={() => openEdit(item)} aria-label="编辑" />
          </Tooltip>
          <Tooltip content="删除">
            <Button theme="borderless" type="danger" size="small" icon={<IconDelete />} onClick={() => void deleteKey(item)} aria-label="删除" />
          </Tooltip>
        </div>
      ),
    })
  }

  let footer: ReactNode = null
  if (isMigrate) {
    footer = (
      <div className="row-between" style={{ width: "100%" }}>
        <Typography.Text type="tertiary" size="small" className="truncate">
          {selectedKey ? `已选择：${selectedKey.name || selectedKey.id}` : "选一个要迁移的密钥"}
        </Typography.Text>
        <div className="row">
          <Button onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            theme="solid"
            loading={submitting}
            disabled={groupsLoading || targetValidationError != null || selectedKey == null}
            onClick={() => void migrateSelectedKey()}
          >
            迁移
          </Button>
        </div>
      </div>
    )
  } else if (isForm) {
    footer = (
      <div className="row" style={{ justifyContent: "flex-end", width: "100%" }}>
        <Button onClick={backToList} disabled={submitting}>
          返回列表
        </Button>
        <Button theme="solid" loading={submitting} disabled={groupsLoading || targetValidationError != null} onClick={() => void handleSubmit()}>
          {mode === "create" ? "创建" : "保存"}
        </Button>
      </div>
    )
  }

  return (
    <SideSheet
      visible={open}
      onCancel={onClose}
      title={
        <div className="stack" style={{ gap: 2 }}>
          <span>{title}</span>
          {channel ? (
            <Typography.Text type="tertiary" size="small" style={{ fontWeight: "normal" }}>
              {channel.name} · {channelTypeLabel(channel.type)}
              {initialAction ? ` · 目标分组 ${targetGroupName}` : ""}
            </Typography.Text>
          ) : null}
        </div>
      }
      // 宽屏上放宽，但不铺满：太宽的表格反而难对齐着看
      width={isMobile ? "100%" : "min(1400px, 90vw)"}
      // 可能从“全部分组”弹窗里打开，要盖在弹窗上面
      zIndex={1010}
      footer={footer}
      bodyStyle={{ paddingBottom: 16 }}
    >
      <div className="stack" style={{ gap: 12 }}>
        {mode !== "list" && (groupsLoading || visibleGroupsError) ? (
          <Banner
            fullMode={false}
            type={visibleGroupsError ? "danger" : "info"}
            closeIcon={null}
            description={
              <div className="row-between">
                <span>{groupsLoading ? "正在校验分组…" : visibleGroupsError}</span>
                {visibleGroupsError ? (
                  <Button size="small" icon={<IconRefresh />} onClick={() => setGroupsReloadTick((t) => t + 1)}>
                    重试
                  </Button>
                ) : null}
              </div>
            }
          />
        ) : null}

        {isForm ? (
          <KeyFormFields
            form={form}
            setForm={setForm}
            mode={mode}
            isNewAPI={isNewAPI}
            disabled={submitting}
            groups={groups}
            groupsLoading={groupsLoading}
            groupLocked={targetLocked}
          />
        ) : (
          <>
            <div className="row-between" style={{ flexWrap: "wrap" }}>
              <div className="row" style={{ flexWrap: "wrap" }}>
                <Input
                  prefix={<IconSearch />}
                  value={searchInput}
                  onChange={setSearchInput}
                  showClear
                  placeholder="搜索名称或密钥"
                  style={{ width: isMobile ? "100%" : 240 }}
                />
                <Select
                  value={status}
                  onChange={(v) => {
                    setStatus(v as ChannelAPIKeyStatus | "all")
                    setPage(1)
                  }}
                  style={{ width: 120 }}
                  optionList={[
                    { value: "all", label: "全部状态" },
                    { value: "active", label: "启用" },
                    { value: "disabled", label: "停用" },
                    { value: "expired", label: "已过期" },
                    { value: "quota_exhausted", label: "额度耗尽" },
                  ]}
                />
              </div>
              {isMigrate ? (
                <div className="row">
                  <Typography.Text type="tertiary" size="small">
                    迁移到
                  </Typography.Text>
                  <Tag color="blue">{liveTargetGroup?.name || targetGroupName}</Tag>
                </div>
              ) : (
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <Tooltip content="在新标签页打开上游站点的密钥管理页">
                    <Button icon={<IconExternalOpen />} disabled={!channel} onClick={() => channel && window.open(siteKeysURL(channel), "_blank", "noopener,noreferrer")}>
                      打开站点密钥页
                    </Button>
                  </Tooltip>
                  <Tooltip content="把这个渠道全部密钥的名称改成各自所属的分组名">
                    <Button icon={<IconPriceTag />} loading={renaming} disabled={loading || items.length === 0} onClick={() => void renameKeysToGroup()}>
                      名称改为分组名
                    </Button>
                  </Tooltip>
                  <Button theme="solid" icon={<IconPlus />} onClick={openCreate}>
                    新建密钥
                  </Button>
                </div>
              )}
            </div>

            {listError ? (
              <Banner
                fullMode={false}
                type="danger"
                closeIcon={null}
                description={
                  <div className="row-between">
                    <span>{listError}</span>
                    <Button size="small" onClick={reload}>
                      重新加载
                    </Button>
                  </div>
                }
              />
            ) : null}
            {isMigrate && error ? <Banner fullMode={false} type="danger" closeIcon={null} description={error} /> : null}

            <Table<ChannelAPIKey>
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={items}
              loading={loading}
              scroll={{ x: 900 + keyColWidth - KEY_COL_WIDTH }}
              empty="暂无密钥"
              onRow={(item?: ChannelAPIKey) => {
                if (!isMigrate || !item || !channel) return {}
                const isCurrentTarget = !!(targetGroup && keyMatchesGroup(item, channel, targetGroup))
                const disabled = isCurrentTarget || groupsLoading || targetValidationError != null
                return {
                  onClick: () => {
                    if (!disabled) setSelectedKey(item)
                  },
                  style: { cursor: disabled ? "not-allowed" : "pointer", opacity: isCurrentTarget ? 0.6 : 1 },
                }
              }}
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
          </>
        )}

        <FormError message={isForm ? error : null} />
      </div>
    </SideSheet>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <Typography.Text strong size="small">
        {label}
      </Typography.Text>
      {children}
      {hint ? (
        <Typography.Text type="tertiary" size="small">
          {hint}
        </Typography.Text>
      ) : null}
    </div>
  )
}

function SwitchField({ label, checked, disabled, onChange }: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div
      className="row-between"
      style={{ padding: "8px 12px", border: "1px solid var(--semi-color-border)", borderRadius: 6, alignSelf: "end" }}
    >
      <Typography.Text>{label}</Typography.Text>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
}

function GroupSelect({ value, onChange, groups, byID, disabled, loading }: {
  value: string
  onChange: (v: string) => void
  groups: ChannelAPIKeyGroup[]
  byID: boolean
  disabled: boolean
  loading: boolean
}) {
  const options = byID ? groups.filter((g) => g.id != null) : groups
  const selected = options.find((g) => (byID ? String(g.id) : g.name) === value)
  return (
    <>
      <Select
        value={value || undefined}
        onChange={(v) => onChange(String(v ?? ""))}
        disabled={disabled || loading}
        placeholder={loading ? "加载中…" : "选择分组"}
        filter
        style={{ width: "100%" }}
        dropdownStyle={{ maxWidth: 420 }}
      >
        {options.map((g) => {
          const v = byID ? String(g.id) : g.name
          return (
            <Select.Option key={v} value={v} label={`${g.name} · ${formatRatio(g.ratio)}`}>
              <div className="stack" style={{ gap: 0 }}>
                <span>
                  {g.name} · {formatRatio(g.ratio)}
                </span>
                <Typography.Text type="tertiary" size="small" style={{ whiteSpace: "normal" }}>
                  {g.description || "无描述"}
                </Typography.Text>
              </div>
            </Select.Option>
          )
        })}
      </Select>
      {selected ? (
        <Typography.Text type="tertiary" size="small">
          {selected.description || "无描述"} · 倍率 {formatRatio(selected.ratio)}
        </Typography.Text>
      ) : null}
    </>
  )
}

const formGrid = { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" } as const

function KeyFormFields({ form, setForm, mode, isNewAPI, disabled, groups, groupsLoading, groupLocked }: {
  form: KeyForm
  setForm: Dispatch<SetStateAction<KeyForm>>
  mode: Mode
  isNewAPI: boolean
  disabled: boolean
  groups: ChannelAPIKeyGroup[]
  groupsLoading: boolean
  groupLocked: boolean
}) {
  const set = <K extends keyof KeyForm>(k: K) => (v: KeyForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div style={formGrid}>
        <Field label="名称">
          <Input value={form.name} onChange={set("name")} disabled={disabled} />
        </Field>
        {mode === "create" ? (
          <Field label="自定义密钥">
            <Input value={form.custom_key} onChange={set("custom_key")} placeholder="留空由上游生成" disabled={disabled} />
          </Field>
        ) : (
          <Field label="状态">
            <Select
              value={form.status}
              onChange={(v) => set("status")(v as KeyForm["status"])}
              disabled={disabled}
              style={{ width: "100%" }}
              optionList={[
                { value: "active", label: "启用" },
                { value: "disabled", label: "停用" },
              ]}
            />
          </Field>
        )}
        <Field label={isNewAPI ? "分组" : "分组 ID"}>
          <GroupSelect
            value={isNewAPI ? form.group : form.group_id}
            onChange={isNewAPI ? set("group") : set("group_id")}
            groups={groups}
            byID={!isNewAPI}
            disabled={disabled || groupLocked}
            loading={groupsLoading}
          />
        </Field>
      </div>

      {isNewAPI ? (
        <>
          <div style={formGrid}>
            <Field label="剩余额度">
              <Input value={form.remain_quota} onChange={set("remain_quota")} disabled={disabled} inputMode="numeric" />
            </Field>
            <Field label="过期时间戳" hint="Unix 秒，-1 表示永不过期。">
              <Input value={form.expired_time} onChange={set("expired_time")} disabled={disabled} inputMode="numeric" />
            </Field>
          </div>
          <div style={formGrid}>
            <SwitchField label="无限额度" checked={form.unlimited_quota} disabled={disabled} onChange={set("unlimited_quota")} />
            <SwitchField label="启用模型限制" checked={form.model_limits_enabled} disabled={disabled} onChange={set("model_limits_enabled")} />
            <SwitchField label="跨分组重试" checked={form.cross_group_retry} disabled={disabled} onChange={set("cross_group_retry")} />
          </div>
          <div style={formGrid}>
            <Field label="模型限制">
              <TextArea value={form.model_limits} onChange={set("model_limits")} placeholder="逗号分隔" rows={3} disabled={disabled} />
            </Field>
            <Field label="允许 IP">
              <TextArea value={form.allow_ips} onChange={set("allow_ips")} placeholder="每行一个 IP" rows={3} disabled={disabled} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <div style={formGrid}>
            <Field label="额度（USD）">
              <Input value={form.quota} onChange={set("quota")} disabled={disabled} inputMode="decimal" />
            </Field>
            {mode === "create" ? (
              <Field label="过期天数">
                <Input value={form.expires_in_days} onChange={set("expires_in_days")} placeholder="留空永不过期" disabled={disabled} inputMode="numeric" />
              </Field>
            ) : (
              <Field label="过期时间">
                <Input type="datetime-local" value={form.expires_at} onChange={set("expires_at")} disabled={disabled} />
              </Field>
            )}
            <Field label="5 小时限额">
              <Input value={form.rate_limit_5h} onChange={set("rate_limit_5h")} disabled={disabled} inputMode="decimal" />
            </Field>
            <Field label="1 天限额">
              <Input value={form.rate_limit_1d} onChange={set("rate_limit_1d")} disabled={disabled} inputMode="decimal" />
            </Field>
            <Field label="7 天限额">
              <Input value={form.rate_limit_7d} onChange={set("rate_limit_7d")} disabled={disabled} inputMode="decimal" />
            </Field>
          </div>
          <div style={formGrid}>
            <Field label="IP 白名单">
              <TextArea value={form.ip_whitelist} onChange={set("ip_whitelist")} placeholder="每行一个 IP 或 CIDR" rows={3} disabled={disabled} />
            </Field>
            <Field label="IP 黑名单">
              <TextArea value={form.ip_blacklist} onChange={set("ip_blacklist")} placeholder="每行一个 IP 或 CIDR" rows={3} disabled={disabled} />
            </Field>
          </div>
          {mode === "edit" ? (
            <div style={formGrid}>
              <SwitchField label="重置额度" checked={form.reset_quota} disabled={disabled} onChange={set("reset_quota")} />
              <SwitchField label="重置限额用量" checked={form.reset_rate_limit_usage} disabled={disabled} onChange={set("reset_rate_limit_usage")} />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
