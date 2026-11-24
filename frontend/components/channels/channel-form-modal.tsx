import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Button,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Popover,
  Select,
  Separator,
  Spinner,
  Switch,
  Tag,
  TagGroup,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  toast,
} from "@heroui/react"
import { CircleQuestion } from "@gravity-ui/icons"
import type { Channel, ChannelType, CredentialMode, RechargeMultiplierMode } from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { channelTagKey } from "@/lib/channel-tags"
import { isAbort, startJob, watchJob } from "@/lib/jobs"
import { useCaptchaConfigs } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { SyncProgress, emptySyncState, syncStateOf, type ChannelSyncState } from "@/components/channels/channel-parts"
import { FormError } from "@/components/common/form-error"
import { PasswordInput } from "@/components/common/password-input"

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

/** sameForm 判断表单有没有没保存的改动。NewAPI 鉴权方式只是切换输入框，不填内容保存了也不变，不算改动。 */
function sameForm(a: FormState, b: FormState): boolean {
  return (Object.keys(a) as (keyof FormState)[]).every(
    (k) => k === "newapi_token_kind" || JSON.stringify(a[k]) === JSON.stringify(b[k]),
  )
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

function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <Switch
      isSelected={checked}
      onChange={onChange}
      isDisabled={disabled}
      className="w-full"
    >
      <Switch.Content className="w-full justify-between">
        <div className="stack gap-0.5">
          <Label className="text-sm font-medium text-foreground">{title}</Label>
          <Description className="text-xs text-muted">{description}</Description>
        </div>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  )
}

function TagsEditor({
  tags,
  inputValue,
  onChange,
  onInputChange,
  disabled,
  invalid,
}: {
  tags: string[]
  inputValue: string
  onChange: (next: string[]) => void
  onInputChange: (next: string) => void
  disabled?: boolean
  invalid?: boolean
}) {
  function commit(raw: string) {
    if (!raw.trim()) {
      onInputChange("")
      return
    }
    onChange(normalizeTags([...tags, raw]))
    onInputChange("")
  }

  return (
    <div className="stack gap-2">
      <TextField
        variant="secondary"
        fullWidth
        isDisabled={disabled}
        isInvalid={invalid}
        value={inputValue}
        onChange={(val) => {
          if (/[,，]/.test(val)) commit(val)
          else onInputChange(val)
        }}
      >
        <Label>标签（可选）</Label>
        <Input
          placeholder="输入后按回车或逗号添加"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault()
              commit(inputValue)
            } else if (e.key === "Backspace" && !inputValue && tags.length > 0) {
              onChange(tags.slice(0, -1))
            }
          }}
          onBlur={() => commit(inputValue)}
        />
        <Description>
          回车或逗号确认，最多 {MAX_TAGS} 个，每个不超过 {MAX_TAG_LENGTH} 个字符
        </Description>
      </TextField>

      {tags.length > 0 ? (
        <TagGroup
          aria-label="已添加的标签"
          size="sm"
          onRemove={
            disabled
              ? undefined
              : (keys) => {
                  onChange(tags.filter((t) => !keys.has(t)))
                }
          }
        >
          <TagGroup.List>
            {tags.map((tag) => (
              <Tag
                key={tag}
                id={tag}
                textValue={tag}
                className={charLength(tag) > MAX_TAG_LENGTH ? "text-danger" : undefined}
              >
                {tag}
              </Tag>
            ))}
          </TagGroup.List>
        </TagGroup>
      ) : null}
    </div>
  )
}

