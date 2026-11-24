import { useEffect, useState, type FormEvent } from "react"
import { Alert, Button, Description, Input, Label, Modal, Spinner, TextField, toast } from "@heroui/react"
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

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (!channel || !code.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await apiFetch<ChannelRedeemResult>(`/channels/${channel.id}/redeem`, {
        method: "POST",
        body: JSON.stringify({ code }),
      })
      toast.success(redeemSummary(result))
      onClose()
      refresh()
    } catch (err) {
      setError((err as Error).message || "兑换失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal.Backdrop
      isOpen={channel != null}
      isDismissable={!submitting}
      isKeyboardDismissDisabled={submitting}
      onOpenChange={(open) => !open && !submitting && onClose()}
    >
      <Modal.Container size="md">
        <Modal.Dialog className="max-w-[460px]">
          <Modal.CloseTrigger isDisabled={submitting} />
          <Modal.Header className="flex flex-col items-start gap-0.5">
            <Modal.Heading>兑换码</Modal.Heading>
            {channel ? (
              <span className="text-xs font-normal text-muted">
                {channel.name} · {channelTypeLabel(channel.type)}
              </span>
            ) : null}
          </Modal.Header>
          <form onSubmit={handleSubmit}>
            <Modal.Body>
              <div className="stack gap-3">
                <TextField variant="secondary" value={code} onChange={setCode} isDisabled={submitting} fullWidth>
                  <Label>兑换码</Label>
                  <Input placeholder="请输入兑换码" autoFocus />
                  <Description>区分大小写，提交后直接调用上游的在线兑换接口。</Description>
                </TextField>
                {error ? (
                  <Alert status="danger">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description className="pre-wrap">{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={submitting} onPress={onClose}>
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                isPending={submitting}
                isDisabled={!code.trim()}
              >
                {submitting ? <Spinner size="sm" color="current" /> : null}
                立即兑换
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
