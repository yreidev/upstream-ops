import { useEffect, useMemo, useState } from "react"
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Description,
  EmptyState,
  Input,
  Label,
  ListBox,
  Modal,
  ScrollShadow,
  Select,
  Separator,
  Spinner,
  Surface,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react"
import { Plus, TrashBin } from "@gravity-ui/icons"
import { apiFetch } from "@/lib/api"
import type { NotificationChannel, NotificationChannelType, NotificationEvent } from "@/lib/api-types"
import { useChannels, useMultiChannelRates } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { FormError } from "@/components/common/form-error"
import { PasswordInput } from "@/components/common/password-input"

interface ConfigState {
  // telegram
  bot_token: string
  chat_id: string
  // wecom
  webhook_url: string
}

interface SubRow {
  channel_ids: number[]
  /** 订阅全部渠道（含之后新增的） */
  all_channels: boolean
  event_mode: "all" | "custom"
  events: NotificationEvent[]
  mode: "all" | "groups"
  groups: string[]
}

interface FormState {
  name: string
  type: NotificationChannelType
  enabled: boolean
  cfg: ConfigState
  subs: SubRow[]
}

function emptyConfig(): ConfigState {
  return { bot_token: "", chat_id: "", webhook_url: "" }
}

const notificationEventOptions: Array<{ id: string; label: string; events: NotificationEvent[] }> = [
  { id: "balance_low", label: "余额不足", events: ["balance_low"] },
  { id: "rate_changed", label: "倍率变化", events: ["rate_changed"] },
  { id: "rate_group_changed", label: "分组变动", events: ["rate_structure_changed", "rate_added", "rate_removed"] },
  { id: "announcement", label: "上游公告", events: ["announcement"] },
  { id: "login_failed", label: "登录失败", events: ["login_failed"] },
  { id: "captcha_failed", label: "验证码失败", events: ["captcha_failed"] },
  { id: "monitor_failed", label: "采集失败", events: ["monitor_failed"] },
  { id: "recovered", label: "故障恢复", events: ["recovered"] },
]

const allNotificationEvents = Array.from(new Set(notificationEventOptions.flatMap((option) => option.events)))

const rateEventSet = new Set<NotificationEvent>(["rate_changed", "rate_structure_changed", "rate_added", "rate_removed"])

function hasRateEvents(row: SubRow) {
  return row.event_mode === "all" || row.events.some((event) => rateEventSet.has(event))
}

function initialState(c?: NotificationChannel | null): FormState {
  let subs: SubRow[] = []
  if (c?.subscriptions) {
    try {
      // 宽松解析：兼容历史 channel_id 单值格式（旧数据由后端原样返回）
      const parsed = JSON.parse(c.subscriptions) as Array<Record<string, unknown>>
      subs = parsed.map((s) => {
        const ids = (s.channel_ids as number[] | undefined) ?? []
        const legacyId = s.channel_id as number | undefined
        const channel_ids = ids.length > 0 ? ids : legacyId != null ? [legacyId] : []
        const events = (s.events as NotificationEvent[] | undefined) ?? []
        return {
          channel_ids,
          all_channels: s.all_channels === true,
          event_mode: events.length > 0 ? "custom" : "all",
          events,
          mode: s.mode === "groups" ? "groups" : "all",
          groups: (s.groups as string[] | undefined) ?? [],
        }
      })
    } catch {
      subs = []
    }
  }
  return {
    name: c?.name ?? "",
    type: c?.type ?? "telegram",
    enabled: c?.enabled ?? true,
    cfg: emptyConfig(),
    subs,
  }
}

// buildConfigByType 把 cfg 序列化成各通知方式期望的 JSON。
function buildConfigByType(type: NotificationChannelType, cfg: ConfigState): string {
  switch (type) {
    case "telegram":
      return JSON.stringify({ bot_token: cfg.bot_token, chat_id: cfg.chat_id })
    case "wecom":
      return JSON.stringify({ webhook_url: cfg.webhook_url })
  }
}