/** 新增或编辑渠道。channel 为空时是新增。 */
export function ChannelFormModal({
  visible,
  onClose,
  channel,
}: {
  visible: boolean
  onClose: () => void
  channel?: Channel | null
}) {
  const [form, setForm] = useState<FormState>(() => initialState(channel))
  // 最近一次打开或保存时的表单，和它不一样就是有没保存的改动
  const [baseline, setBaseline] = useState<FormState>(() => initialState(channel))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 在这个弹窗里保存过的渠道；保存后弹窗不关，新增的渠道存过之后再保存就是修改它
  const [saved, setSaved] = useState<Channel | null>(null)
  // 测试登录是后端的后台任务，弹窗只轮询进度；关掉弹窗就停止轮询，任务照常跑完
  const [test, setTest] = useState<ChannelSyncState | null>(null)
  const watchAbort = useRef<AbortController | null>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const refresh = useTriggerRefresh()
  const captchas = useCaptchaConfigs(visible)

  // 打开或换了目标渠道时重置表单
  useEffect(() => {
    if (visible) {
      const init = initialState(channel)
      setForm(init)
      setBaseline(init)
      setError(null)
      setSaved(null)
      setTest(null)
    }
  }, [visible, channel])

  useEffect(() => {
    if (!visible) return
    const ctrl = new AbortController()
    watchAbort.current = ctrl
    return () => ctrl.abort()
  }, [visible])

  const testing = test?.running ?? false
  // 进度在表单最下面，开始测试和每来一步都滚过去，跑完的结论也露出来
  const testSteps = test ? test.events.length + 1 : 0
  useEffect(() => {
    if (testSteps) progressRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [testSteps])

  const target = saved ?? channel ?? null
  const isEdit = !!target
  const isTokenMode = form.credential_mode === "token"
  // 编辑时凭据类型没变，token / 密码都可以留空表示不改
  const modeChanged = isEdit && form.credential_mode !== (target?.credential_mode ?? "password")
  const existingNewAPIUserID = isEdit && target?.type === "newapi" ? (target.user_id ?? "").trim() : ""
  const notesLength = charLength(form.notes.trim())
  const dirty = !sameForm(form, baseline)
  // 测试登录用的是库里存的凭据，所以新渠道和有改动时都要先保存
  const testBlocked = !target ? "新渠道要先点“保存”，才能测试登录" : dirty ? "有改动还没保存，先点“保存”再测试登录" : null

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }))
  }

  /** 检查并保存表单，返回保存后的渠道；有错时显示在表单底部，返回 null。 */
  async function save(): Promise<Channel | null> {
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

      let result: Channel
      if (isEdit) {
        const body: Record<string, unknown> = { ...common }
        if (!isTokenMode && form.password) body.password = form.password
        if (isTokenMode && tokenCredential) body.token_credential = tokenCredential
        result = await apiFetch<Channel>(`/channels/${target!.id}`, { method: "PUT", body: JSON.stringify(body) })
      } else {
        result = await apiFetch<Channel>(`/channels`, {
          method: "POST",
          body: JSON.stringify({
            ...common,
            type: form.type,
            password: isTokenMode ? "" : form.password,
            token_credential: isTokenMode ? tokenCredential : "",
          }),
        })
      }
      refresh()
      return result
    } catch (e) {
      setError((e as Error).message || "保存失败")
      return null
    } finally {
      setSubmitting(false)
    }
  }

  /** 保存后弹窗不关：表单换成刚存下的样子（凭据输入框清空），这时才能测试登录。 */
  async function handleSave() {
    const result = await save()
    if (!result) return
    const next = { ...initialState(result), newapi_token_kind: form.newapi_token_kind }
    setSaved(result)
    setForm(next)
    setBaseline(next)
    // 存了新凭据，上一次的测试结果就不作数了
    setTest(null)
    toast.success("已保存")
  }

  /** 用库里存的凭据测试登录；失败了改完凭据再保存、再测。 */
  async function handleTest() {
    if (!target) return
    const signal = watchAbort.current?.signal
    setTest({ ...emptySyncState(), running: true })
    try {
      const { job, started } = await startJob(`/channels/${target.id}/test-login`)
      if (!started) toast.info(`${target.name} 已有任务在跑（${job.title}），显示它的进度`)
      await watchJob(job.id, (j) => setTest(syncStateOf(j)), signal)
      refresh()
    } catch (e) {
      if (isAbort(e, signal)) return
      const failed = {
        stage: "error" as const,
        message: (e as Error).message || "测试登录失败",
        time: new Date().toISOString(),
      }
      setTest((prev) => ({ running: false, events: [...(prev?.events ?? []), failed], latest: failed, finalOk: false }))
    }
  }

  const enabledCaptchas = (captchas.data ?? []).filter((c) => c.enabled)

  return (
    <Modal.Backdrop
      isOpen={visible}
      isDismissable={!submitting && !dirty}
      isKeyboardDismissDisabled={submitting}
      onOpenChange={(open) => !open && !submitting && onClose()}
    >
      <Modal.Container size="lg" scroll="inside" className="w-[min(640px,calc(100vw-24px))] max-w-none">
        <Modal.Dialog className="w-full max-w-none">
          <Modal.CloseTrigger isDisabled={submitting} />
          <Modal.Header>
            <Modal.Heading>{isEdit ? "编辑渠道" : "新增渠道"}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="max-h-[72vh] overflow-y-auto">
            <div className="stack gap-3.5">
              <p className="m-0 text-xs text-muted">
                {isEdit
                  ? "保存后会清空已缓存的登录会话，弹窗不关。改了登录凭据先点“保存”，再点“测试登录”，结果显示在最下面。"
                  : "添加上游账号，开启监控后按计划自动登录采集。保存后弹窗不关，可以点“测试登录”确认凭据能不能用。"}
              </p>

              <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
                <TextField
                  variant="secondary"
                  fullWidth
                  value={form.name}
                  onChange={(name) => patch({ name })}
                  isDisabled={submitting}
                  isRequired
                >
                  <Label>渠道名</Label>
                  <Input />
                </TextField>
                <TextField
                  variant="secondary"
                  fullWidth
                  value={form.sort_order}
                  onChange={(sort_order) => patch({ sort_order })}
                  isDisabled={submitting}
                >
                  <Label>排序</Label>
                  <Input type="number" />
                </TextField>
              </div>

              <Select
                variant="secondary"
                fullWidth
                value={form.type}
                onChange={(k) => k != null && patch({ type: String(k) as ChannelType })}
                isDisabled={isEdit || submitting}
              >
                <Label>类型</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                {isEdit ? <Description>类型创建后不可修改</Description> : null}
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="sub2api" textValue="Sub2API">
                      Sub2API
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    <ListBox.Item id="newapi" textValue="NewAPI">
                      NewAPI
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>

              <TextField
                variant="secondary"
                fullWidth
                value={form.site_url}
                onChange={(site_url) => patch({ site_url })}
                isDisabled={submitting}
                isRequired
              >
                <Label>站点地址</Label>
                <Input placeholder="https://example.com" />
              </TextField>

              <TagsEditor
                tags={form.tags}
                inputValue={form.tag_input}
                onChange={(tags) => patch({ tags })}
                onInputChange={(tag_input) => patch({ tag_input })}
                disabled={submitting}
                invalid={form.tags.some((t) => charLength(t) > MAX_TAG_LENGTH)}
              />

              <TextField
                variant="secondary"
                fullWidth
                value={form.notes}
                onChange={(notes) => patch({ notes })}
                isDisabled={submitting}
                isInvalid={notesLength > MAX_NOTES_LENGTH}
              >
                <Label>备注（可选）</Label>
                <TextArea placeholder="如：主力渠道，晚高峰较慢" rows={2} />
                {notesLength > MAX_NOTES_LENGTH * 0.9 ? (
                  <Description className={notesLength > MAX_NOTES_LENGTH ? "text-danger" : undefined}>
                    {notesLength} / {MAX_NOTES_LENGTH}
                  </Description>
                ) : null}
              </TextField>

              <Separator className="my-1" />

              <div className="stack gap-1.5">
                <Label className="text-xs font-medium text-foreground">凭据类型</Label>
                <ToggleButtonGroup
                  aria-label="凭据类型"
                  selectionMode="single"
                  disallowEmptySelection
                  selectedKeys={new Set([form.credential_mode])}
                  onSelectionChange={(keys) => {
                    const first = [...keys][0]
                    if (first != null) patch({ credential_mode: String(first) as CredentialMode })
                  }}
                  isDisabled={submitting}
                  size="sm"
                >
                  <ToggleButton id="password">账号密码</ToggleButton>
                  <ToggleButton id="token">Token（跳过登录）</ToggleButton>
                </ToggleButtonGroup>
                <span className="text-xs text-muted">
                  {isTokenMode
                    ? "粘贴浏览器里已登录的 Token / Cookie，失效后要手动重新粘贴。"
                    : "填账号密码，系统自动登录并续期；站点有人机验证时需要配打码平台。"}
                </span>
              </div>

              {!isTokenMode ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <TextField
                      variant="secondary"
                      fullWidth
                      value={form.username}
                      onChange={(username) => patch({ username })}
                      isDisabled={submitting}
                    >
                      <Label>账号 / 邮箱</Label>
                      <Input />
                    </TextField>
                    <TextField
                      variant="secondary"
                      fullWidth
                      value={form.password}
                      onChange={(password) => patch({ password })}
                      isDisabled={submitting}
                    >
                      <Label>{isEdit ? "新密码（留空不变）" : "密码"}</Label>
                      <PasswordInput variant="secondary" fullWidth />
                    </TextField>
                  </div>
                  <TextField
                    variant="secondary"
                    fullWidth
                    value={form.login_extra_params}
                    onChange={(login_extra_params) => patch({ login_extra_params })}
                    isDisabled={submitting}
                  >
                    <Label>附加表单参数</Label>
                    <TextArea placeholder='{"device_id":"xxx"}' rows={2} className="mono text-xs" />
                    <Description>非标准 Sub2API / NewAPI 魔改版登录时额外要的字段。</Description>
                  </TextField>
                </>
              ) : (
                <>
                  <TextField
                    variant="secondary"
                    fullWidth
                    value={form.username}
                    onChange={(username) => patch({ username })}
                    isDisabled={submitting}
                  >
                    <Label>账号 / 邮箱（可选）</Label>
                    <Input placeholder="如：someone@example.com" />
                    <Description>只用来显示，不参与鉴权</Description>
                  </TextField>

                  {form.type === "newapi" ? (
                    <>
                      <div className="stack gap-1.5">
                        <Label className="text-xs font-medium text-foreground">鉴权方式</Label>
                        <ToggleButtonGroup
                          aria-label="鉴权方式"
                          selectionMode="single"
                          disallowEmptySelection
                          selectedKeys={new Set([form.newapi_token_kind])}
                          onSelectionChange={(keys) => {
                            const first = [...keys][0]
                            if (first != null) patch({ newapi_token_kind: String(first) as FormState["newapi_token_kind"] })
                          }}
                          isDisabled={submitting}
                          size="sm"
                        >
                          <ToggleButton id="cookie">Cookie（session）</ToggleButton>
                          <ToggleButton id="access_token">系统访问令牌</ToggleButton>
                        </ToggleButtonGroup>
                        <span className="text-xs text-muted">
                          {form.newapi_token_kind === "access_token"
                            ? "NewAPI 个人设置页生成的“系统访问令牌”（user.access_token），请求时放在 Authorization 头里。"
                            : "浏览器登录后的整段 Cookie，一般形如 session=MTc4...; ..."}
                        </span>
                      </div>

                      {form.newapi_token_kind === "cookie" ? (
                        <TextField
                          variant="secondary"
                          fullWidth
                          value={form.newapi_cookie}
                          onChange={(newapi_cookie) => patch({ newapi_cookie })}
                          isDisabled={submitting}
                        >
                          <div className="row-between">
                            <Label>Cookie</Label>
                            <NewAPITokenHelp kind="cookie" />
                          </div>
                          <TextArea
                            placeholder={isEdit ? "留空不修改；填写则覆盖原来的" : "粘贴整段 Cookie，例：session=...; ..."}
                            rows={3}
                            className="mono text-xs"
                          />
                        </TextField>
                      ) : (
                        <TextField
                          variant="secondary"
                          fullWidth
                          value={form.newapi_access_token}
                          onChange={(newapi_access_token) => patch({ newapi_access_token })}
                          isDisabled={submitting}
                        >
                          <div className="row-between">
                            <Label>系统访问令牌</Label>
                            <NewAPITokenHelp kind="access_token" />
                          </div>
                          <TextArea
                            placeholder={isEdit ? "留空不修改；填写则覆盖原来的" : "粘贴 NewAPI 生成的 32 位系统访问令牌"}
                            rows={3}
                            className="mono text-xs"
                          />
                        </TextField>
                      )}

                      <TextField
                        variant="secondary"
                        fullWidth
                        value={form.newapi_user_id}
                        onChange={(newapi_user_id) => patch({ newapi_user_id })}
                        isDisabled={submitting}
                      >
                        <Label>User ID</Label>
                        <Input placeholder={isEdit ? "留空不修改；NewAPI 个人设置页可见" : "整数，NewAPI 个人设置页可见"} />
                      </TextField>
                    </>
                  ) : (
                    <>
                      <TextField
                        variant="secondary"
                        fullWidth
                        value={form.sub2api_access_token}
                        onChange={(sub2api_access_token) => patch({ sub2api_access_token })}
                        isDisabled={submitting}
                      >
                        <div className="row-between">
                          <Label>Access Token</Label>
                          <Sub2APITokenHelp />
                        </div>
                        <TextArea
                          placeholder={isEdit ? "留空不修改；填写则覆盖原来的" : "粘贴 access_token"}
                          rows={3}
                          className="mono text-xs"
                        />
                      </TextField>

                      <TextField
                        variant="secondary"
                        fullWidth
                        value={form.sub2api_refresh_token}
                        onChange={(sub2api_refresh_token) => patch({ sub2api_refresh_token })}
                        isDisabled={submitting}
                      >
                        <Label>Refresh Token</Label>
                        <TextArea
                          placeholder={isEdit ? "留空不修改；填写时要同时填 Access Token" : "粘贴 refresh_token（建议填，用来续期）"}
                          rows={3}
                          className="mono text-xs"
                        />
                      </TextField>
                    </>
                  )}
                </>
              )}

              <Separator className="my-1" />

              <TextField
                variant="secondary"
                fullWidth
                value={form.balance_threshold}
                onChange={(balance_threshold) => patch({ balance_threshold })}
                isDisabled={submitting}
              >
                <Label>余额阈值</Label>
                <Input type="number" step={0.01} min={0} />
                <Description>余额低于这个值时告警，0 表示不告警。</Description>
              </TextField>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField
                  variant="secondary"
                  fullWidth
                  value={form.recharge_multiplier}
                  onChange={(recharge_multiplier) => patch({ recharge_multiplier })}
                  isDisabled={submitting}
                >
                  <Label>充值倍率</Label>
                  <Input type="number" step={0.0001} min={0} />
                  <Description>留空跟随上游。</Description>
                </TextField>
                <Select
                  variant="secondary"
                  fullWidth
                  value={form.recharge_multiplier_mode}
                  onChange={(k) => k != null && patch({ recharge_multiplier_mode: String(k) as RechargeMultiplierMode })}
                  isDisabled={submitting}
                >
                  <Label>换算方式</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="divide" textValue="余额 / 倍率">
                        余额 / 倍率
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="multiply" textValue="余额 × 倍率">
                        余额 × 倍率
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>

              <div className="stack gap-3 pt-1">
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
                      <Select
                        variant="secondary"
                        fullWidth
                        placeholder={enabledCaptchas.length > 0 ? "选择打码平台" : "先到“打码平台”页新增一个"}
                        value={form.captcha_config_id != null ? String(form.captcha_config_id) : null}
                        onChange={(k) => patch({ captcha_config_id: k == null || k === "" ? undefined : Number(k) })}
                        isDisabled={submitting}
                      >
                        <Label>打码平台</Label>
                        <Select.Trigger>
                          <Select.Value />
                          <Select.Indicator />
                        </Select.Trigger>
                        <Description>siteKey 会自动从上游公开接口获取，不用填。</Description>
                        <Select.Popover>
                          <ListBox
                            renderEmptyState={() => (
                              <div className="px-3 py-2 text-xs text-muted">没有已启用的打码平台</div>
                            )}
                          >
                            {enabledCaptchas.map((c) => (
                              <ListBox.Item key={c.id} id={String(c.id)} textValue={c.name}>
                                <Label>{c.name}</Label>
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                            ))}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                    ) : null}
                  </>
                ) : null}
              </div>

              {test ? (
                <div ref={progressRef} className="stack gap-1.5">
                  <span className="text-xs font-semibold text-foreground">测试登录</span>
                  <SyncProgress state={test} />
                </div>
              ) : null}

              <FormError message={error} />
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" isDisabled={submitting} onPress={onClose}>
              {saved && !dirty ? "关闭" : "取消"}
            </Button>
            {testBlocked && !testing ? (
              <Tooltip>
                <Tooltip.Trigger
                  aria-disabled="true"
                  className="button button--secondary button--md cursor-not-allowed opacity-50"
                >
                  测试登录
                </Tooltip.Trigger>
                <Tooltip.Content>{testBlocked}</Tooltip.Content>
              </Tooltip>
            ) : (
              <Button
                variant="secondary"
                isPending={testing}
                isDisabled={submitting}
                onPress={() => void handleTest()}
              >
                {testing ? <Spinner size="sm" color="current" /> : null}
                测试登录
              </Button>
            )}
            <Button
              variant="primary"
              isPending={submitting}
              isDisabled={testing}
              onPress={() => void handleSave()}
            >
              {submitting ? <Spinner size="sm" color="current" /> : null}
              保存
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

