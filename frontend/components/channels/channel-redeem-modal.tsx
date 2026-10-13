import { useEffect, useState } from "react"
import { Banner, Input, Modal, Toast, Typography } from "@douyinfe/semi-ui"
import { apiFetch } from "@/lib/api"
import type { Channel, ChannelRedeemResult } from "@/lib/api-types"
import { channelTypeLabel, money } from "@/lib/format"
import { useTriggerRefresh } from "@/lib/refresh-context"

function redeemSummary(result: ChannelRedeemResult) {
  const base = result.message || "兑换成功"
  if (result.type === "subscription") {
    const group = result.group_name ? ` · ${result.group_name}` : ""
    const days = result.validity_days ? ` · ${result.validity_days} 天` : ""
    return `${base}${group}${days}`
  }
  if (result.type === "concurrency") {
    return result.new_concurrency != null ? `${base} · 当前并发 ${result.new_concurrency}` : base
  }
  return result.new_balance != null ? `${base} · 当前余额 ${money(result.new_balance)}` : base
}

/** 在上游在线兑换兑换码。channel 为空时不显示。 */
export function ChannelRedeemModal({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const [code, setCode] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useTriggerRefresh()

  useEffect(() => {
    if (channel) {
      setCode("")
      setError(null)
    }
  }, [channel])

  async function handleOk() {
    if (!channel || !code.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await apiFetch<ChannelRedeemResult>(`/channels/${channel.id}/redeem`, {
        method: "POST",
        body: JSON.stringify({ code }),
      })
      Toast.success(redeemSummary(result))
      onClose()
      refresh()
    } catch (e) {
      setError((e as Error).message || "兑换失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      visible={channel != null}
      title="兑换码"
      onCancel={onClose}
      onOk={handleOk}
      okText="立即兑换"
      okButtonProps={{ disabled: !code.trim() }}
      confirmLoading={submitting}
      width={460}
    >
      <div className="stack" style={{ gap: 12 }}>
        {channel ? (
          <Typography.Text type="tertiary">
            {channel.name} · {channelTypeLabel(channel.type)}
          </Typography.Text>
        ) : null}
        <div className="stack" style={{ gap: 4 }}>
          <Input
            value={code}
            onChange={setCode}
            placeholder="请输入兑换码"
            disabled={submitting}
            onEnterPress={handleOk}
            autoFocus
          />
          <Typography.Text type="tertiary" size="small">
            区分大小写，提交后直接调用上游的在线兑换接口。
          </Typography.Text>
        </div>
        {error ? <Banner fullMode={false} type="danger" closeIcon={null} description={error} /> : null}
      </div>
    </Modal>
  )
}
