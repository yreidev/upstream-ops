import { useEffect, useMemo, useState } from "react"
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  Modal,
  Radio,
  RadioGroup,
  Select,
  Spin,
  Switch,
  Typography,
} from "@douyinfe/semi-ui"
import { IconDelete, IconPlus } from "@douyinfe/semi-icons"
import { apiFetch } from "@/lib/api"
import type { NotificationChannel, NotificationChannelType, NotificationEvent } from "@/lib/api-types"
import { useChannels, useMultiChannelRates } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { FormError } from "@/components/common/form-error"

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

function FieldLabel({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <Typography.Text strong size="small">
        {children}
      </Typography.Text>
      {extra ? (
        <Typography.Text type="tertiary" size="small" style={{ marginLeft: 8 }}>
          {extra}
        </Typography.Text>
      ) : null}
    </div>
  )
}

/** 新增或编辑通知渠道。channel 为空时是新增。 */
export function NotificationFormModal({ visible, onClose, channel }: {
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
    <Modal
      visible={visible}
      title={isEdit ? "编辑通知渠道" : "新增通知渠道"}
      onCancel={onClose}
      onOk={handleOk}
      okText="保存"
      confirmLoading={submitting}
      width={720}
      bodyStyle={{ maxHeight: "70vh", overflowY: "auto" }}
    >
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <FieldLabel>渠道名</FieldLabel>
          <Input placeholder="例如：TG-运维群" value={form.name} onChange={(v) => setForm({ ...form, name: v })} disabled={submitting} />
        </div>
        <div>
          <FieldLabel extra={isEdit ? "类型创建后不可修改" : undefined}>类型</FieldLabel>
          <Select
            value={form.type}
            onChange={(v) => setForm({ ...form, type: v as NotificationChannelType, cfg: emptyConfig() })}
            disabled={isEdit || submitting}
            style={{ width: "100%" }}
            optionList={[
              { value: "telegram", label: "Telegram" },
              { value: "wecom", label: "企业微信" },
            ]}
          />
        </div>

        {form.type === "telegram" ? (
          <>
            <div>
              <FieldLabel extra={configHint}>Bot Token</FieldLabel>
              <Input mode="password" placeholder="123456:ABC-..." value={form.cfg.bot_token} onChange={(v) => updateCfg({ bot_token: v })} disabled={submitting} />
            </div>
            <div>
              <FieldLabel extra={configHint}>Chat ID</FieldLabel>
              <Input placeholder="-1001234567890 或 @channelname" value={form.cfg.chat_id} onChange={(v) => updateCfg({ chat_id: v })} disabled={submitting} />
            </div>
          </>
        ) : (
          <div>
            <FieldLabel extra={configHint}>Webhook URL</FieldLabel>
            <Input mode="password" value={form.cfg.webhook_url} onChange={(v) => updateCfg({ webhook_url: v })} disabled={submitting} />
          </div>
        )}

        <div className="row-between">
          <div className="stack" style={{ gap: 0 }}>
            <Typography.Text strong size="small">启用</Typography.Text>
            <Typography.Text type="tertiary" size="small">关闭后不会向此渠道推送</Typography.Text>
          </div>
          <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} disabled={submitting} />
        </div>

        <div>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <div className="stack" style={{ gap: 0 }}>
              <Typography.Text strong size="small">订阅规则</Typography.Text>
              <Typography.Text type="tertiary" size="small">不加规则 = 收到所有渠道的所有事件；加了规则后只收命中的</Typography.Text>
            </div>
            <Button size="small" icon={<IconPlus />} onClick={addSub} disabled={submitting}>
              添加
            </Button>
          </div>
          {form.subs.length === 0 ? (
            <Banner fullMode={false} type="info" closeIcon={null} description="暂无订阅规则，所有事件都会收到。" />
          ) : (
            <div className="stack" style={{ gap: 10 }}>
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
    </Modal>
  )
}

function SubRowEditor({ index, row, channels, onChange, onRemove, disabled }: {
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
    <Card
      bodyStyle={{ padding: 12 }}
      title={<Typography.Text strong size="small">规则 {index + 1}</Typography.Text>}
      headerStyle={{ padding: "8px 12px" }}
      headerExtraContent={
        <Button theme="borderless" type="danger" size="small" icon={<IconDelete />} onClick={onRemove} disabled={disabled} aria-label="删除规则" />
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div>
          <FieldLabel extra={`已选 ${effectiveChannelIDs.length}/${channels.length}`}>渠道</FieldLabel>
          <Checkbox
            checked={row.all_channels}
            onChange={(e) => onChange({ all_channels: !!e.target.checked, channel_ids: e.target.checked ? channels.map((c) => c.id) : [] })}
            disabled={disabled}
            style={{ marginBottom: 6 }}
          >
            全部渠道（含之后新增的）
          </Checkbox>
          {row.all_channels ? null : (
            <Select
              multiple
              filter
              maxTagCount={4}
              placeholder="选择渠道"
              value={row.channel_ids}
              onChange={(v) => onChange({ channel_ids: (v as number[]) ?? [], all_channels: false })}
              disabled={disabled}
              style={{ width: "100%" }}
              optionList={channels.map((c) => ({ value: c.id, label: c.name }))}
              emptyContent="暂无可选渠道"
            />
          )}
        </div>

        <div>
          <FieldLabel>事件</FieldLabel>
          <RadioGroup
            value={row.event_mode}
            onChange={(e) => {
              const eventMode = e.target.value as "all" | "custom"
              onChange({ event_mode: eventMode, events: eventMode === "all" ? [] : row.events })
            }}
            disabled={disabled}
          >
            <Radio value="all">全部事件</Radio>
            <Radio value="custom">指定事件</Radio>
          </RadioGroup>
          {row.event_mode === "custom" ? (
            <div style={{ marginTop: 8 }}>
              <div className="row-between" style={{ marginBottom: 6 }}>
                <Checkbox
                  checked={allEventsSelected}
                  indeterminate={row.events.length > 0 && !allEventsSelected}
                  onChange={(e) => onChange({ events: e.target.checked ? allNotificationEvents : [] })}
                  disabled={disabled}
                >
                  全选事件
                </Checkbox>
                <Typography.Text type="tertiary" size="small">
                  已选 {selectedEventCount}/{notificationEventOptions.length}
                </Typography.Text>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 6 }}>
                {notificationEventOptions.map((option) => {
                  const matched = option.events.filter((e) => row.events.includes(e)).length
                  return (
                    <Checkbox
                      key={option.id}
                      checked={matched === option.events.length}
                      indeterminate={matched > 0 && matched < option.events.length}
                      onChange={(e) => toggleEventOption(option.events, !!e.target.checked)}
                      disabled={disabled}
                    >
                      {option.label}
                    </Checkbox>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>

        {showRateGroupFilter ? (
          <div>
            <FieldLabel extra="只影响倍率类事件">倍率分组</FieldLabel>
            <RadioGroup
              value={row.mode}
              onChange={(e) => onChange({ mode: e.target.value as "all" | "groups", groups: [] })}
              disabled={disabled}
            >
              <Radio value="all">所有分组</Radio>
              <Radio value="groups">指定分组</Radio>
            </RadioGroup>
            {row.mode === "groups" ? (
              <div style={{ marginTop: 8 }}>
                {effectiveChannelIDs.length === 0 ? (
                  <Typography.Text type="tertiary" size="small">请先选择渠道</Typography.Text>
                ) : rates.loading ? (
                  <Spin size="small" />
                ) : groupNames.length === 0 ? (
                  <Empty description="所选渠道还没采集到分组，先去渠道页同步一次" />
                ) : (
                  <>
                    <div className="row-between" style={{ marginBottom: 6 }}>
                      <Checkbox
                        checked={selectedGroupCount === groupNames.length}
                        indeterminate={selectedGroupCount > 0 && selectedGroupCount < groupNames.length}
                        onChange={(e) => onChange({ groups: e.target.checked ? groupNames : [] })}
                        disabled={disabled}
                      >
                        全选
                      </Checkbox>
                      <Typography.Text type="tertiary" size="small">
                        已选 {selectedGroupCount}/{groupNames.length}
                      </Typography.Text>
                    </div>
                    <div
                      className="stack"
                      style={{
                        gap: 8,
                        maxHeight: 256,
                        overflowY: "auto",
                        padding: 8,
                        borderRadius: 6,
                        background: "var(--semi-color-fill-0)",
                      }}
                    >
                      {groupsByChannel.map(({ channelId, channelName, groups }) => (
                        <div key={channelId}>
                          <Typography.Text type="tertiary" size="small">
                            {channelName}
                          </Typography.Text>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 4, marginTop: 4 }}>
                            {groups.map((name) => (
                              <Checkbox
                                key={name}
                                checked={row.groups.includes(name)}
                                onChange={(e) => toggleGroup(name, !!e.target.checked)}
                                disabled={disabled}
                              >
                                <span className="truncate">{name}</span>
                              </Checkbox>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {row.groups.length === 0 && effectiveChannelIDs.length > 0 && groupNames.length > 0 ? (
                  <Typography.Text type="warning" size="small">
                    没勾任何分组，倍率类事件不会命中
                  </Typography.Text>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}
