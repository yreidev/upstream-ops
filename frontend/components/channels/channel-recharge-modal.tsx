import { useEffect, useMemo, useRef, useState } from "react"
import QRCode from "qrcode"
import {
  Alert,
  Button,
  Description,
  Input,
  Label,
  Modal,
  Spinner,
  Surface,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react"
import { apiFetch } from "@/lib/api"
import type { Channel, ChannelRechargeInfo, ChannelRechargeLaunch, RechargePaymentMethod } from "@/lib/api-types"
import { channelTypeLabel, dateTime, decimal } from "@/lib/format"
import { useIsMobile } from "@/hooks/use-mobile"

/** 上游要求表单 POST 跳转时，在新标签页提交一个隐藏表单。 */
function openFormInNewTab(action: string, fields: Record<string, string>) {
  const form = document.createElement("form")
  form.method = "POST"
  form.action = action
  form.target = "_blank"
  form.style.display = "none"
  for (const [key, value] of Object.entries(fields)) {
    const input = document.createElement("input")
    input.type = "hidden"
    input.name = key
    input.value = value
    form.appendChild(input)
  }
  document.body.appendChild(form)
  form.submit()
  document.body.removeChild(form)
}

const paymentMethodLabel: Record<string, string> = {
  alipay: "支付宝",
  wxpay: "微信",
}

/** 在上游发起充值：跳转支付页、提交支付表单，或显示二维码。channel 为空时不显示。 */
export function ChannelRechargeModal({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const isMobile = useIsMobile()
  const channelID = channel?.id ?? null
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<ChannelRechargeInfo | null>(null)
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState<RechargePaymentMethod | "">("")
  const [launch, setLaunch] = useState<ChannelRechargeLaunch | null>(null)
  const [launchMethod, setLaunchMethod] = useState("")
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (channelID == null) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setInfo(null)
    setLaunch(null)
    setLaunchMethod("")
    setAmount("")
    setMethod("")
    apiFetch<ChannelRechargeInfo>(`/channels/${channelID}/recharge-info`)
      .then((data) => {
        if (cancelled) return
        setInfo(data)
        setMethod(data.methods?.[0]?.type ?? "")
        const preset = data.preset_amounts?.[0]
        if (preset != null) setAmount(String(preset))
        else if (data.min_amount > 0) setAmount(String(data.min_amount))
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message || "加载充值信息失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channelID])

  useEffect(() => {
    if (launch?.mode !== "qrcode" || !launch.qr_code || !qrCanvasRef.current) return
    let cancelled = false
    QRCode.toCanvas(qrCanvasRef.current, launch.qr_code, { width: 220, margin: 1 }).catch((e: unknown) => {
      if (!cancelled) {
        setError(e instanceof Error ? `生成二维码失败：${e.message}` : "生成二维码失败")
      }
    })
    return () => {
      cancelled = true
    }
  }, [launch])

  const parsedAmount = Number(amount)
  const selectedMethod = useMemo(() => info?.methods?.find((m) => m.type === method) ?? null, [info, method])
  const canSubmit = !!info && !!selectedMethod && Number.isFinite(parsedAmount) && parsedAmount > 0

  async function handleSubmit() {
    if (!channel || !selectedMethod) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await apiFetch<ChannelRechargeLaunch>(`/channels/${channel.id}/recharge`, {
        method: "POST",
        body: JSON.stringify({
          amount: parsedAmount,
          payment_method: selectedMethod.type,
          is_mobile: info?.alipay_force_qrcode && selectedMethod.type === "alipay" ? false : isMobile,
        }),
      })
      if (result.mode === "redirect" && result.pay_url) {
        window.open(result.pay_url, "_blank", "noopener,noreferrer")
        onClose()
        return
      }
      if (result.mode === "form" && result.form_action && result.form_fields) {
        openFormInNewTab(result.form_action, result.form_fields)
        onClose()
        return
      }
      if (result.mode === "qrcode" && result.qr_code) {
        setLaunch(result)
        setLaunchMethod(selectedMethod.type)
        return
      }
      throw new Error("上游返回的支付结果不完整")
    } catch (e) {
      setError((e as Error).message || "发起充值失败")
    } finally {
      setSubmitting(false)
    }
  }

  const showingQR = launch?.mode === "qrcode"

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
            <Modal.Heading>充值</Modal.Heading>
            {channel ? (
              <span className="text-xs font-normal text-muted">
                {channel.name} · {channelTypeLabel(channel.type)}
              </span>
            ) : null}
          </Modal.Header>
          <Modal.Body>
            <div className="stack gap-3.5">
              {showingQR ? (
                <Surface variant="secondary" className="stack items-center gap-2 rounded-2xl p-4">
                  <canvas ref={qrCanvasRef} className="rounded-lg bg-white p-2 shadow-xs" />
                  <span className="text-sm text-foreground">
                    请用{paymentMethodLabel[launchMethod] ?? launchMethod}扫码支付
                  </span>
                  {launch.expires_at ? (
                    <span className="text-xs text-muted">过期时间：{dateTime(launch.expires_at)}</span>
                  ) : null}
                </Surface>
              ) : loading ? (
                <div className="flex justify-center py-8">
                  <Spinner />
                </div>
              ) : info ? (
                <>
                  <TextField variant="secondary" value={amount} onChange={setAmount} isDisabled={submitting} fullWidth>
                    <Label>{info.amount_label || "充值金额"}</Label>
                    <Input inputMode="decimal" placeholder={`最低 ${decimal(info.min_amount)}`} />
                    <Description>
                      最小 {decimal(info.min_amount)}
                      {info.max_amount > 0 ? `，最大 ${decimal(info.max_amount)}` : ""}
                    </Description>
                  </TextField>

                  {info.preset_amounts?.length ? (
                    <div className="stack gap-1.5">
                      <span className="text-xs font-medium text-foreground">快捷金额</span>
                      <div className="row flex-wrap gap-2">
                        {info.preset_amounts.map((value) => (
                          <Button
                            key={value}
                            size="sm"
                            variant={amount === String(value) ? "primary" : "secondary"}
                            isDisabled={submitting}
                            onPress={() => setAmount(String(value))}
                            className="num"
                          >
                            {decimal(value)}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="stack gap-1.5">
                    <span className="text-xs font-medium text-foreground">支付方式</span>
                    {info.methods?.length ? (
                      <ToggleButtonGroup
                        aria-label="支付方式"
                        selectionMode="single"
                        disallowEmptySelection
                        selectedKeys={method ? new Set([method]) : new Set()}
                        onSelectionChange={(keys) => {
                          const first = [...keys][0]
                          if (first != null) setMethod(String(first) as RechargePaymentMethod)
                        }}
                        isDisabled={submitting}
                        size="sm"
                      >
                        {info.methods.map((m) => (
                          <ToggleButton key={m.type} id={m.type}>
                            {m.name}
                          </ToggleButton>
                        ))}
                      </ToggleButtonGroup>
                    ) : (
                      <span className="text-xs text-muted">上游没有开放可用的支付方式</span>
                    )}
                  </div>

                  {info.help_text ? (
                    <Alert status="accent">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Description className="pre-wrap">{info.help_text}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : null}
                  {info.help_image_url ? (
                    <img
                      src={info.help_image_url}
                      alt="充值说明"
                      className="max-h-48 w-full rounded-xl bg-white object-contain"
                    />
                  ) : null}
                </>
              ) : null}

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
            {showingQR ? (
              <>
                <Button variant="tertiary" onPress={() => setLaunch(null)}>
                  返回
                </Button>
                <Button variant="primary" onPress={onClose}>
                  关闭
                </Button>
              </>
            ) : (
              <>
                <Button variant="tertiary" isDisabled={submitting} onPress={onClose}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  isPending={submitting}
                  isDisabled={!canSubmit}
                  onPress={() => void handleSubmit()}
                >
                  {submitting ? <Spinner size="sm" color="current" /> : null}
                  立即充值
                </Button>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
