import { useEffect, useState, type ReactNode } from "react"
import {
  Divider,
  Input,
  Modal,
  Popover,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TagInput,
  TextArea,
  Typography,
} from "@douyinfe/semi-ui"
import { IconHelpCircle } from "@douyinfe/semi-icons"
import type { Channel, ChannelType, CredentialMode, RechargeMultiplierMode } from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { channelTagKey } from "@/lib/channel-tags"
import { useCaptchaConfigs } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { FormError } from "@/components/common/form-error"

/**
 * FormState 是表单的所有可编辑字段。
 *
 * password 字段在 token 模式下不展示；token 字段（cookie / user_id / access_token）在 password 模式下不展示。
 * 这些状态都留在内存里，来回切换不丢输入。
 */
interface FormState {
  name: string
  type: ChannelType
  site_url: string
  username: string
  sort_order: string
  password: string
  login_extra_params: string

  credential_mode: CredentialMode
  // NewAPI token 模式：用 Cookie 还是系统访问令牌鉴权
  newapi_token_kind: "cookie" | "access_token"
  newapi_cookie: string
  newapi_access_token: string
  newapi_user_id: string
  // Sub2API token 模式
  sub2api_access_token: string
  sub2api_refresh_token: string

  balance_threshold: string
  recharge_multiplier: string
  recharge_multiplier_mode: RechargeMultiplierMode
  monitor_enabled: boolean
  only_created_key_groups_enabled: boolean
  turnstile_enabled: boolean
  ignore_announcements: boolean
  captcha_config_id: number | undefined

  notes: string
  // tags 是已确认的标签，tag_input 是输入框里还没确认的文字（提交时一并加入）
  tags: string[]
  tag_input: string
}

// 与后端 storage.MaxChannelTags / MaxChannelTagRunes / MaxChannelNotesRunes 保持一致
const MAX_TAGS = 20
const MAX_TAG_LENGTH = 32
const MAX_NOTES_LENGTH = 2000

/** charLength 按 Unicode 码点计数，与后端 utf8.RuneCountInString 对齐。 */
function charLength(s: string): number {
  return Array.from(s).length
}

/**
 * normalizeTags 与后端 storage.NormalizeChannelTags 规则一致：
 * 按半角 / 全角逗号拆分、去首尾空白、丢弃空项、只忽略 ASCII 大小写去重（保留首次出现的写法与顺序）。
 */
function normalizeTags(list: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    for (const part of raw.split(/[,，]/)) {
      const tag = part.trim()
      if (!tag) continue
      const key = channelTagKey(tag)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(tag)
    }
  }
  return out
}

function initialState(c?: Channel | null): FormState {
  return {
    name: c?.name ?? "",
    type: c?.type ?? "sub2api",
    site_url: c?.site_url ?? "",
    username: c?.username ?? "",
    sort_order: c?.sort_order != null ? String(c.sort_order) : "1",
    password: "",
    login_extra_params: c?.login_extra_params ?? "",
    credential_mode: c?.credential_mode ?? "password",
    newapi_token_kind: "cookie",
    newapi_cookie: "",
    newapi_access_token: "",
    newapi_user_id: c?.type === "newapi" ? (c.user_id ?? "") : "",
    sub2api_access_token: "",
    sub2api_refresh_token: "",
    balance_threshold: c?.balance_threshold != null ? String(c.balance_threshold) : "0",
    recharge_multiplier: c?.recharge_multiplier != null ? String(c.recharge_multiplier) : "",
    recharge_multiplier_mode: c?.recharge_multiplier_mode === "multiply" ? "multiply" : "divide",
    monitor_enabled: c?.monitor_enabled ?? true,
    only_created_key_groups_enabled: c?.only_created_key_groups_enabled ?? false,
    turnstile_enabled: c?.turnstile_enabled ?? false,
    ignore_announcements: c?.ignore_announcements ?? false,
    captcha_config_id: c?.captcha_config_id ?? undefined,
    tags: normalizeTags(c?.tags ?? []),
    tag_input: "",
    notes: c?.notes ?? "",
  }
}

/**
 * buildTokenCredential 把表单里的 token 字段序列化成后端期望的 JSON 字符串。
 * 字段名与 channel/service.go 里的 NewAPITokenCredential / Sub2APITokenCredential 对齐。
 */
