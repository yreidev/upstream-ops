import { useState } from "react"
import { Button, Chip, EmptyState, Spinner, Surface, Table, Tooltip, toast } from "@heroui/react"
import { ArrowsRotateRight, Pencil, Plus, TrashBin } from "@gravity-ui/icons"
import { PageHeader } from "@/components/layout/page-header"
import { CaptchaFormModal } from "@/components/monitor/captcha-form-modal"
import { apiFetch } from "@/lib/api"
import type { CaptchaConfig } from "@/lib/api-types"
import { confirm } from "@/lib/confirm"
import { decimal, fullDateTime, money, relativeTime } from "@/lib/format"
import { useCaptchaConfigs } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"

const captchaTypeLabel: Record<string, string> = {
  yescaptcha: "YesCaptcha",
}

function formatCaptchaBalance(c: CaptchaConfig) {
  if (c.last_balance == null) return "—"
  if (c.balance_unit === "points") return `${decimal(c.last_balance, 0)} 点`
  return money(c.last_balance, { precise: true })
}

export default function CaptchaPage() {
  const { data, loading } = useCaptchaConfigs()
  const refresh = useTriggerRefresh()
  const [editing, setEditing] = useState<CaptchaConfig | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)

  async function handleRefreshBalance(c: CaptchaConfig) {
    setBusy(c.id)
    try {
      await apiFetch(`/captcha-configs/${c.id}/refresh-balance`, { method: "POST" })
      toast.success(`已更新 ${c.name} 剩余额度`)
    } catch (e) {
      toast.danger((e as Error).message || "更新失败")
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
      toast.success(`已删除 ${c.name}`)
      refresh()
    } catch (e) {
      toast.danger((e as Error).message || "删除失败")
    } finally {
      setBusy(null)
    }
  }

  function openForm(c: CaptchaConfig | null) {
    setEditing(c)
    setFormOpen(true)
  }

  return (
    <div className="page">
      <PageHeader
        title="打码平台"
        description="配置 YesCaptcha；开启 Turnstile 的渠道登录时会自动调用。"
        actions={
          <Button variant="primary" size="sm" onPress={() => openForm(null)}>
            <Plus className="size-4" />
            新增
          </Button>
        }
      />

      {loading && !data ? (
        <Surface className="flex justify-center rounded-[20px] py-12">
          <Spinner />
        </Surface>
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="打码平台配置列表" className="min-w-[640px]">
              <Table.Header>
                <Table.Column isRowHeader>名称</Table.Column>
                <Table.Column className="w-32">类型</Table.Column>
                <Table.Column className="w-48">剩余额度</Table.Column>
                <Table.Column className="w-24">状态</Table.Column>
                <Table.Column className="w-36">操作</Table.Column>
              </Table.Header>
              <Table.Body
                items={data ?? []}
                renderEmptyState={() => <EmptyState className="py-12 text-sm text-muted">还没有打码配置</EmptyState>}
              >
                {(c) => (
                  <Table.Row key={c.id} id={c.id}>
                    <Table.Cell>
                      <span className="font-semibold text-foreground">{c.name}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="text-sm text-foreground">{captchaTypeLabel[c.type] ?? c.type}</span>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="stack gap-0.5">
                        <span className="num text-sm text-foreground">{formatCaptchaBalance(c)}</span>
                        {c.balance_error ? (
                          <span className="truncate text-xs text-danger" title={c.balance_error}>
                            {c.balance_error}
                          </span>
                        ) : (
                          <Tooltip>
                            <Tooltip.Trigger className="inline-flex w-fit">
                              <span className="text-xs text-muted">
                                {c.balance_at ? `更新于 ${relativeTime(c.balance_at)}` : "未更新"}
                              </span>
                            </Tooltip.Trigger>
                            <Tooltip.Content>
                              {c.balance_at ? fullDateTime(c.balance_at) : "还没有查询过"}
                            </Tooltip.Content>
                          </Tooltip>
                        )}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Chip color={c.enabled ? "success" : "default"} variant="soft" size="sm">
                        {c.enabled ? "已启用" : "已禁用"}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="row gap-0.5">
                        <Tooltip>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label="刷新余额"
                            isDisabled={busy === c.id}
                            onPress={() => void handleRefreshBalance(c)}
                          >
                            <ArrowsRotateRight className={`size-4 ${busy === c.id ? "animate-spin" : ""}`} />
                          </Button>
                          <Tooltip.Content>刷新余额</Tooltip.Content>
                        </Tooltip>
                        <Tooltip>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label="编辑"
                            onPress={() => openForm(c)}
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
                            isDisabled={busy === c.id}
                            onPress={() => void handleDelete(c)}
                          >
                            <TrashBin className="size-4" />
                          </Button>
                          <Tooltip.Content>删除</Tooltip.Content>
                        </Tooltip>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      <CaptchaFormModal visible={formOpen} onClose={() => setFormOpen(false)} config={editing} />
    </div>
  )
}
