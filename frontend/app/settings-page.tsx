import { lazy, Suspense, useState } from "react"
import {
  Alert,
  Button,
  Chip,
  Description,
  Input,
  Label,
  NumberField,
  Spinner,
  Surface,
  Switch,
  TextField,
  toast,
} from "@heroui/react"
import { ArrowsRotateRight } from "@gravity-ui/icons"
import { PageHeader } from "@/components/layout/page-header"
import { CronPicker } from "@/components/settings/cron-picker"
import { SettingsSection } from "@/components/settings/settings-section"
import { PasswordInput } from "@/components/common/password-input"
import { apiFetch } from "@/lib/api"
import type { SystemConfig } from "@/lib/api-types"
import { useSystemConfig } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { useVersionCheck } from "@/hooks/use-version-check"

const UpdateNotesModal = lazy(() => import("@/components/monitor/update-notes-modal"))

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 把表单值整理成 PUT /settings/config 的请求体。清空的输入框在表单里可能是 undefined，
 * 这里统一补成空字符串或 0；以服务端返回的配置打底，保留表单上没有的字段。
 */
function buildPayload(base: SystemConfig, v: SystemConfig): SystemConfig {
  return {
    app: {
      ...base.app,
      title: str(v.app?.title),
      notificationPrefix: str(v.app?.notificationPrefix),
    },
    auth: {
      ...base.auth,
      enabled: Boolean(v.auth?.enabled),
      username: str(v.auth?.username),
      password: str(v.auth?.password),
      tokenSecret: str(v.auth?.tokenSecret),
      sessionTTLHours: num(v.auth?.sessionTTLHours),
    },
    scheduler: {
      ...base.scheduler,
      balanceCron: str(v.scheduler?.balanceCron),
      rateCron: str(v.scheduler?.rateCron),
      retention: {
        ...base.scheduler.retention,
        cron: str(v.scheduler?.retention?.cron),
        monitorLogsDays: num(v.scheduler?.retention?.monitorLogsDays),
        balanceSnapshotsDays: num(v.scheduler?.retention?.balanceSnapshotsDays),
        notificationLogsDays: num(v.scheduler?.retention?.notificationLogsDays),
        announcementsDays: num(v.scheduler?.retention?.announcementsDays),
      },
    },
    notifications: {
      ...base.notifications,
      minChangePct: num(v.notifications?.minChangePct),
      balanceLowCooldownMinutes: num(v.notifications?.balanceLowCooldownMinutes),
      sendMaxAttempts: num(v.notifications?.sendMaxAttempts),
    },
    upstream: {
      ...base.upstream,
      timeoutSeconds: num(v.upstream?.timeoutSeconds),
      userAgent: str(v.upstream?.userAgent),
    },
  }
}

function SettingsNumberField({
  label,
  value,
  onChange,
  hint,
  disabled,
  minValue = 0,
  step = 1,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  hint?: string
  disabled?: boolean
  minValue?: number
  step?: number
}) {
  return (
    <NumberField
      variant="secondary"
      value={value}
      onChange={(n) => onChange(Number.isFinite(n) ? n : 0)}
      minValue={minValue}
      step={step}
      isDisabled={disabled}
      fullWidth
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input className="num" />
        <NumberField.IncrementButton />
      </NumberField.Group>
      {hint ? <Description>{hint}</Description> : null}
    </NumberField>
  )
}