function buildTokenCredential(form: FormState): string {
  if (form.type === "newapi") {
    if (form.newapi_token_kind === "access_token") {
      return JSON.stringify({ access_token: form.newapi_access_token.trim(), user_id: form.newapi_user_id.trim() })
    }
    return JSON.stringify({ cookie: form.newapi_cookie.trim(), user_id: form.newapi_user_id.trim() })
  }
  const refreshToken = form.sub2api_refresh_token.trim()
  return JSON.stringify({
    access_token: form.sub2api_access_token.trim(),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  })
}

function Field({ label, extra, hint, children }: {
  label: ReactNode
  extra?: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row-between">
        <Typography.Text strong size="small">
          {label}
        </Typography.Text>
        {extra}
      </div>
      {children}
      {hint ? (
        <Typography.Text type="tertiary" size="small">
          {hint}
        </Typography.Text>
      ) : null}
    </div>
  )
}

function SwitchRow({ title, description, checked, onChange, disabled }: {
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="row-between" style={{ alignItems: "flex-start", gap: 16 }}>
      <div className="stack" style={{ gap: 0 }}>
        <Typography.Text>{title}</Typography.Text>
        <Typography.Text type="tertiary" size="small">
          {description}
        </Typography.Text>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} style={{ flexShrink: 0 }} />
    </div>
  )
}

const monoStyle = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12 }

