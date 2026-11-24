import { useEffect, useState, type Dispatch, type SetStateAction } from "react"
import {
  Alert,
  Button,
  Chip,
  Description,
  Drawer,
  EmptyState,
  Input,
  Label,
  ListBox,
  SearchField,
  Select,
  Spinner,
  Surface,
  Switch,
  Table,
  TextArea,
  TextField,
  Tooltip,
  toast,
} from "@heroui/react"
import {
  ArrowUpRightFromSquare,
  ArrowsRotateRight,
  Check,
  Copy,
  Pencil,
  Plus,
  Tag,
  TrashBin,
} from "@gravity-ui/icons"
import { apiFetch } from "@/lib/api"
import { copyText } from "@/lib/clipboard"
import { confirm } from "@/lib/confirm"
import { channelTypeLabel, dateTime, decimal, formatRatio } from "@/lib/format"
import { apiKeyStatusMeta, type ChipColor } from "@/lib/labels"
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
import { PaginationBar } from "@/components/common/pagination-bar"

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

function maskKey(key: string) {
  if (!key) return "—"
  if (key.length <= 12) return key
  return `${key.slice(0, 8)}…${key.slice(-6)}`
}

const statusFilterOptions: { value: ChannelAPIKeyStatus | "all"; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "启用" },
  { value: "disabled", label: "停用" },
  { value: "expired", label: "已过期" },
  { value: "quota_exhausted", label: "额度耗尽" },
]

