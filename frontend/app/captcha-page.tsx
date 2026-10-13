import { useState } from "react"
import { Button, Card, Table, Tag, Toast, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { IconDelete, IconEdit, IconPlus, IconRefresh } from "@douyinfe/semi-icons"
import { PageHeader } from "@/components/layout/page-header"
import { CaptchaFormModal } from "@/components/monitor/captcha-form-modal"
import { apiFetch } from "@/lib/api"
import type { CaptchaConfig } from "@/lib/api-types"
import { confirm } from "@/lib/confirm"
import { decimal, fullDateTime, money, relativeTime } from "@/lib/format"
import { useCaptchaConfigs } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { useIsMobile } from "@/hooks/use-mobile"

const captchaTypeLabel: Record<string, string> = {
  yescaptcha: "YesCaptcha",
}

function formatCaptchaBalance(c: CaptchaConfig) {
  if (c.last_balance == null) return "—"
  if (c.balance_unit === "points") return `${decimal(c.last_balance, 0)} 点`
  return money(c.last_balance, { precise: true })
}

export default function CaptchaPage() {
  const isMobile = useIsMobile()
  const { data, loading } = useCaptchaConfigs()
  const refresh = useTriggerRefresh()
  const [editing, setEditing] = useState<CaptchaConfig | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)

  async function handleRefreshBalance(c: CaptchaConfig) {
    setBusy(c.id)
    try {
      await apiFetch(`/captcha-configs/${c.id}/refresh-balance`, { method: "POST" })
      Toast.success(`已更新 ${c.name} 剩余额度`)
    } catch (e) {
      Toast.error((e as Error).message || "更新失败")
    } finally {
      refresh()
      setBusy(null)
    }
  }

  async function handleDelete(c: CaptchaConfig) {
    const ok = await confirm({
      title: `删除打码配置 ${c.name}？`,
      description: "删除后引用此配置的渠道将无法自动过验证码，需要在渠道设置里重新指定。",
      confirmLabel: "删除",
      destructive: true,
    })
    if (!ok) return
    setBusy(c.id)
    try {
      await apiFetch(`/captcha-configs/${c.id}`, { method: "DELETE" })
      Toast.success(`已删除 ${c.name}`)
      refresh()
    } catch (e) {
      Toast.error((e as Error).message || "删除失败")
    } finally {
      setBusy(null)
    }
  }

  function openForm(c: CaptchaConfig | null) {
    setEditing(c)
    setFormOpen(true)
  }

  const columns: ColumnProps<CaptchaConfig>[] = [
    { title: "名称", dataIndex: "name", render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    { title: "类型", dataIndex: "type", width: 120, render: (v: string) => captchaTypeLabel[v] ?? v },
    {
      title: "剩余额度",
      key: "balance",
      width: 180,
      render: (_: unknown, c: CaptchaConfig) => (
        <div className="stack" style={{ gap: 2 }}>
          <span className="num">{formatCaptchaBalance(c)}</span>
          {c.balance_error ? (
            <Typography.Text type="danger" size="small" ellipsis={{ showTooltip: true }}>
              {c.balance_error}
            </Typography.Text>
          ) : (
            <Tooltip content={c.balance_at ? fullDateTime(c.balance_at) : "还没有查询过"}>
              <Typography.Text type="tertiary" size="small">
                {c.balance_at ? `更新于 ${relativeTime(c.balance_at)}` : "未更新"}
              </Typography.Text>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: "状态",
      dataIndex: "enabled",
      width: 90,
      render: (v: boolean) => <Tag color={v ? "green" : "grey"}>{v ? "已启用" : "已禁用"}</Tag>,
    },
    {
      title: "操作",
      key: "actions",
      width: 140,
      fixed: isMobile ? undefined : "right",
      render: (_: unknown, c: CaptchaConfig) => (
        <div className="row" style={{ gap: 4 }}>
          <Tooltip content="刷新余额">
            <Button
              aria-label="刷新余额"
              theme="borderless"
              size="small"
              icon={<IconRefresh spin={busy === c.id} />}
              disabled={busy === c.id}
              onClick={() => handleRefreshBalance(c)}
            />
          </Tooltip>
          <Tooltip content="编辑">
            <Button theme="borderless" size="small" icon={<IconEdit />} onClick={() => openForm(c)} aria-label="编辑" />
          </Tooltip>
          <Tooltip content="删除">
            <Button
              aria-label="删除"
              theme="borderless"
              type="danger"
              size="small"
              icon={<IconDelete />}
              disabled={busy === c.id}
              onClick={() => handleDelete(c)}
            />
          </Tooltip>
        </div>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="打码平台"
        description="配置 YesCaptcha；开启 Turnstile 的渠道登录时会自动调用。"
        actions={
          <Button theme="solid" icon={<IconPlus />} onClick={() => openForm(null)}>
            新增
          </Button>
        }
      />
      <Card bodyStyle={{ padding: 0 }}>
        <Table<CaptchaConfig>
          rowKey="id"
          size={isMobile ? "small" : "default"}
          columns={columns}
          dataSource={data ?? []}
          loading={loading && !data}
          scroll={{ x: 690 }}
          pagination={false}
          empty="还没有打码配置"
        />
      </Card>
      <CaptchaFormModal visible={formOpen} onClose={() => setFormOpen(false)} config={editing} />
    </div>
  )
}