/** 新增或编辑渠道。channel 为空时是新增。 */
export function ChannelFormModal({ visible, onClose, channel }: {
  visible: boolean
  onClose: () => void
  channel?: Channel | null
}) {
  const [form, setForm] = useState<FormState>(() => initialState(channel))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useTriggerRefresh()
  const captchas = useCaptchaConfigs(visible)

  // 打开或换了目标渠道时重置表单
  useEffect(() => {
    if (visible) {
      setForm(initialState(channel))
      setError(null)
    }
  }, [visible, channel])

  const isEdit = !!channel
  const isTokenMode = form.credential_mode === "token"
  // 编辑时凭据类型没变，token / 密码都可以留空表示不改
  const modeChanged = isEdit && form.credential_mode !== (channel?.credential_mode ?? "password")
  const existingNewAPIUserID = isEdit && channel?.type === "newapi" ? (channel.user_id ?? "").trim() : ""
  const notesLength = charLength(form.notes.trim())

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }))
  }

  async function handleOk() {
    setError(null)
    setSubmitting(true)
    try {
      if (!form.name.trim()) throw new Error("请填写渠道名")
      if (!form.site_url.trim()) throw new Error("请填写站点地址")
      if (!isTokenMode && !form.username.trim()) throw new Error("请填写账号")
      const threshold = Number(form.balance_threshold)
      if (!Number.isFinite(threshold) || threshold < 0) throw new Error("余额阈值必须是非负数")
      const sortOrder = Number(form.sort_order)
      if (!Number.isInteger(sortOrder)) throw new Error("排序必须是整数")
      let rechargeMultiplier = 0
      const rechargeMultiplierText = form.recharge_multiplier.trim()
      if (rechargeMultiplierText) {
        rechargeMultiplier = Number(rechargeMultiplierText)
        if (!Number.isFinite(rechargeMultiplier) || rechargeMultiplier <= 0) {
          throw new Error("充值倍率必须大于 0，或留空跟随上游")
        }
      }
      // 输入框里没确认的文字也算标签
      const tags = normalizeTags([...form.tags, form.tag_input])
      if (tags.length > MAX_TAGS) throw new Error(`标签最多 ${MAX_TAGS} 个`)
      const longTag = tags.find((tag) => charLength(tag) > MAX_TAG_LENGTH)
      if (longTag) throw new Error(`单个标签最多 ${MAX_TAG_LENGTH} 个字符：${longTag}`)
      const notes = form.notes.trim()
      if (notesLength > MAX_NOTES_LENGTH) throw new Error(`备注最多 ${MAX_NOTES_LENGTH} 个字符`)
      const loginExtraParams = isTokenMode ? "" : form.login_extra_params.trim()
      if (loginExtraParams) {
        let parsed: unknown
        try {
          parsed = JSON.parse(loginExtraParams)
        } catch {
          throw new Error("附加表单参数 JSON 格式错误")
        }
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
          throw new Error("附加表单参数必须是 JSON 对象")
        }
      }

      // token 模式：按渠道类型拼 token JSON
      let tokenCredential = ""
      if (isTokenMode) {
        const newapiCred = form.newapi_token_kind === "access_token" ? form.newapi_access_token.trim() : form.newapi_cookie.trim()
        const newapiUserID = form.newapi_user_id.trim()
        const newapiUserIDChanged = form.type === "newapi" && (isEdit ? newapiUserID !== existingNewAPIUserID : newapiUserID !== "")
        if (form.type === "newapi") {
          if (!isEdit || modeChanged || newapiCred || newapiUserIDChanged) {
            if (!newapiCred) {
              throw new Error(form.newapi_token_kind === "access_token" ? "NewAPI token 模式必须填写系统访问令牌" : "NewAPI token 模式必须填写 Cookie")
            }
            if (!newapiUserID) throw new Error("NewAPI token 模式必须填写 User ID")
          }
        } else if (!isEdit || modeChanged || form.sub2api_access_token || form.sub2api_refresh_token) {
          if (!form.sub2api_access_token.trim()) throw new Error("Sub2API token 模式必须填写 Access Token")
        }
        // 只有新建、切换模式或填了字段时才下发 token_credential
        if (
          !isEdit ||
          modeChanged ||
          (form.type === "newapi" && (newapiCred || newapiUserIDChanged)) ||
          (form.type === "sub2api" && (form.sub2api_access_token || form.sub2api_refresh_token))
        ) {
          tokenCredential = buildTokenCredential(form)
        }
      }

      // 打码平台只在账号密码模式 + 开启 Turnstile 时生效
      const useCaptcha = !isTokenMode && form.turnstile_enabled
      const captchaConfigID = useCaptcha && form.captcha_config_id != null ? form.captcha_config_id : null
      if (useCaptcha && captchaConfigID == null) throw new Error("开启 Turnstile 时必须选一个打码平台")

      if (!isTokenMode) {
        if (!isEdit && !form.password) throw new Error("新建时必须填写密码")
        if (modeChanged && !form.password) throw new Error("切换到账号密码模式时必须填写密码")
      }

      const common = {
        name: form.name,
        site_url: form.site_url,
        username: form.username,
        sort_order: sortOrder,
        credential_mode: form.credential_mode,
        login_extra_params: loginExtraParams,
        balance_threshold: threshold,
        recharge_multiplier: rechargeMultiplier,
        recharge_multiplier_mode: form.recharge_multiplier_mode,
        monitor_enabled: form.monitor_enabled,
        only_created_key_groups_enabled: form.only_created_key_groups_enabled,
        turnstile_enabled: useCaptcha,
        ignore_announcements: form.ignore_announcements,
        captcha_config_id: captchaConfigID,
        tags,
        notes,
      }

      if (isEdit) {
        const body: Record<string, unknown> = { ...common }
        if (!isTokenMode && form.password) body.password = form.password
        if (isTokenMode && tokenCredential) body.token_credential = tokenCredential
        await apiFetch(`/channels/${channel!.id}`, { method: "PUT", body: JSON.stringify(body) })
      } else {
        await apiFetch(`/channels`, {
          method: "POST",
          body: JSON.stringify({
            ...common,
            type: form.type,
            password: isTokenMode ? "" : form.password,
            token_credential: isTokenMode ? tokenCredential : "",
          }),
        })
      }
      onClose()
      refresh()
    } catch (e) {
      setError((e as Error).message || "保存失败")
    } finally {
      setSubmitting(false)
    }
  }

  const enabledCaptchas = (captchas.data ?? []).filter((c) => c.enabled)

  return (
    <Modal
      visible={visible}
      title={isEdit ? "编辑渠道" : "新增渠道"}
      onCancel={onClose}
      onOk={handleOk}
      okText="保存"
      confirmLoading={submitting}
      width={640}
      bodyStyle={{ maxHeight: "72vh", overflowY: "auto" }}
    >
      <div className="stack" style={{ gap: 14 }}>
        <Typography.Text type="tertiary" size="small">
          {isEdit ? "保存后会清空已缓存的登录会话。" : "添加上游账号，开启监控后按计划自动登录采集。"}
        </Typography.Text>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 120px", gap: 12 }}>
          <Field label="渠道名">
            <Input value={form.name} onChange={(v) => patch({ name: v })} disabled={submitting} />
          </Field>
          <Field label="排序">
            <Input type="number" value={form.sort_order} onChange={(v) => patch({ sort_order: v })} disabled={submitting} />
          </Field>
        </div>

        <Field label="类型" hint={isEdit ? "类型创建后不可修改" : undefined}>
          <Select
            value={form.type}
            onChange={(v) => patch({ type: v as ChannelType })}
            disabled={isEdit || submitting}
            style={{ width: "100%" }}
            optionList={[
              { value: "sub2api", label: "Sub2API" },
              { value: "newapi", label: "NewAPI" },
            ]}
          />
        </Field>

        <Field label="站点地址">
          <Input placeholder="https://example.com" value={form.site_url} onChange={(v) => patch({ site_url: v })} disabled={submitting} />
        </Field>

        <Field label="标签（可选）" hint={`回车或逗号确认，最多 ${MAX_TAGS} 个，每个不超过 ${MAX_TAG_LENGTH} 个字符`}>
          <TagInput
            value={form.tags}
            inputValue={form.tag_input}
            onChange={(v) => patch({ tags: normalizeTags(v) })}
            onInputChange={(v) => patch({ tag_input: v })}
            separator={[",", "，"]}
            addOnBlur
            placeholder={form.tags.length === 0 ? "输入后按回车添加" : ""}
            disabled={submitting}
            validateStatus={form.tags.some((t) => charLength(t) > MAX_TAG_LENGTH) ? "error" : "default"}
          />
        </Field>

        <Field
          label="备注（可选）"
          hint={
            notesLength > MAX_NOTES_LENGTH * 0.9 ? (
              <Typography.Text type={notesLength > MAX_NOTES_LENGTH ? "danger" : "tertiary"} size="small">
                {notesLength} / {MAX_NOTES_LENGTH}
              </Typography.Text>
            ) : undefined
          }
        >
          <TextArea
            placeholder="如：主力渠道，晚高峰较慢"
            value={form.notes}
            onChange={(v) => patch({ notes: v })}
            autosize={{ minRows: 2, maxRows: 6 }}
            disabled={submitting}
          />
        </Field>

        <Divider margin={4} />

        <Field
          label="凭据类型"
          hint={
            isTokenMode
              ? "粘贴浏览器里已登录的 Token / Cookie，失效后要手动重新粘贴。"
              : "填账号密码，系统自动登录并续期；站点有人机验证时需要配打码平台。"
          }
        >
          <RadioGroup
            type="button"
            value={form.credential_mode}
            onChange={(e) => patch({ credential_mode: e.target.value as CredentialMode })}
            disabled={submitting}
          >
            <Radio value="password">账号密码</Radio>
            <Radio value="token">Token（跳过登录）</Radio>
          </RadioGroup>
        </Field>

        {!isTokenMode ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <Field label="账号 / 邮箱">
                <Input value={form.username} onChange={(v) => patch({ username: v })} disabled={submitting} />
              </Field>
              <Field label={isEdit ? "新密码（留空不变）" : "密码"}>
                <Input mode="password" value={form.password} onChange={(v) => patch({ password: v })} disabled={submitting} />
              </Field>
            </div>
            <Field label="附加表单参数" hint="非标准 Sub2API / NewAPI 魔改版登录时额外要的字段。">
              <TextArea
                placeholder='{"device_id":"xxx"}'
                value={form.login_extra_params}
                onChange={(v) => patch({ login_extra_params: v })}
                autosize={{ minRows: 2, maxRows: 6 }}
                style={monoStyle}
                disabled={submitting}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="账号 / 邮箱（可选）" hint="只用来显示，不参与鉴权">
              <Input placeholder="如：someone@example.com" value={form.username} onChange={(v) => patch({ username: v })} disabled={submitting} />
            </Field>

            {form.type === "newapi" ? (
              <>
                <Field
                  label="鉴权方式"
                  hint={
                    form.newapi_token_kind === "access_token"
                      ? "NewAPI 个人设置页生成的“系统访问令牌”（user.access_token），请求时放在 Authorization 头里。"
                      : "浏览器登录后的整段 Cookie，一般形如 session=MTc4...; ..."
                  }
                >
                  <RadioGroup
                    type="button"
                    value={form.newapi_token_kind}
                    onChange={(e) => patch({ newapi_token_kind: e.target.value as FormState["newapi_token_kind"] })}
                    disabled={submitting}
                  >
                    <Radio value="cookie">Cookie（session）</Radio>
                    <Radio value="access_token">系统访问令牌</Radio>
                  </RadioGroup>
                </Field>
                {form.newapi_token_kind === "cookie" ? (
                  <Field label="Cookie" extra={<NewAPITokenHelp kind="cookie" />}>
                    <TextArea
                      placeholder={isEdit ? "留空不修改；填写则覆盖原来的" : "粘贴整段 Cookie，例：session=...; ..."}
                      value={form.newapi_cookie}
                      onChange={(v) => patch({ newapi_cookie: v })}
                      rows={3}
                      style={monoStyle}
                      disabled={submitting}
                    />
                  </Field>
                ) : (
                  <Field label="系统访问令牌" extra={<NewAPITokenHelp kind="access_token" />}>
                    <TextArea
                      placeholder={isEdit ? "留空不修改；填写则覆盖原来的" : "粘贴 NewAPI 生成的 32 位系统访问令牌"}
                      value={form.newapi_access_token}
                      onChange={(v) => patch({ newapi_access_token: v })}
                      rows={3}
                      style={monoStyle}
                      disabled={submitting}
                    />
                  </Field>
                )}
                <Field label="User ID">
                  <Input
                    placeholder={isEdit ? "留空不修改；NewAPI 个人设置页可见" : "整数，NewAPI 个人设置页可见"}
                    value={form.newapi_user_id}
                    onChange={(v) => patch({ newapi_user_id: v })}
                    disabled={submitting}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="Access Token" extra={<Sub2APITokenHelp />}>
                  <TextArea
                    placeholder={isEdit ? "留空不修改；填写则覆盖原来的" : "粘贴 access_token"}
                    value={form.sub2api_access_token}
                    onChange={(v) => patch({ sub2api_access_token: v })}
                    rows={3}
                    style={monoStyle}
                    disabled={submitting}
                  />
                </Field>
                <Field label="Refresh Token">
                  <TextArea
                    placeholder={isEdit ? "留空不修改；填写时要同时填 Access Token" : "粘贴 refresh_token（建议填，用来续期）"}
                    value={form.sub2api_refresh_token}
                    onChange={(v) => patch({ sub2api_refresh_token: v })}
                    rows={3}
                    style={monoStyle}
                    disabled={submitting}
                  />
                </Field>
              </>
            )}
          </>
        )}

        <Divider margin={4} />

        <Field label="余额阈值" hint="余额低于这个值时告警，0 表示不告警。">
          <Input type="number" step={0.01} min={0} value={form.balance_threshold} onChange={(v) => patch({ balance_threshold: v })} disabled={submitting} />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <Field label="充值倍率" hint="留空跟随上游。">
            <Input type="number" step={0.0001} min={0} value={form.recharge_multiplier} onChange={(v) => patch({ recharge_multiplier: v })} disabled={submitting} />
          </Field>
          <Field label="换算方式">
            <Select
              value={form.recharge_multiplier_mode}
              onChange={(v) => patch({ recharge_multiplier_mode: v as RechargeMultiplierMode })}
              disabled={submitting}
              style={{ width: "100%" }}
              optionList={[
                { value: "divide", label: "余额 / 倍率" },
                { value: "multiply", label: "余额 × 倍率" },
              ]}
            />
          </Field>
        </div>

        <SwitchRow
          title="启用监控"
          description="关闭后调度器不会采集这个渠道。"
          checked={form.monitor_enabled}
          onChange={(v) => patch({ monitor_enabled: v })}
          disabled={submitting}
        />
        <SwitchRow
          title="只看已建密钥的分组"
          description="开启后渠道列表、全部分组和倍率变化通知只关注已经建了密钥的分组；通知设置里仍能看到全部分组。"
          checked={form.only_created_key_groups_enabled}
          onChange={(v) => patch({ only_created_key_groups_enabled: v })}
          disabled={submitting}
        />
        <SwitchRow
          title="忽略公告"
          description="开启后不拉取这个渠道的公告。"
          checked={form.ignore_announcements}
          onChange={(v) => patch({ ignore_announcements: v })}
          disabled={submitting}
        />

        {!isTokenMode ? (
          <>
            <SwitchRow
              title="Turnstile 人机验证"
              description="站点开了 Cloudflare Turnstile 时打开。"
              checked={form.turnstile_enabled}
              onChange={(v) => patch({ turnstile_enabled: v })}
              disabled={submitting}
            />
            {form.turnstile_enabled ? (
              <Field label="打码平台" hint="siteKey 会自动从上游公开接口获取，不用填。">
                <Select
                  value={form.captcha_config_id}
                  onChange={(v) => patch({ captcha_config_id: v as number })}
                  disabled={submitting}
                  style={{ width: "100%" }}
                  placeholder={enabledCaptchas.length > 0 ? "选择打码平台" : "先到“打码平台”页新增一个"}
                  optionList={enabledCaptchas.map((c) => ({ value: c.id, label: c.name }))}
                  emptyContent="没有已启用的打码平台"
                />
              </Field>
            ) : null}
          </>
        ) : null}

        <FormError message={error} />
      </div>
    </Modal>
  )
}