function HelpLink({ content }: { content: ReactNode }) {
  return (
    <Popover>
      <Button variant="ghost" size="sm" className="h-auto gap-1 px-1.5 py-0.5 text-xs text-accent">
        <CircleQuestion className="size-3.5" />
        如何获取？
      </Button>
      <Popover.Content placement="bottom end" className="max-w-[360px]">
        <Popover.Arrow />
        <Popover.Dialog className="text-xs leading-relaxed text-foreground">{content}</Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

const code = (s: string) => (
  <code className="mono rounded bg-default px-1 py-0.5 text-[11px] text-foreground">{s}</code>
)

function NewAPITokenHelp({ kind }: { kind: "cookie" | "access_token" }) {
  return (
    <HelpLink
      content={
        <>
          {kind === "access_token" ? (
            <>
              <div className="font-semibold">获取系统访问令牌</div>
              <ol className="my-1 list-decimal pl-4">
                <li>在浏览器登录 NewAPI 站点，进“个人设置”页</li>
                <li>找到“生成的系统访问令牌”一栏</li>
                <li>点生成并复制这串 32 位令牌（即 user.access_token）</li>
              </ol>
              <div>请求时用 {code("Authorization")} 头带上这个令牌，不再依赖 Cookie 续期。</div>
            </>
          ) : (
            <>
              <div className="font-semibold">获取 Cookie</div>
              <ol className="my-1 list-decimal pl-4">
                <li>在浏览器登录 NewAPI 站点，按 F12 打开开发者工具，切到 Network（网络）</li>
                <li>刷新页面，点列表里任意一个 {code("/api/")} 开头的请求，如 {code("self")}</li>
                <li>在 Request Headers（请求标头）里找到 {code("Cookie")}，复制冒号后面的整段，形如 {code("session=xxxxx; ...")}</li>
              </ol>
              <div>只粘 {code("session")} 的值、漏了前面的 {code("session=")}，上游会当成未登录。</div>
            </>
          )}
          <div className="mt-2 font-semibold">获取 User ID</div>
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
          <div className="font-semibold">获取 Access Token / Refresh Token</div>
          <ol className="my-1 list-decimal pl-4">
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