/** 渠道在上游的 API 密钥：列表、新建、编辑、删除、迁移分组、一键把名称改成分组名。channel 为空时不显示。 */
export function ChannelAPIKeysSheet({
  channel,
  initialAction,
  onClose,
}: {
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
            .then(() => toast.success("密钥已创建并复制"))
            .catch((err: Error) => {
              toast.success("密钥已创建")
              toast.danger(err?.message || "自动复制失败，请手动复制")
            })
        }
      } else if (editing) {
        await apiFetch<ChannelAPIKey>(`/channels/${channel.id}/api-keys/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        })
        toast.success("密钥已更新")
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
      toast.success(`密钥“${selectedKey.name || selectedKey.id}”已从“${sourceGroup}”迁到“${liveTargetGroup.name}”`)
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
      toast.danger((e as Error).message || "获取完整密钥失败")
    }
  }

  async function revealAndCopy(key: ChannelAPIKey) {
    try {
      await copyText(await revealKey(key))
      toast.success("已复制")
    } catch (e) {
      toast.danger((e as Error).message || "获取完整密钥失败")
    }
  }

  async function copyQuickText(text: string, label = "已复制") {
    try {
      await copyText(text)
      toast.success(label)
    } catch (e) {
      toast.danger((e as Error).message || "复制失败")
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
      toast.success("密钥已删除")
      reload()
    } catch (e) {
      toast.danger((e as Error).message || "删除密钥失败")
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
      const details: string[] = []
      if (res.failed.length > 0) details.push(`修改失败：\n${renameIssueText(res.failed)}`)
      if (res.skipped.length > 0) details.push(`跳过：\n${renameIssueText(res.skipped)}`)
      const description = details.length > 0 ? <span className="pre-wrap text-xs">{details.join("\n")}</span> : undefined
      if (res.failed.length > 0) {
        toast.danger(parts.join("，"), { description, timeout: 8000 })
      } else {
        toast.success(parts.join("，"), { description, timeout: res.skipped.length > 0 ? 8000 : 3000 })
      }
      reload()
    } catch (e) {
      toast.danger((e as Error).message || "修改密钥名称失败")
    } finally {
      setRenaming(false)
    }
  }

  const isMigrate = mode === "migrate"
  const isForm = mode === "create" || mode === "edit"
  const targetLocked = mode === "create" && actionType === "create" && targetGroup != null
  const title = isMigrate ? "迁移密钥" : mode === "create" ? "新建密钥" : mode === "edit" ? "编辑密钥" : "密钥管理"

  const disabledMigrateKeys = isMigrate
    ? items
        .filter(
          (item) =>
            groupsLoading ||
            targetValidationError != null ||
            Boolean(channel && targetGroup && keyMatchesGroup(item, channel, targetGroup)),
        )
        .map((item) => item.id)
    : []

  const drawerBusy = submitting || renaming

  return (
    <Drawer.Backdrop
      isOpen={open}
      isDismissable={!drawerBusy}
      isKeyboardDismissDisabled={drawerBusy}
      onOpenChange={(nextOpen) => !nextOpen && !drawerBusy && onClose()}
    >
      <Drawer.Content placement="right">
        <Drawer.Dialog className="w-full max-w-[min(1400px,92vw)] sm:w-[min(1400px,92vw)]">
          <Drawer.CloseTrigger isDisabled={drawerBusy} />
          <Drawer.Header className="flex flex-col items-start gap-0.5">
            <Drawer.Heading>{title}</Drawer.Heading>
            {channel ? (
              <span className="text-xs font-normal text-muted">
                {channel.name} · {channelTypeLabel(channel.type)}
                {initialAction ? ` · 目标分组 ${targetGroupName}` : ""}
              </span>
            ) : null}
          </Drawer.Header>
          <Drawer.Body className="pb-4">
            <div className="stack gap-3">
              {mode !== "list" && (groupsLoading || visibleGroupsError) ? (
                <Alert status={visibleGroupsError ? "danger" : "accent"}>
                  <Alert.Indicator />
                  <Alert.Content>
                    <div className="row-between gap-2">
                      <Alert.Description>{groupsLoading ? "正在校验分组…" : visibleGroupsError}</Alert.Description>
                      {visibleGroupsError ? (
                        <Button size="sm" variant="secondary" onPress={() => setGroupsReloadTick((t) => t + 1)}>
                          <ArrowsRotateRight className="size-3.5" />
                          重试
                        </Button>
                      ) : null}
                    </div>
                  </Alert.Content>
                </Alert>
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
                  <div className="row-between flex-wrap gap-2">
                    <div className="row flex-wrap gap-2">
                      <SearchField
                        aria-label="搜索名称或密钥"
                        variant="secondary"
                        value={searchInput}
                        onChange={setSearchInput}
                        className={isMobile ? "w-full" : "w-60"}
                      >
                        <SearchField.Group>
                          <SearchField.SearchIcon />
                          <SearchField.Input placeholder="搜索名称或密钥" />
                          <SearchField.ClearButton />
                        </SearchField.Group>
                      </SearchField>
                      <Select
                        aria-label="按密钥状态筛选"
                        variant="secondary"
                        value={status}
                        onChange={(k) => {
                          if (k != null) {
                            setStatus(String(k) as ChannelAPIKeyStatus | "all")
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
                    </div>

                    {isMigrate ? (
                      <div className="row">
                        <span className="text-xs text-muted">迁移到</span>
                        <Chip color="accent" variant="soft" size="sm">
                          {liveTargetGroup?.name || targetGroupName}
                        </Chip>
                      </div>
                    ) : (
                      <div className="row flex-wrap gap-2">
                        <Tooltip>
                          <Button
                            size="sm"
                            variant="secondary"
                            isDisabled={!channel}
                            onPress={() => channel && window.open(siteKeysURL(channel), "_blank", "noopener,noreferrer")}
                          >
                            <ArrowUpRightFromSquare className="size-4" />
                            打开站点密钥页
                          </Button>
                          <Tooltip.Content>在新标签页打开上游站点的密钥管理页</Tooltip.Content>
                        </Tooltip>
                        <Tooltip>
                          <Button
                            size="sm"
                            variant="secondary"
                            isPending={renaming}
                            isDisabled={loading || items.length === 0}
                            onPress={() => void renameKeysToGroup()}
                          >
                            {renaming ? <Spinner size="sm" color="current" /> : <Tag className="size-4" />}
                            名称改为分组名
                          </Button>
                          <Tooltip.Content>把这个渠道全部密钥的名称改成各自所属的分组名</Tooltip.Content>
                        </Tooltip>
                        <Button size="sm" variant="primary" onPress={openCreate}>
                          <Plus className="size-4" />
                          新建密钥
                        </Button>
                      </div>
                    )}
                  </div>

                  {listError ? (
                    <Alert status="danger">
                      <Alert.Indicator />
                      <Alert.Content>
                        <div className="row-between gap-2">
                          <Alert.Description>{listError}</Alert.Description>
                          <Button size="sm" variant="secondary" onPress={reload}>
                            重新加载
                          </Button>
                        </div>
                      </Alert.Content>
                    </Alert>
                  ) : null}
                  {isMigrate && error ? (
                    <Alert status="danger">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Description>{error}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : null}

                  {loading ? (
                    <div className="flex justify-center py-12">
                      <Spinner />
                    </div>
                  ) : (
                    <Table variant="secondary">
                      <Table.ScrollContainer>
                        <Table.Content
                          aria-label="渠道 API 密钥列表"
                          className="min-w-[820px]"
                          selectionMode={isMigrate ? "single" : "none"}
                          selectedKeys={isMigrate && selectedKey ? new Set([selectedKey.id]) : new Set()}
                          disabledKeys={disabledMigrateKeys}
                          onSelectionChange={(keys) => {
                            if (!isMigrate || keys === "all") return
                            const picked = [...keys][0]
                            setSelectedKey(items.find((it) => it.id === Number(picked)) ?? null)
                          }}
                        >
                          <Table.Header>
                            {isMigrate ? (
                              <Table.Column id="pick" className="w-12" aria-label="选择">
                                选
                              </Table.Column>
                            ) : null}
                            <Table.Column id="name" isRowHeader className="w-36">
                              名称
                            </Table.Column>
                            <Table.Column id="key">密钥</Table.Column>
                            <Table.Column id="status" className="w-24">
                              状态
                            </Table.Column>
                            <Table.Column id="group">分组</Table.Column>
                            <Table.Column id="quota" className="w-28">
                              额度
                            </Table.Column>
                            <Table.Column id="expire" className="w-32">
                              过期
                            </Table.Column>
                            {!isMigrate ? (
                              <Table.Column id="actions" className="w-28">
                                操作
                              </Table.Column>
                            ) : null}
                          </Table.Header>
                          <Table.Body
                            items={items}
                            renderEmptyState={() => (
                              <EmptyState className="py-10 text-sm text-muted">暂无密钥</EmptyState>
                            )}
                          >
                            {(item) => {
                              const isCurrentTarget = !!(isMigrate && channel && targetGroup && keyMatchesGroup(item, channel, targetGroup))
                              const picked = selectedKey?.id === item.id
                              const full = revealedKeys[item.id]
                              const statusMeta = apiKeyStatusMeta[item.status] ?? {
                                label: item.status || "未知",
                                color: "default" as ChipColor,
                              }
                              const groupName = (item.group_name || item.group || "").trim()
                              const expireText = isNewAPI
                                ? item.expired_time === -1 || !item.expired_time
                                  ? "永不过期"
                                  : dateTime(new Date(item.expired_time * 1000).toISOString())
                                : item.expires_at
                                  ? dateTime(item.expires_at)
                                  : "永不过期"

                              return (
                                <Table.Row key={item.id} id={item.id}>
                                  {isMigrate ? (
                                    <Table.Cell>
                                      <span
                                        aria-hidden="true"
                                        className={`inline-flex size-4 items-center justify-center rounded-full border transition-colors ${
                                          picked
                                            ? "border-accent bg-accent text-accent-foreground"
                                            : "border-border bg-surface"
                                        }`}
                                      >
                                        {picked ? <Check className="size-2.5" /> : null}
                                      </span>
                                    </Table.Cell>
                                  ) : null}
                                  <Table.Cell>
                                    <span className="font-medium text-foreground">{item.name || "未命名"}</span>
                                  </Table.Cell>
                                  <Table.Cell>
                                    {isMigrate ? (
                                      <span className="mono text-xs text-muted">{maskKey(item.key)}</span>
                                    ) : full ? (
                                      <div className="row gap-1">
                                        <span className="mono break-all text-xs text-foreground">{full}</span>
                                        <Button
                                          isIconOnly
                                          size="sm"
                                          variant="ghost"
                                          aria-label="复制完整密钥"
                                          onPress={() => void copyQuickText(full)}
                                        >
                                          <Copy className="size-3.5" />
                                        </Button>
                                      </div>
                                    ) : (
                                      <Tooltip>
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          isPending={revealingID === item.id}
                                          onPress={() => void revealAndShow(item)}
                                          className="mono h-7 px-1.5 text-xs font-normal"
                                        >
                                          {revealingID === item.id ? <Spinner size="sm" color="current" /> : null}
                                          {maskKey(item.key)}
                                        </Button>
                                        <Tooltip.Content>点击显示完整密钥</Tooltip.Content>
                                      </Tooltip>
                                    )}
                                  </Table.Cell>
                                  <Table.Cell>
                                    <Chip color={statusMeta.color} variant="soft" size="sm">
                                      {statusMeta.label}
                                    </Chip>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <div className="stack gap-0.5">
                                      <div className="row flex-wrap gap-1.5">
                                        <span className="text-xs font-semibold text-foreground">
                                          {isMigrate && channel ? sourceGroupLabel(item, channel, groups) : groupDisplayName(item)}
                                        </span>
                                        {!isMigrate && groupName ? (
                                          <Tooltip>
                                            <Button
                                              isIconOnly
                                              size="sm"
                                              variant="ghost"
                                              aria-label="复制分组名"
                                              className="size-6 min-w-0"
                                              onPress={() => void copyQuickText(groupName, "已复制分组名")}
                                            >
                                              <Copy className="size-3" />
                                            </Button>
                                            <Tooltip.Content>复制分组名</Tooltip.Content>
                                          </Tooltip>
                                        ) : null}
                                        {isCurrentTarget ? (
                                          <Chip size="sm" variant="soft">
                                            已在目标分组
                                          </Chip>
                                        ) : null}
                                      </div>
                                      <span className="text-xs text-muted">
                                        {item.group_description || "无描述"}
                                        {item.group_ratio > 0 ? ` · 倍率 ${formatRatio(item.group_ratio)}` : ""}
                                      </span>
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <span className="num text-xs text-foreground">
                                      {isNewAPI
                                        ? item.unlimited_quota
                                          ? "无限"
                                          : decimal(item.quota, 0)
                                        : `${decimal(item.quota_used)}/${item.quota > 0 ? decimal(item.quota) : "无限"}`}
                                    </span>
                                  </Table.Cell>
                                  <Table.Cell>
                                    <span className="num text-xs text-muted">{expireText}</span>
                                  </Table.Cell>
                                  {!isMigrate ? (
                                    <Table.Cell>
                                      <div className="row gap-0.5">
                                        <Tooltip>
                                          <Button
                                            isIconOnly
                                            size="sm"
                                            variant="ghost"
                                            aria-label="复制完整密钥"
                                            isPending={revealingID === item.id}
                                            onPress={() => void revealAndCopy(item)}
                                          >
                                            {revealingID === item.id ? (
                                              <Spinner size="sm" color="current" />
                                            ) : (
                                              <Copy className="size-4" />
                                            )}
                                          </Button>
                                          <Tooltip.Content>复制完整密钥</Tooltip.Content>
                                        </Tooltip>
                                        <Tooltip>
                                          <Button
                                            isIconOnly
                                            size="sm"
                                            variant="ghost"
                                            aria-label="编辑"
                                            onPress={() => openEdit(item)}
                                          >
                                            <Pencil className="size-4" />
                                          </Button>
                                          <Tooltip.Content>编辑</Tooltip.Content>
                                        </Tooltip>
                                        <Tooltip>
                                          <Button
                                            isIconOnly
                                            size="sm"
                                            variant="ghost"
                                            aria-label="删除"
                                            className="text-danger"
                                            onPress={() => void deleteKey(item)}
                                          >
                                            <TrashBin className="size-4" />
                                          </Button>
                                          <Tooltip.Content>删除</Tooltip.Content>
                                        </Tooltip>
                                      </div>
                                    </Table.Cell>
                                  ) : null}
                                </Table.Row>
                              )
                            }}
                          </Table.Body>
                        </Table.Content>
                      </Table.ScrollContainer>
                      {(data?.total ?? 0) > PAGE_SIZE ? (
                        <Table.Footer>
                          <PaginationBar
                            page={page}
                            total={data?.total ?? 0}
                            pageSize={PAGE_SIZE}
                            onChange={setPage}
                            compact={isMobile}
                          />
                        </Table.Footer>
                      ) : null}
                    </Table>
                  )}
                </>
              )}

              <FormError message={isForm ? error : null} />
            </div>
          </Drawer.Body>
          {isMigrate ? (
            <Drawer.Footer className="row-between w-full">
              <span className="truncate text-xs text-muted">
                {selectedKey ? `已选择：${selectedKey.name || selectedKey.id}` : "选一个要迁移的密钥"}
              </span>
              <div className="row shrink-0">
                <Button variant="tertiary" isDisabled={submitting} onPress={onClose}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  isPending={submitting}
                  isDisabled={groupsLoading || targetValidationError != null || selectedKey == null}
                  onPress={() => void migrateSelectedKey()}
                >
                  {submitting ? <Spinner size="sm" color="current" /> : null}
                  迁移
                </Button>
              </div>
            </Drawer.Footer>
          ) : isForm ? (
            <Drawer.Footer className="flex justify-end gap-2">
              <Button variant="tertiary" isDisabled={submitting} onPress={backToList}>
                返回列表
              </Button>
              <Button
                variant="primary"
                isPending={submitting}
                isDisabled={groupsLoading || targetValidationError != null}
                onPress={() => void handleSubmit()}
              >
                {submitting ? <Spinner size="sm" color="current" /> : null}
                {mode === "create" ? "创建" : "保存"}
              </Button>
            </Drawer.Footer>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  )
}

function SwitchField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Surface variant="secondary" className="self-end rounded-xl px-3 py-2.5">
      <Switch isSelected={checked} isDisabled={disabled} onChange={onChange} className="w-full">
        <Switch.Content className="w-full justify-between">
          <Label className="text-sm text-foreground">{label}</Label>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </Surface>
  )
}

function GroupSelect({
  label,
  value,
  onChange,
  groups,
  byID,
  disabled,
  loading,
}: {
  label: string
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
    <Select
      variant="secondary"
      fullWidth
      value={value || null}
      onChange={(k) => onChange(k == null ? "" : String(k))}
      isDisabled={disabled || loading}
      placeholder={loading ? "加载中…" : "选择分组"}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value>
          {({ isPlaceholder, defaultChildren }) =>
            isPlaceholder || !selected ? defaultChildren : `${selected.name} · ${formatRatio(selected.ratio)}`
          }
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      {selected ? (
        <Description>
          {selected.description || "无描述"} · 倍率 {formatRatio(selected.ratio)}
        </Description>
      ) : null}
      <Select.Popover className="max-w-[420px]">
        <ListBox renderEmptyState={() => <div className="px-3 py-2 text-xs text-muted">暂无分组</div>}>
          {options.map((g) => {
            const v = byID ? String(g.id) : g.name
            const text = `${g.name} · ${formatRatio(g.ratio)}`
            return (
              <ListBox.Item key={v} id={v} textValue={text}>
                <div className="stack gap-0">
                  <span className="text-sm">{text}</span>
                  <span className="whitespace-normal text-xs text-muted">{g.description || "无描述"}</span>
                </div>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            )
          })}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

const formGridClass = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"

function KeyFormFields({
  form,
  setForm,
  mode,
  isNewAPI,
  disabled,
  groups,
  groupsLoading,
  groupLocked,
}: {
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
    <div className="stack gap-4">
      <div className={formGridClass}>
        <TextField variant="secondary" fullWidth value={form.name} onChange={set("name")} isDisabled={disabled} isRequired>
          <Label>名称</Label>
          <Input />
        </TextField>

        {mode === "create" ? (
          <TextField variant="secondary" fullWidth value={form.custom_key} onChange={set("custom_key")} isDisabled={disabled}>
            <Label>自定义密钥</Label>
            <Input placeholder="留空由上游生成" />
          </TextField>
        ) : (
          <Select
            variant="secondary"
            fullWidth
            value={form.status}
            onChange={(k) => k != null && set("status")(String(k) as KeyForm["status"])}
            isDisabled={disabled}
          >
            <Label>状态</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item id="active" textValue="启用">
                  启用
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item id="disabled" textValue="停用">
                  停用
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        )}

        <GroupSelect
          label={isNewAPI ? "分组" : "分组 ID"}
          value={isNewAPI ? form.group : form.group_id}
          onChange={isNewAPI ? set("group") : set("group_id")}
          groups={groups}
          byID={!isNewAPI}
          disabled={disabled || groupLocked}
          loading={groupsLoading}
        />
      </div>

      {isNewAPI ? (
        <>
          <div className={formGridClass}>
            <TextField variant="secondary" fullWidth value={form.remain_quota} onChange={set("remain_quota")} isDisabled={disabled}>
              <Label>剩余额度</Label>
              <Input inputMode="numeric" />
            </TextField>
            <TextField variant="secondary" fullWidth value={form.expired_time} onChange={set("expired_time")} isDisabled={disabled}>
              <Label>过期时间戳</Label>
              <Input inputMode="numeric" />
              <Description>Unix 秒，-1 表示永不过期。</Description>
            </TextField>
          </div>
          <div className={formGridClass}>
            <SwitchField label="无限额度" checked={form.unlimited_quota} disabled={disabled} onChange={set("unlimited_quota")} />
            <SwitchField label="启用模型限制" checked={form.model_limits_enabled} disabled={disabled} onChange={set("model_limits_enabled")} />
            <SwitchField label="跨分组重试" checked={form.cross_group_retry} disabled={disabled} onChange={set("cross_group_retry")} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField variant="secondary" fullWidth value={form.model_limits} onChange={set("model_limits")} isDisabled={disabled}>
              <Label>模型限制</Label>
              <TextArea placeholder="逗号分隔" rows={3} />
            </TextField>
            <TextField variant="secondary" fullWidth value={form.allow_ips} onChange={set("allow_ips")} isDisabled={disabled}>
              <Label>允许 IP</Label>
              <TextArea placeholder="每行一个 IP" rows={3} />
            </TextField>
          </div>
        </>
      ) : (
        <>
          <div className={formGridClass}>
            <TextField variant="secondary" fullWidth value={form.quota} onChange={set("quota")} isDisabled={disabled}>
              <Label>额度（USD）</Label>
              <Input inputMode="decimal" />
            </TextField>
            {mode === "create" ? (
              <TextField variant="secondary" fullWidth value={form.expires_in_days} onChange={set("expires_in_days")} isDisabled={disabled}>
                <Label>过期天数</Label>
                <Input placeholder="留空永不过期" inputMode="numeric" />
              </TextField>
            ) : (
              <TextField variant="secondary" fullWidth value={form.expires_at} onChange={set("expires_at")} isDisabled={disabled}>
                <Label>过期时间</Label>
                <Input type="datetime-local" />
              </TextField>
            )}
            <TextField variant="secondary" fullWidth value={form.rate_limit_5h} onChange={set("rate_limit_5h")} isDisabled={disabled}>
              <Label>5 小时限额</Label>
              <Input inputMode="decimal" />
            </TextField>
            <TextField variant="secondary" fullWidth value={form.rate_limit_1d} onChange={set("rate_limit_1d")} isDisabled={disabled}>
              <Label>1 天限额</Label>
              <Input inputMode="decimal" />
            </TextField>
            <TextField variant="secondary" fullWidth value={form.rate_limit_7d} onChange={set("rate_limit_7d")} isDisabled={disabled}>
              <Label>7 天限额</Label>
              <Input inputMode="decimal" />
            </TextField>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField variant="secondary" fullWidth value={form.ip_whitelist} onChange={set("ip_whitelist")} isDisabled={disabled}>
              <Label>IP 白名单</Label>
              <TextArea placeholder="每行一个 IP 或 CIDR" rows={3} />
            </TextField>
            <TextField variant="secondary" fullWidth value={form.ip_blacklist} onChange={set("ip_blacklist")} isDisabled={disabled}>
              <Label>IP 黑名单</Label>
              <TextArea placeholder="每行一个 IP 或 CIDR" rows={3} />
            </TextField>
          </div>
          {mode === "edit" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SwitchField label="重置额度" checked={form.reset_quota} disabled={disabled} onChange={set("reset_quota")} />
              <SwitchField label="重置限额用量" checked={form.reset_rate_limit_usage} disabled={disabled} onChange={set("reset_rate_limit_usage")} />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