function HelpLink({ content }: { content: ReactNode }) {
  return (
    <Popover content={<div style={{ padding: 12, maxWidth: 360, fontSize: 12, lineHeight: 1.7 }}>{content}</div>} trigger="click" position="bottomRight" showArrow>
      <Typography.Text link size="small" icon={<IconHelpCircle />} style={{ cursor: "pointer" }}>
        如何获取？
      </Typography.Text>
    </Popover>
  )
}

const code = (s: string) => <Typography.Text code>{s}</Typography.Text>

function NewAPITokenHelp({ kind }: { kind: "cookie" | "access_token" }) {
  return (
    <HelpLink
      content={
        <>
          {kind === "access_token" ? (
            <>
              <Typography.Text strong>获取系统访问令牌</Typography.Text>
              <ol style={{ margin: "4px 0", paddingLeft: 18 }}>
                <li>在浏览器登录 NewAPI 站点，进“个人设置”页</li>
                <li>找到“生成的系统访问令牌”一栏</li>
                <li>点生成并复制这串 32 位令牌（即 user.access_token）</li>
              </ol>
              <div>请求时用 {code("Authorization")} 头带上这个令牌，不再依赖 Cookie 续期。</div>
            </>
          ) : (
            <>
              <Typography.Text strong>获取 Cookie</Typography.Text>
              <ol style={{ margin: "4px 0", paddingLeft: 18 }}>
                <li>在浏览器登录 NewAPI 站点，按 F12 打开开发者工具，切到 Network（网络）</li>
                <li>刷新页面，点列表里任意一个 {code("/api/")} 开头的请求，如 {code("self")}</li>
                <li>在 Request Headers（请求标头）里找到 {code("Cookie")}，复制冒号后面的整段，形如 {code("session=xxxxx; ...")}</li>
              </ol>
              <div>只粘 {code("session")} 的值、漏了前面的 {code("session=")}，上游会当成未登录。</div>
            </>
          )}
          <Typography.Text strong style={{ display: "block", marginTop: 8 }}>
            获取 User ID
          </Typography.Text>
          <div>登录 NewAPI 后在“个人设置”页查看用户 ID，或到 Application → Local Storage 里复制 {code("uid")}。</div>
        </>
      }
    />
  )
}

function Sub2APITokenHelp() {
  return (
    <HelpLink
      content={
        <>
          <Typography.Text strong>获取 Access Token / Refresh Token</Typography.Text>
          <ol style={{ margin: "4px 0", paddingLeft: 18 }}>
            <li>在浏览器登录 Sub2API 站点</li>
            <li>按 F12 打开开发者工具，切到 Application（存储）</li>
            <li>左侧 Local Storage 选中站点域名</li>
            <li>复制 {code("auth_token")} 或 {code("access_token")}</li>
            <li>同时复制 {code("refresh_token")}（站点启用了刷新令牌时才有）</li>
          </ol>
          <div>
            也可以在 Network 里找任意已登录接口的 {code("Authorization")} 头，去掉 {code("Bearer ")} 前缀。
          </div>
        </>
      }
    />
  )
}
