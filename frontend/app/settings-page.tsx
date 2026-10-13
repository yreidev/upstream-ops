import { lazy, Suspense, useRef, useState } from "react"
import { Banner, Button, Form, Spin, Tag, Toast, Typography } from "@douyinfe/semi-ui"
import type { FormApi } from "@douyinfe/semi-ui/lib/es/form"
import { IconRefresh } from "@douyinfe/semi-icons"
import { PageHeader } from "@/components/layout/page-header"
import { CCHSyncSection } from "@/components/settings/cch-sync-section"
import { SettingsSection } from "@/components/settings/settings-section"
import { apiFetch } from "@/lib/api"
import type { ApplyConfigResult, SystemConfig } from "@/lib/api-types"
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
function buildPayload(base: SystemConfig, v: Partial<SystemConfig>): SystemConfig {
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
      concurrency: num(v.scheduler?.concurrency),
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

export default function SettingsPage() {
  const query = useSystemConfig()
  const refresh = useTriggerRefresh()
  const versionCheck = useVersionCheck()
  const formApi = useRef<FormApi | null>(null)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pendingApply, setPendingApply] = useState(false)
  // 表单只在拿到配置后挂载一次；之后的定时刷新不覆盖正在编辑的内容
  const [initial, setInitial] = useState<SystemConfig | null>(null)

  if (!initial && query.data?.config) setInitial(query.data.config)

  async function handleSave() {
    if (!formApi.current || !initial) return
    setSaving(true)
    try {
      const payload = buildPayload(initial, formApi.current.getValues() as Partial<SystemConfig>)
      await apiFetch("/settings/config", { method: "PUT", body: JSON.stringify(payload) })
      Toast.success("已写入配置文件")
      setInitial(payload)
      setDirty(false)
      setPendingApply(true)
      query.refetch()
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function handleApply() {
    setApplying(true)
    try {
      const result = await apiFetch<ApplyConfigResult>("/settings/apply", { method: "POST" })
      Toast.success(result.message)
      setPendingApply(false)
      query.refetch()
      refresh()
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "应用失败")
    } finally {
      setApplying(false)
    }
  }

  const header = (
    <PageHeader
      title="设置"
      description="保存只写入配置文件，点“应用”后鉴权、调度、通知策略和上游请求立即生效。CCH 成本倍率同步在页面下方单独保存；通知渠道、打码平台在各自页面管理，改动实时生效。"
    />
  )

  if (!initial) {
    return (
      <div className="page">
        {header}
        {query.error ? (
          <Banner fullMode={false} type="danger" closeIcon={null} description={query.error} />
        ) : (
          <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
            <Spin size="large" />
          </div>
        )}
      </div>
    )
  }

  // 被环境变量管着的项：启动和“应用”都以环境变量为准，页面上改了也没用，所以锁住并注明
  const envOverrides = query.data?.env_overrides ?? {}
  const lock = (field: string) =>
    envOverrides[field]
      ? { disabled: true, extraText: `由环境变量 ${envOverrides[field]} 决定，要改请改环境变量后重启。` }
      : {}

  const v = versionCheck.version
  const statusText = dirty
    ? "有未保存的修改"
    : pendingApply
      ? "已保存，点“应用”后立即生效"
      : "保存写入配置文件，应用让改动立即生效"

  return (
    <div className="page">
      {header}
      {/* 浮动栏只跟着上面这几块走，滚到下面单独保存的 CCH 同步时就停在这里，免得看成同一个保存 */}
      <div className="stack" style={{ gap: 16 }}>
        <Form
          labelPosition="top"
          initValues={initial}
          allowEmpty
          getFormApi={(api) => (formApi.current = api)}
          onValueChange={() => setDirty(true)}
          className="stack"
          style={{ gap: 16 }}
        >
          <SettingsSection
            title="应用信息"
            description="页面标题和通知标题前缀。"
            extra={
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {v?.version ? <Tag>当前 v{v.version}</Tag> : null}
                {v?.latest_version ? (
                  v.update_available ? (
                    <Tag color="orange" style={{ cursor: "pointer" }} onClick={versionCheck.openNotes}>
                      可更新到 {v.latest_version} · 查看更新日志
                    </Tag>
                  ) : (
                    <Tag color="green">已是最新</Tag>
                  )
                ) : null}
                <Button size="small" icon={<IconRefresh />} loading={versionCheck.checking} onClick={versionCheck.check}>
                  检测更新
                </Button>
              </div>
            }
          >
            <Form.Input field="app.title" label="应用标题" extraText="显示在侧边栏和浏览器标签上。" {...lock("app.title")} />
            <Form.Input field="app.notificationPrefix" label="通知前缀" extraText="加在通知标题前面，留空不加。" {...lock("app.notificationPrefix")} />
          </SettingsSection>

          <SettingsSection title="登录鉴权" description="后台是否需要登录，以及登录令牌怎么签发。应用后立即生效。">
            <Form.Switch field="auth.enabled" label="启用登录" extraText="关闭后打开页面直接进入后台，不显示登录页。" {...lock("auth.enabled")} />
            <Form.Input field="auth.username" label="管理员账号" {...lock("auth.username")} />
            <Form.Input field="auth.password" label="管理员密码" mode="password" extraText="应用后用于新的登录。" {...lock("auth.password")} />
            <Form.Input field="auth.tokenSecret" label="令牌签名密钥" mode="password" extraText="留空时使用安全主密钥。" {...lock("auth.tokenSecret")} />
            <Form.InputNumber field="auth.sessionTTLHours" label="登录有效期（小时）" min={0} style={{ width: "100%" }} {...lock("auth.sessionTTLHours")} />
          </SettingsSection>

          <SettingsSection title="调度与保留策略" description="余额采集、倍率采集和历史数据清理的周期。Cron 带秒，共 6 段。">
            <Form.Input field="scheduler.balanceCron" label="余额采集 Cron" extraText="余额与消费的同步周期。" className="mono" {...lock("scheduler.balanceCron")} />
            <Form.Input field="scheduler.rateCron" label="倍率采集 Cron" extraText="分组倍率的扫描周期。" className="mono" {...lock("scheduler.rateCron")} />
            <Form.InputNumber field="scheduler.concurrency" label="并发数" extraText="每轮最多同时处理的渠道数。" min={1} style={{ width: "100%" }} {...lock("scheduler.concurrency")} />
            <Form.Input field="scheduler.retention.cron" label="清理任务 Cron" extraText="留空则不清理历史数据。" className="mono" {...lock("scheduler.retention.cron")} />
            <Form.InputNumber field="scheduler.retention.monitorLogsDays" label="监控日志保留天数" extraText="0 表示不清理。" min={0} style={{ width: "100%" }} {...lock("scheduler.retention.monitorLogsDays")} />
            <Form.InputNumber field="scheduler.retention.balanceSnapshotsDays" label="余额快照保留天数" extraText="余额与消费趋势图用这些数据。0 表示不清理。" min={0} style={{ width: "100%" }} {...lock("scheduler.retention.balanceSnapshotsDays")} />
            <Form.InputNumber field="scheduler.retention.notificationLogsDays" label="通知记录保留天数" extraText="0 表示不清理。" min={0} style={{ width: "100%" }} {...lock("scheduler.retention.notificationLogsDays")} />
            <Form.InputNumber field="scheduler.retention.announcementsDays" label="上游公告保留天数" extraText="0 表示不清理。" min={0} style={{ width: "100%" }} {...lock("scheduler.retention.announcementsDays")} />
          </SettingsSection>

          <SettingsSection title="通知策略" description="怎么过滤和重试通知。">
            <Form.InputNumber field="notifications.minChangePct" label="最小涨跌幅（%）" extraText="变化幅度低于这个值的倍率变化不通知。" min={0} step={0.01} style={{ width: "100%" }} {...lock("notifications.minChangePct")} />
            <Form.InputNumber field="notifications.balanceLowCooldownMinutes" label="余额不足冷却（分钟）" extraText="同一渠道两次余额告警的最短间隔。" min={0} style={{ width: "100%" }} {...lock("notifications.balanceLowCooldownMinutes")} />
            <Form.InputNumber field="notifications.sendMaxAttempts" label="发送最大尝试次数" extraText="发送失败后最多尝试几次。" min={1} style={{ width: "100%" }} {...lock("notifications.sendMaxAttempts")} />
          </SettingsSection>

          <SettingsSection title="上游请求" description="访问上游站点时的超时和 User-Agent。">
            <Form.InputNumber field="upstream.timeoutSeconds" label="超时（秒）" extraText="小于等于 0 时用默认的 30 秒。" min={0} style={{ width: "100%" }} {...lock("upstream.timeoutSeconds")} />
            <Form.Input field="upstream.userAgent" label="User-Agent" extraText="留空用默认值。" {...lock("upstream.userAgent")} />
          </SettingsSection>
        </Form>

        <div className="sticky-actions">
          <Typography.Text type={dirty || pendingApply ? "warning" : "tertiary"} size="small">
            {statusText}
          </Typography.Text>
          {query.data?.config_path ? (
            <Typography.Text type="tertiary" size="small" className="mono truncate" style={{ flex: 1, minWidth: 0 }}>
              {query.data.config_path}
            </Typography.Text>
          ) : (
            <span style={{ flex: 1 }} />
          )}
          <Button onClick={handleApply} loading={applying} disabled={saving}>
            应用
          </Button>
          <Button theme="solid" onClick={handleSave} loading={saving} disabled={applying}>
            保存
          </Button>
        </div>
      </div>

      <CCHSyncSection />

      {versionCheck.notesOpen ? (
        <Suspense fallback={null}>
          <UpdateNotesModal visible onClose={versionCheck.closeNotes} version={v} />
        </Suspense>
      ) : null}
    </div>
  )
}
