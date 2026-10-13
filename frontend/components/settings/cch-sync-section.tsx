import { useRef, useState } from "react"
import { Banner, Button, Form, Table, Tag, Toast, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { FormApi } from "@douyinfe/semi-ui/lib/es/form"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import type { TagColor } from "@douyinfe/semi-ui/lib/es/tag"
import { SettingsSection } from "@/components/settings/settings-section"
import { apiFetch } from "@/lib/api"
import type { CCHSyncItem, CCHSyncResult, CCHSyncSettings, CCHSyncStatus } from "@/lib/api-types"
import { confirm } from "@/lib/confirm"
import { formatRatio, fullDateTime, relativeTime } from "@/lib/format"
import { useCCHSyncSettings } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const statusMeta: Record<CCHSyncStatus, { label: string; color: TagColor }> = {
  in_sync: { label: "已一致", color: "green" },
  pending: { label: "待同步", color: "orange" },
  updated: { label: "已修改", color: "blue" },
  failed: { label: "修改失败", color: "red" },
  skipped: { label: "未同步", color: "grey" },
}

interface FormValues {
  enabled: boolean
  base_url: string
  token: string
}

const columns: ColumnProps<CCHSyncItem>[] = [
  {
    title: "CCH 供应商",
    dataIndex: "provider_name",
    width: 220,
    render: (name: string, item) => (
      <div className="stack" style={{ gap: 2 }}>
        <div className="row" style={{ gap: 6 }}>
          <Typography.Text strong>{name}</Typography.Text>
          {item.provider_enabled ? null : (
            <Tag size="small" color="grey">
              已停用
            </Tag>
          )}
        </div>
        <Typography.Text type="tertiary" size="small">
          {item.provider_host || "—"}
          {item.key_tail ? ` · 尾号 ${item.key_tail}` : ""}
        </Typography.Text>
      </div>
    ),
  },
  {
    title: "对应上游分组",
    dataIndex: "group_name",
    width: 240,
    render: (_: unknown, item) =>
      item.channel_name ? (
        <div className="stack" style={{ gap: 2 }}>
          <Typography.Text>
            {item.channel_name}
            {item.group_name ? ` · ${item.group_name}` : ""}
          </Typography.Text>
          {item.key_name ? (
            <Typography.Text type="tertiary" size="small">
              密钥 {item.key_name}
            </Typography.Text>
          ) : null}
        </div>
      ) : (
        <Typography.Text type="tertiary">—</Typography.Text>
      ),
  },
  {
    title: "成本倍率",
    dataIndex: "current",
    width: 150,
    render: (current: number, item) => (
      <span className="num">
        {item.target != null && item.target !== current
          ? `${formatRatio(current)} → ${formatRatio(item.target)}`
          : formatRatio(current)}
      </span>
    ),
  },
  {
    title: "结果",
    dataIndex: "status",
    render: (status: CCHSyncStatus, item) => (
      <div className="stack" style={{ gap: 2 }}>
        <span>
          <Tag color={statusMeta[status].color}>{statusMeta[status].label}</Tag>
        </span>
        {item.reason ? (
          <Typography.Text type={status === "failed" ? "danger" : "tertiary"} size="small">
            {item.reason}
          </Typography.Text>
        ) : null}
      </div>
    ),
  },
]

function resultText(r: CCHSyncResult) {
  const parts = r.applied
    ? [r.updated ? `改了 ${r.updated} 个` : "", r.failed ? `修改失败 ${r.failed} 个` : ""]
    : [r.pending ? `待同步 ${r.pending} 个` : ""]
  parts.push(`已一致 ${r.in_sync} 个`, r.skipped ? `未同步 ${r.skipped} 个` : "")
  return parts.filter(Boolean).join("，")
}

/** 设置页里的 CCH 成本倍率同步：单独保存、立即生效，可以先检查配对再手动同步。 */
export function CCHSyncSection() {
  const isMobile = useIsMobile()
  const query = useCCHSyncSettings()
  const formApi = useRef<FormApi<FormValues> | null>(null)
  // 表单只在拿到配置后挂载一次；之后的定时刷新只更新状态行，不覆盖正在编辑的内容
  const [initial, setInitial] = useState<CCHSyncSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<CCHSyncResult | null>(null)

  if (!initial && query.data) setInitial(query.data)
  const saved = query.data ?? initial

  async function handleSave() {
    if (!formApi.current) return
    const v = formApi.current.getValues()
    setSaving(true)
    try {
      const view = await apiFetch<CCHSyncSettings>("/cch-sync", {
        method: "PUT",
        body: JSON.stringify({ enabled: Boolean(v.enabled), base_url: v.base_url ?? "", token: v.token ?? "" }),
      })
      Toast.success(view.enabled ? "已保存，下一轮倍率采集后自动同步" : "已保存")
      query.setData(view)
      formApi.current.setValues({ enabled: view.enabled, base_url: view.base_url, token: "" }, { isOverride: true })
      setDirty(false)
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  function ensureSaved() {
    if (!dirty) return true
    Toast.warning("先保存上面的修改")
    return false
  }

  async function handleCheck() {
    if (!ensureSaved()) return
    setChecking(true)
    try {
      setResult(await apiFetch<CCHSyncResult>("/cch-sync/preview", { method: "POST" }))
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "检查失败")
    } finally {
      setChecking(false)
    }
  }

  async function handleRun() {
    if (!ensureSaved()) return
    const ok = await confirm({
      title: "现在同步到 CCH？",
      description: "成本倍率和上游分组倍率不一致的供应商会被改成分组倍率，CCH 之后的计费立即按新倍率算。",
      confirmLabel: "同步",
    })
    if (!ok) return
    setRunning(true)
    try {
      const r = await apiFetch<CCHSyncResult>("/cch-sync/run", { method: "POST" })
      setResult(r)
      if (r.failed) Toast.warning(resultText(r))
      else Toast.success(r.updated ? `已改 ${r.updated} 个供应商` : "都已一致，没有要改的")
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "同步失败")
    } finally {
      setRunning(false)
      query.refetch()
    }
  }

  if (!initial) return null

  const footer = (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Button theme="solid" onClick={handleSave} loading={saving}>
          保存
        </Button>
        <Button onClick={handleCheck} loading={checking} disabled={!saved?.base_url || !saved.token_set}>
          检查配对
        </Button>
        <Button onClick={handleRun} loading={running} disabled={!saved?.base_url || !saved.token_set}>
          立即同步
        </Button>
        {saved?.last_run_at ? (
          <Typography.Text type="tertiary" size="small">
            上次同步
            <Tooltip content={fullDateTime(saved.last_run_at)}>
              <span> {relativeTime(saved.last_run_at)}</span>
            </Tooltip>
            {saved.last_summary ? `：${saved.last_summary}` : ""}
          </Typography.Text>
        ) : null}
      </div>
      {saved?.last_error ? (
        <Banner fullMode={false} type="danger" closeIcon={null} description={`上次同步出错：${saved.last_error}`} />
      ) : null}
      {result ? (
        <div className="stack" style={{ gap: 8 }}>
          <Typography.Text type="tertiary" size="small">
            {result.applied ? "同步结果" : "配对检查（还没改 CCH）"}：{resultText(result)}
          </Typography.Text>
          <Table<CCHSyncItem>
            rowKey="provider_id"
            size="small"
            columns={columns}
            dataSource={result.items}
            pagination={false}
            scroll={{ x: 760 }}
            empty="CCH 里没有供应商"
          />
        </div>
      ) : null}
    </div>
  )

  return (
    <Form<FormValues>
      labelPosition="top"
      initValues={{ enabled: initial.enabled, base_url: initial.base_url, token: "" }}
      allowEmpty
      getFormApi={(api) => (formApi.current = api)}
      onValueChange={() => setDirty(true)}
    >
      <SettingsSection
        title="CCH 成本倍率同步"
        description={
          isMobile
            ? "把上游分组倍率同步成 CCH 供应商的成本倍率。单独保存，立即生效。"
            : "每轮倍率采集后，把上游分组倍率同步成 Claude Code Hub 供应商的成本倍率：按站点地址和密钥尾号自动配对，不一致就改并发通知。这一块单独保存，立即生效。"
        }
        footer={footer}
      >
        <Form.Switch field="enabled" label="自动同步" extraText="开启后每轮倍率采集结束都同步一次；关着也能手动同步。" />
        <Form.Input
          field="base_url"
          label="CCH 地址"
          placeholder="https://cch.example.com"
          extraText="CCH 管理后台的地址；和 upstream-ops 在同一集群时也可以填内网服务地址。"
        />
        <Form.Input
          field="token"
          label="管理令牌"
          mode="password"
          autoComplete="new-password"
          placeholder={initial.token_set ? "已保存，留空不修改" : "CCH 的 ADMIN_TOKEN"}
          extraText="加密保存在数据库里，页面不会回显。"
        />
      </SettingsSection>
    </Form>
  )
}