/** 新增或编辑通知渠道。channel 为空时是新增。 */
export function NotificationFormModal({
  visible,
  onClose,
  channel,
}: {
  visible: boolean
  onClose: () => void
  channel?: NotificationChannel | null
}) {
  const [form, setForm] = useState<FormState>(() => initialState(channel))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useTriggerRefresh()
  const channels = useChannels()
  const isEdit = !!channel

  useEffect(() => {
    if (visible) {
      setForm(initialState(channel))
      setError(null)
    }
  }, [visible, channel])

  function updateCfg(patch: Partial<ConfigState>) {
    setForm((f) => ({ ...f, cfg: { ...f.cfg, ...patch } }))
  }

  function addSub() {
    setForm((f) => ({
      ...f,
      subs: [...f.subs, { channel_ids: [], all_channels: false, event_mode: "all", events: [], mode: "all", groups: [] }],
    }))
  }

  function updateSub(idx: number, patch: Partial<SubRow>) {
    setForm((f) => {
      const next = f.subs.slice()
      next[idx] = { ...next[idx], ...patch }
      return { ...f, subs: next }
    })
  }

  function removeSub(idx: number) {
    setForm((f) => ({ ...f, subs: f.subs.filter((_, i) => i !== idx) }))
  }

  async function handleOk() {
    setError(null)
    try {
      if (!form.name.trim()) throw new Error("请填写渠道名")
      // 未选渠道的订阅规则不能保存
      for (const s of form.subs) {
        if (!s.all_channels && s.channel_ids.length === 0) {
          throw new Error("订阅规则里有没选渠道的，请补全或删除")
        }
        if (s.event_mode === "custom" && s.events.length === 0) {
          throw new Error("指定事件时至少选一个事件")
        }
      }
      const hasConfigInput =
        form.type === "telegram" ? !!(form.cfg.bot_token || form.cfg.chat_id) : !!form.cfg.webhook_url
      if (!isEdit) {
        if (form.type === "telegram" && (!form.cfg.bot_token || !form.cfg.chat_id)) {
          throw new Error("请填写 Bot Token 和 Chat ID")
        }
        if (form.type === "wecom" && !form.cfg.webhook_url) throw new Error("请填写 Webhook URL")
      }
      const configJSON = !isEdit || hasConfigInput ? buildConfigByType(form.type, form.cfg) : ""

      const subscriptions = JSON.stringify(
        form.subs.map((s) => {
          const mode = hasRateEvents(s) ? s.mode : "all"
          return {
            // 全部渠道时仍写入当前全部 ID，回滚到不认识 all_channels 的旧版本照样能用
            channel_ids: s.all_channels && channels.data ? channels.data.map((c) => c.id) : s.channel_ids,
            ...(s.all_channels ? { all_channels: true } : {}),
            mode,
            groups: mode === "groups" ? s.groups : [],
            events: s.event_mode === "custom" ? s.events : [],
          }
        }),
      )

      const body: Record<string, unknown> = {
        name: form.name,
        type: form.type,
        enabled: form.enabled,
        subscriptions,
      }
      if (configJSON) body.config = configJSON

      setSubmitting(true)
      if (isEdit) {
        await apiFetch(`/notifications/channels/${channel!.id}`, { method: "PUT", body: JSON.stringify(body) })
      } else {
        await apiFetch(`/notifications/channels`, { method: "POST", body: JSON.stringify(body) })
      }
      onClose()
      refresh()
    } catch (e) {
      setError((e as Error).message || "保存失败")
    } finally {
      setSubmitting(false)
    }
  }

  const channelOptions = (channels.data ?? []).map((c) => ({ id: c.id, name: c.name }))
  const configHint = isEdit ? "编辑时留空保留原值" : undefined

  return (
    <Modal.Backdrop
      isOpen={visible}
      isDismissable={!submitting}
      isKeyboardDismissDisabled={submitting}
      onOpenChange={(open) => !open && !submitting && onClose()}
    >
      <Modal.Container size="lg" scroll="inside" className="w-[min(720px,calc(100vw-24px))] max-w-none">
        <Modal.Dialog className="w-full max-w-none">
          <Modal.CloseTrigger isDisabled={submitting} />
          <Modal.Header>
            <Modal.Heading>{isEdit ? "编辑通知渠道" : "新增通知渠道"}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="max-h-[70vh] overflow-y-auto">
            <div className="stack gap-3.5">
              <TextField
                variant="secondary"
                fullWidth
                isRequired
                isDisabled={submitting}
                value={form.name}
                onChange={(v) => setForm({ ...form, name: v })}
              >
                <Label>渠道名</Label>
                <Input placeholder="例如：TG-运维群" />
              </TextField>

              <Select
                variant="secondary"
                fullWidth
                value={form.type}
                onChange={(k) => k != null && setForm({ ...form, type: String(k) as NotificationChannelType, cfg: emptyConfig() })}
                isDisabled={isEdit || submitting}
              >
                <Label>类型</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="telegram" textValue="Telegram">
                      Telegram
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="wecom" textValue="企业微信">
                      企业微信
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
                {isEdit ? <Description>类型创建后不可修改</Description> : null}
              </Select>

              {form.type === "telegram" ? (
                <>
                  <TextField
                    variant="secondary"
                    fullWidth
                    isRequired={!isEdit}
                    isDisabled={submitting}
                    value={form.cfg.bot_token}
                    onChange={(v) => updateCfg({ bot_token: v })}
                  >
                    <Label>Bot Token</Label>
                    <PasswordInput variant="secondary" fullWidth placeholder="123456:ABC-..." />
                    {configHint ? <Description>{configHint}</Description> : null}
                  </TextField>
                  <TextField
                    variant="secondary"
                    fullWidth
                    isRequired={!isEdit}
                    isDisabled={submitting}
                    value={form.cfg.chat_id}
                    onChange={(v) => updateCfg({ chat_id: v })}
                  >
                    <Label>Chat ID</Label>
                    <Input placeholder="-1001234567890 或 @channelname" />
                    {configHint ? <Description>{configHint}</Description> : null}
                  </TextField>
                </>
              ) : (
                <TextField
                  variant="secondary"
                  fullWidth
                  isRequired={!isEdit}
                  isDisabled={submitting}
                  value={form.cfg.webhook_url}
                  onChange={(v) => updateCfg({ webhook_url: v })}
                >
                  <Label>Webhook URL</Label>
                  <PasswordInput variant="secondary" fullWidth />
                  {configHint ? <Description>{configHint}</Description> : null}
                </TextField>
              )}

              <Surface variant="secondary" className="rounded-xl p-3">
                <Switch
                  isSelected={form.enabled}
                  onChange={(v) => setForm({ ...form, enabled: v })}
                  isDisabled={submitting}
                  className="w-full justify-between"
                >
                  <Switch.Content className="w-full justify-between">
                    <div className="stack gap-0.5">
                      <Label className="text-sm font-medium">启用</Label>
                      <Description className="text-xs">关闭后不会向此渠道推送</Description>
                    </div>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              </Surface>

              <Separator />

              <div className="stack gap-2.5">
                <div className="row-between">
                  <div className="stack gap-0.5">
                    <Label className="text-sm font-medium">订阅规则</Label>
                    <Description className="text-xs">不加规则 = 收到所有渠道的所有事件；加了规则后只收命中的</Description>
                  </div>
                  <Button size="sm" variant="secondary" onPress={addSub} isDisabled={submitting}>
                    <Plus className="size-3.5" />
                    添加
                  </Button>
                </div>
                {form.subs.length === 0 ? (
                  <Alert status="accent">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description>暂无订阅规则，所有事件都会收到。</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : (
                  <div className="stack gap-2.5">
                    {form.subs.map((row, idx) => (
                      <SubRowEditor
                        key={idx}
                        index={idx}
                        row={row}
                        channels={channelOptions}
                        onChange={(patch) => updateSub(idx, patch)}
                        onRemove={() => removeSub(idx)}
                        disabled={submitting}
                      />
                    ))}
                  </div>
                )}
              </div>

              <FormError message={error} />
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" isDisabled={submitting} onPress={onClose}>
              取消
            </Button>
            <Button variant="primary" isPending={submitting} onPress={() => void handleOk()}>
              {submitting ? <Spinner size="sm" color="current" /> : null}
              保存
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

function SubRowEditor({
  index,
  row,
  channels,
  onChange,
  onRemove,
  disabled,
}: {
  index: number
  row: SubRow
  channels: Array<{ id: number; name: string }>
  onChange: (patch: Partial<SubRow>) => void
  onRemove: () => void
  disabled: boolean
}) {
  // 只有选了“指定分组”才拉倍率，避免每条规则都请求一次
  const showRateGroupFilter = hasRateEvents(row)
  const effectiveChannelIDs = row.all_channels ? channels.map((c) => c.id) : row.channel_ids
  const rates = useMultiChannelRates(showRateGroupFilter && row.mode === "groups" ? effectiveChannelIDs : [])

  const channelNameMap = useMemo(() => new Map(channels.map((c) => [c.id, c.name] as const)), [channels])

  const groupsByChannel = useMemo(() => {
    const map = new Map<number, Set<string>>()
    for (const r of rates.data ?? []) {
      if (!map.has(r.channel_id)) map.set(r.channel_id, new Set())
      map.get(r.channel_id)!.add(r.model_name)
    }
    return Array.from(map.entries())
      .map(([channelId, groups]) => ({
        channelId,
        channelName: channelNameMap.get(channelId) ?? `渠道 ${channelId}`,
        groups: Array.from(groups).sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.channelName.localeCompare(b.channelName))
  }, [rates.data, channelNameMap])

  const groupNames = useMemo(() => {
    const set = new Set<string>()
    for (const r of rates.data ?? []) set.add(r.model_name)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [rates.data])

  const selectedGroupCount = groupNames.filter((name) => row.groups.includes(name)).length
  const selectedEventCount = notificationEventOptions.filter((o) => o.events.some((e) => row.events.includes(e))).length
  const allEventsSelected = allNotificationEvents.every((e) => row.events.includes(e))

  function toggleGroup(name: string, checked: boolean) {
    onChange({ groups: checked ? Array.from(new Set([...row.groups, name])) : row.groups.filter((g) => g !== name) })
  }

  function toggleEventOption(events: NotificationEvent[], checked: boolean) {
    const set = new Set(events)
    onChange({ events: checked ? Array.from(new Set([...row.events, ...events])) : row.events.filter((e) => !set.has(e)) })
  }

  return (
    <Card variant="secondary" className="rounded-2xl p-3.5">
      <Card.Header className="flex-row items-center justify-between gap-2 pb-2">
        <Card.Title className="text-xs font-semibold">规则 {index + 1}</Card.Title>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="删除规则"
          className="text-danger"
          isDisabled={disabled}
          onPress={onRemove}
        >
          <TrashBin className="size-4" />
        </Button>
      </Card.Header>
      <Separator />
      <Card.Content className="stack gap-3 pt-3">
        <div className="stack gap-1.5">
          <div className="row gap-2">
            <Label className="text-xs">渠道</Label>
            <Description className="text-xs">
              已选 {effectiveChannelIDs.length}/{channels.length}
            </Description>
          </div>
          <Checkbox
            isSelected={row.all_channels}
            onChange={(checked) =>
              onChange({ all_channels: checked, channel_ids: checked ? channels.map((c) => c.id) : [] })
            }
            isDisabled={disabled}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <Label className="text-sm font-normal">全部渠道（含之后新增的）</Label>
            </Checkbox.Content>
          </Checkbox>
          {!row.all_channels ? (
            <Select
              aria-label="选择订阅渠道"
              selectionMode="multiple"
              fullWidth
              placeholder="选择渠道"
              value={row.channel_ids.map(String)}
              onChange={(keys) => {
                const list = Array.isArray(keys) ? keys.map((k) => Number(k)).filter(Number.isFinite) : []
                onChange({ channel_ids: list, all_channels: false })
              }}
              isDisabled={disabled}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox renderEmptyState={() => <div className="px-3 py-2 text-xs text-muted">暂无可选渠道</div>}>
                  {channels.map((c) => (
                    <ListBox.Item key={c.id} id={String(c.id)} textValue={c.name}>
                      {c.name}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          ) : null}
        </div>

        <div className="stack gap-1.5">
          <Label className="text-xs">事件</Label>
          <ToggleButtonGroup
            aria-label="事件范围"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([row.event_mode])}
            onSelectionChange={(keys) => {
              const first = [...keys][0]
              if (first == null) return
              const eventMode = String(first) as "all" | "custom"
              onChange({ event_mode: eventMode, events: eventMode === "all" ? [] : row.events })
            }}
            isDisabled={disabled}
            size="sm"
          >
            <ToggleButton id="all">全部事件</ToggleButton>
            <ToggleButton id="custom">指定事件</ToggleButton>
          </ToggleButtonGroup>

          {row.event_mode === "custom" ? (
            <Surface className="mt-1 rounded-xl border border-separator p-2.5">
              <div className="row-between mb-1.5">
                <Checkbox
                  isSelected={allEventsSelected}
                  isIndeterminate={row.events.length > 0 && !allEventsSelected}
                  onChange={(checked) => onChange({ events: checked ? allNotificationEvents : [] })}
                  isDisabled={disabled}
                >
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Label className="text-xs font-medium">全选事件</Label>
                  </Checkbox.Content>
                </Checkbox>
                <span className="num text-xs text-muted">
                  已选 {selectedEventCount}/{notificationEventOptions.length}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {notificationEventOptions.map((option) => {
                  const matched = option.events.filter((e) => row.events.includes(e)).length
                  return (
                    <Checkbox
                      key={option.id}
                      isSelected={matched === option.events.length}
                      isIndeterminate={matched > 0 && matched < option.events.length}
                      onChange={(checked) => toggleEventOption(option.events, checked)}
                      isDisabled={disabled}
                    >
                      <Checkbox.Content>
                        <Checkbox.Control>
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                        <Label className="text-xs font-normal">{option.label}</Label>
                      </Checkbox.Content>
                    </Checkbox>
                  )
                })}
              </div>
            </Surface>
          ) : null}
        </div>

        {showRateGroupFilter ? (
          <div className="stack gap-1.5">
            <div className="row gap-2">
              <Label className="text-xs">倍率分组</Label>
              <Description className="text-xs">只影响倍率类事件</Description>
            </div>
            <ToggleButtonGroup
              aria-label="倍率分组范围"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={new Set([row.mode])}
              onSelectionChange={(keys) => {
                const first = [...keys][0]
                if (first != null) onChange({ mode: String(first) as "all" | "groups", groups: [] })
              }}
              isDisabled={disabled}
              size="sm"
            >
              <ToggleButton id="all">所有分组</ToggleButton>
              <ToggleButton id="groups">指定分组</ToggleButton>
            </ToggleButtonGroup>

            {row.mode === "groups" ? (
              <div className="mt-1">
                {effectiveChannelIDs.length === 0 ? (
                  <span className="text-xs text-muted">请先选择渠道</span>
                ) : rates.loading ? (
                  <Spinner size="sm" />
                ) : groupNames.length === 0 ? (
                  <EmptyState className="py-4 text-xs text-muted">
                    所选渠道还没采集到分组，先去渠道页同步一次
                  </EmptyState>
                ) : (
                  <Surface className="rounded-xl border border-separator p-2.5">
                    <div className="row-between mb-1.5">
                      <Checkbox
                        isSelected={selectedGroupCount === groupNames.length}
                        isIndeterminate={selectedGroupCount > 0 && selectedGroupCount < groupNames.length}
                        onChange={(checked) => onChange({ groups: checked ? groupNames : [] })}
                        isDisabled={disabled}
                      >
                        <Checkbox.Content>
                          <Checkbox.Control>
                            <Checkbox.Indicator />
                          </Checkbox.Control>
                          <Label className="text-xs font-medium">全选</Label>
                        </Checkbox.Content>
                      </Checkbox>
                      <span className="num text-xs text-muted">
                        已选 {selectedGroupCount}/{groupNames.length}
                      </span>
                    </div>
                    <ScrollShadow className="stack max-h-60 gap-2 pr-1">
                      {groupsByChannel.map(({ channelId, channelName, groups }) => (
                        <div key={channelId}>
                          <span className="text-xs font-medium text-muted">{channelName}</span>
                          <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                            {groups.map((name) => (
                              <Checkbox
                                key={name}
                                isSelected={row.groups.includes(name)}
                                onChange={(checked) => toggleGroup(name, checked)}
                                isDisabled={disabled}
                              >
                                <Checkbox.Content className="min-w-0">
                                  <Checkbox.Control>
                                    <Checkbox.Indicator />
                                  </Checkbox.Control>
                                  <span className="truncate text-xs" title={name}>
                                    {name}
                                  </span>
                                </Checkbox.Content>
                              </Checkbox>
                            ))}
                          </div>
                        </div>
                      ))}
                    </ScrollShadow>
                  </Surface>
                )}
                {row.groups.length === 0 && effectiveChannelIDs.length > 0 && groupNames.length > 0 ? (
                  <span className="mt-1 block text-xs text-warning">没勾任何分组，倍率类事件不会命中</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Card.Content>
    </Card>
  )
}