export default function SettingsPage() {
  const query = useSystemConfig()
  const refresh = useTriggerRefresh()
  const versionCheck = useVersionCheck()
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  // 表单只在拿到配置后初始化一次；之后的定时刷新不覆盖正在编辑的内容
  const [initial, setInitial] = useState<SystemConfig | null>(null)
  const [draft, setDraft] = useState<SystemConfig | null>(null)

  if (!initial && query.data?.config) {
    setInitial(query.data.config)
    setDraft(query.data.config)
  }

  function updateDraft(updater: (prev: SystemConfig) => SystemConfig) {
    setDraft((prev) => (prev ? updater(prev) : prev))
    setDirty(true)
  }

  async function handleSave() {
    if (!initial || !draft) return
    setSaving(true)
    try {
      const payload = buildPayload(initial, draft)
      await apiFetch("/settings/config", { method: "PUT", body: JSON.stringify(payload) })
      toast.success("已保存，立即生效")
      // 侧边栏和浏览器标签上的标题来自版本信息，改了标题就重新取一次
      if (payload.app.title !== initial.app.title) versionCheck.reload()
      setInitial(payload)
      setDraft(payload)
      setDirty(false)
      query.refetch()
      refresh()
    } catch (err) {
      toast.danger(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const configPath = query.data?.config_path
  const header = (
    <PageHeader
      title="设置"
      description={
        <>
          保存后立即生效，同时写入配置文件。通知渠道、打码平台在各自页面管理，改动实时生效。
          {configPath ? (
            <span className="mt-0.5 block">
              配置文件：
              <span className="mono break-all">{configPath}</span>
            </span>
          ) : null}
        </>
      }
    />
  )

  if (!initial || !draft) {
    return (
      <div className="page">
        {header}
        {query.error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{query.error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <div className="flex justify-center py-20">
            <Spinner size="lg" />
          </div>
        )}
      </div>
    )
  }

  // 被环境变量管着的项：启动和保存后都以环境变量为准，页面上改了也没用，所以锁住并注明
  const envOverrides = query.data?.env_overrides ?? {}
  const lockHint = (field: string, fallback?: string) =>
    envOverrides[field]
      ? `由环境变量 ${envOverrides[field]} 决定，要改请改环境变量后重启。`
      : fallback
  const isLocked = (field: string) => Boolean(envOverrides[field])

  const v = versionCheck.version

  return (
    <div className="page">
      {header}
      <div className="stack gap-4">
        <SettingsSection
          title="应用信息"
          description="页面标题和通知标题前缀。"
          extra={
            <div className="row flex-wrap gap-1.5">
              {v?.version ? (
                <Chip size="sm" variant="soft">
                  当前 v{v.version}
                </Chip>
              ) : null}
              {v?.latest_version ? (
                v.update_available ? (
                  <Button variant="ghost" size="sm" className="h-auto p-0" onPress={versionCheck.openNotes}>
                    <Chip color="warning" variant="soft" size="sm">
                      可更新到 {v.latest_version} · 查看更新日志
                    </Chip>
                  </Button>
                ) : (
                  <Chip color="success" variant="soft" size="sm">
                    已是最新
                  </Chip>
                )
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                isPending={versionCheck.checking}
                onPress={versionCheck.check}
              >
                {versionCheck.checking ? (
                  <Spinner size="sm" color="current" />
                ) : (
                  <ArrowsRotateRight className="size-3.5" />
                )}
                检测更新
              </Button>
            </div>
          }
        >
          <TextField
            variant="secondary"
            value={draft.app.title}
            onChange={(val) => updateDraft((p) => ({ ...p, app: { ...p.app, title: val } }))}
            isDisabled={isLocked("app.title")}
            fullWidth
          >
            <Label>应用标题</Label>
            <Input />
            <Description>{lockHint("app.title", "显示在侧边栏和浏览器标签上。")}</Description>
          </TextField>

          <TextField
            variant="secondary"
            value={draft.app.notificationPrefix}
            onChange={(val) => updateDraft((p) => ({ ...p, app: { ...p.app, notificationPrefix: val } }))}
            isDisabled={isLocked("app.notificationPrefix")}
            fullWidth
          >
            <Label>通知前缀</Label>
            <Input />
            <Description>{lockHint("app.notificationPrefix", "加在通知标题前面，留空不加。")}</Description>
          </TextField>
        </SettingsSection>

        <SettingsSection title="登录鉴权" description="后台是否需要登录，以及登录令牌怎么签发。">
          <div className="stack gap-1.5">
            <Label>启用登录</Label>
            <Switch
              isSelected={draft.auth.enabled}
              onChange={(val) => updateDraft((p) => ({ ...p, auth: { ...p.auth, enabled: val } }))}
              isDisabled={isLocked("auth.enabled")}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label className="text-sm font-normal">{draft.auth.enabled ? "已开启" : "已关闭"}</Label>
              </Switch.Content>
            </Switch>
            <Description>
              {lockHint("auth.enabled", "关闭后打开页面直接进入后台，不显示登录页。")}
            </Description>
          </div>

          <TextField
            variant="secondary"
            value={draft.auth.username}
            onChange={(val) => updateDraft((p) => ({ ...p, auth: { ...p.auth, username: val } }))}
            isDisabled={isLocked("auth.username")}
            fullWidth
          >
            <Label>管理员账号</Label>
            <Input />
            {isLocked("auth.username") ? <Description>{lockHint("auth.username")}</Description> : null}
          </TextField>

          <TextField
            variant="secondary"
            value={draft.auth.password}
            onChange={(val) => updateDraft((p) => ({ ...p, auth: { ...p.auth, password: val } }))}
            isDisabled={isLocked("auth.password")}
            fullWidth
          >
            <Label>管理员密码</Label>
            <PasswordInput variant="secondary" fullWidth />
            <Description>{lockHint("auth.password", "保存后用于新的登录。")}</Description>
          </TextField>

          <TextField
            variant="secondary"
            value={draft.auth.tokenSecret}
            onChange={(val) => updateDraft((p) => ({ ...p, auth: { ...p.auth, tokenSecret: val } }))}
            isDisabled={isLocked("auth.tokenSecret")}
            fullWidth
          >
            <Label>令牌签名密钥</Label>
            <PasswordInput variant="secondary" fullWidth />
            <Description>{lockHint("auth.tokenSecret", "留空时使用安全主密钥。")}</Description>
          </TextField>

          <SettingsNumberField
            label="登录有效期（小时）"
            value={draft.auth.sessionTTLHours}
            onChange={(val) => updateDraft((p) => ({ ...p, auth: { ...p.auth, sessionTTLHours: val } }))}
            hint={lockHint("auth.sessionTTLHours")}
            disabled={isLocked("auth.sessionTTLHours")}
            minValue={0}
          />
        </SettingsSection>

        <SettingsSection
          title="调度与保留策略"
          description="余额采集、倍率采集和历史数据清理多久跑一次。熟悉 Cron 表达式的可以选“自定义”直接填。"
        >
          <CronPicker
            label="余额采集"
            value={draft.scheduler.balanceCron}
            onChange={(val) => updateDraft((p) => ({ ...p, scheduler: { ...p.scheduler, balanceCron: val } }))}
            disabled={isLocked("scheduler.balanceCron")}
            offText="不定时采集余额与消费，需要时手动同步。"
            extraText={isLocked("scheduler.balanceCron") ? lockHint("scheduler.balanceCron") : undefined}
          />

          <CronPicker
            label="倍率采集"
            value={draft.scheduler.rateCron}
            onChange={(val) => updateDraft((p) => ({ ...p, scheduler: { ...p.scheduler, rateCron: val } }))}
            disabled={isLocked("scheduler.rateCron")}
            offText="不定时扫描分组倍率，需要时手动同步。"
            extraText={isLocked("scheduler.rateCron") ? lockHint("scheduler.rateCron") : undefined}
          />

          <CronPicker
            label="清理过期历史"
            value={draft.scheduler.retention.cron}
            onChange={(val) =>
              updateDraft((p) => ({
                ...p,
                scheduler: { ...p.scheduler, retention: { ...p.scheduler.retention, cron: val } },
              }))
            }
            disabled={isLocked("scheduler.retention.cron")}
            offText="不清理历史数据。"
            extraText={isLocked("scheduler.retention.cron") ? lockHint("scheduler.retention.cron") : undefined}
          />

          <SettingsNumberField
            label="监控日志保留天数"
            value={draft.scheduler.retention.monitorLogsDays}
            onChange={(val) =>
              updateDraft((p) => ({
                ...p,
                scheduler: { ...p.scheduler, retention: { ...p.scheduler.retention, monitorLogsDays: val } },
              }))
            }
            hint={lockHint("scheduler.retention.monitorLogsDays", "0 表示不清理。")}
            disabled={isLocked("scheduler.retention.monitorLogsDays")}
            minValue={0}
          />

          <SettingsNumberField
            label="余额快照保留天数"
            value={draft.scheduler.retention.balanceSnapshotsDays}
            onChange={(val) =>
              updateDraft((p) => ({
                ...p,
                scheduler: { ...p.scheduler, retention: { ...p.scheduler.retention, balanceSnapshotsDays: val } },
              }))
            }
            hint={lockHint("scheduler.retention.balanceSnapshotsDays", "余额与消费趋势图用这些数据。0 表示不清理。")}
            disabled={isLocked("scheduler.retention.balanceSnapshotsDays")}
            minValue={0}
          />

          <SettingsNumberField
            label="通知记录保留天数"
            value={draft.scheduler.retention.notificationLogsDays}
            onChange={(val) =>
              updateDraft((p) => ({
                ...p,
                scheduler: { ...p.scheduler, retention: { ...p.scheduler.retention, notificationLogsDays: val } },
              }))
            }
            hint={lockHint("scheduler.retention.notificationLogsDays", "0 表示不清理。")}
            disabled={isLocked("scheduler.retention.notificationLogsDays")}
            minValue={0}
          />

          <SettingsNumberField
            label="上游公告保留天数"
            value={draft.scheduler.retention.announcementsDays}
            onChange={(val) =>
              updateDraft((p) => ({
                ...p,
                scheduler: { ...p.scheduler, retention: { ...p.scheduler.retention, announcementsDays: val } },
              }))
            }
            hint={lockHint("scheduler.retention.announcementsDays", "0 表示不清理。")}
            disabled={isLocked("scheduler.retention.announcementsDays")}
            minValue={0}
          />
        </SettingsSection>

        <SettingsSection title="通知策略" description="怎么过滤和重试通知。">
          <SettingsNumberField
            label="最小涨跌幅（%）"
            value={draft.notifications.minChangePct}
            onChange={(val) => updateDraft((p) => ({ ...p, notifications: { ...p.notifications, minChangePct: val } }))}
            hint={lockHint("notifications.minChangePct", "变化幅度低于这个值的倍率变化不通知。")}
            disabled={isLocked("notifications.minChangePct")}
            minValue={0}
            step={0.01}
          />

          <SettingsNumberField
            label="余额不足冷却（分钟）"
            value={draft.notifications.balanceLowCooldownMinutes}
            onChange={(val) =>
              updateDraft((p) => ({ ...p, notifications: { ...p.notifications, balanceLowCooldownMinutes: val } }))
            }
            hint={lockHint("notifications.balanceLowCooldownMinutes", "同一渠道两次余额告警的最短间隔。")}
            disabled={isLocked("notifications.balanceLowCooldownMinutes")}
            minValue={0}
          />

          <SettingsNumberField
            label="发送最大尝试次数"
            value={draft.notifications.sendMaxAttempts}
            onChange={(val) =>
              updateDraft((p) => ({ ...p, notifications: { ...p.notifications, sendMaxAttempts: val } }))
            }
            hint={lockHint("notifications.sendMaxAttempts", "发送失败后最多尝试几次。")}
            disabled={isLocked("notifications.sendMaxAttempts")}
            minValue={1}
          />
        </SettingsSection>

        <SettingsSection title="上游请求" description="访问上游站点时的超时和 User-Agent。">
          <SettingsNumberField
            label="超时（秒）"
            value={draft.upstream.timeoutSeconds}
            onChange={(val) => updateDraft((p) => ({ ...p, upstream: { ...p.upstream, timeoutSeconds: val } }))}
            hint={lockHint("upstream.timeoutSeconds", "小于等于 0 时用默认的 30 秒。")}
            disabled={isLocked("upstream.timeoutSeconds")}
            minValue={0}
          />

          <TextField
            variant="secondary"
            value={draft.upstream.userAgent}
            onChange={(val) => updateDraft((p) => ({ ...p, upstream: { ...p.upstream, userAgent: val } }))}
            isDisabled={isLocked("upstream.userAgent")}
            fullWidth
          >
            <Label>User-Agent</Label>
            <Input />
            <Description>{lockHint("upstream.userAgent", "留空用默认值。")}</Description>
          </TextField>
        </SettingsSection>

        <Surface className="sticky-actions">
          <span className={`min-w-0 flex-1 text-xs ${dirty ? "font-medium text-warning" : "text-muted"}`}>
            {dirty ? "有未保存的修改" : "保存后立即生效"}
          </span>
          <Button variant="primary" isPending={saving} onPress={() => void handleSave()}>
            {saving ? <Spinner size="sm" color="current" /> : null}
            保存
          </Button>
        </Surface>
      </div>

      {versionCheck.notesOpen ? (
        <Suspense fallback={null}>
          <UpdateNotesModal visible onClose={versionCheck.closeNotes} version={v} />
        </Suspense>
      ) : null}
    </div>
  )
}
