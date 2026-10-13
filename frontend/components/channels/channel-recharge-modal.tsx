import { useEffect, useMemo, useRef, useState } from "react"
import QRCode from "qrcode"
import { Banner, Button, Input, Modal, Radio, RadioGroup, Spin, Typography } from "@douyinfe/semi-ui"
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography.Text strong size="small" style={{ display: "block", marginBottom: 4 }}>
      {children}
    </Typography.Text>
  )
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
    void QRCode.toCanvas(qrCanvasRef.current, launch.qr_code, { width: 220, margin: 1 })
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

  const footer = showingQR ? (
    <>
      <Button onClick={() => setLaunch(null)}>返回</Button>
      <Button theme="solid" onClick={onClose}>
        关闭
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} disabled={submitting}>
        取消
      </Button>
      <Button theme="solid" onClick={handleSubmit} loading={submitting} disabled={!canSubmit}>
        立即充值
      </Button>
    </>
  )

  return (
    <Modal visible={channel != null} title="充值" onCancel={onClose} footer={footer} width={460}>
      <div className="stack" style={{ gap: 14 }}>
        {channel ? (
          <Typography.Text type="tertiary">
            {channel.name} · {channelTypeLabel(channel.type)}
          </Typography.Text>
        ) : null}

        {showingQR ? (
          <div className="stack" style={{ alignItems: "center", gap: 8, padding: 16, borderRadius: 8, background: "var(--semi-color-fill-0)" }}>
            <canvas ref={qrCanvasRef} style={{ borderRadius: 4, background: "#fff", padding: 8 }} />
            <Typography.Text>请用{paymentMethodLabel[launchMethod] ?? launchMethod}扫码支付</Typography.Text>
            {launch.expires_at ? (
              <Typography.Text type="tertiary" size="small">
                过期时间：{dateTime(launch.expires_at)}
              </Typography.Text>
            ) : null}
          </div>
        ) : loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <Spin />
          </div>
        ) : info ? (
          <>
            <div>
              <FieldLabel>{info.amount_label || "充值金额"}</FieldLabel>
              <Input
                inputMode="decimal"
                value={amount}
                onChange={setAmount}
                placeholder={`最低 ${decimal(info.min_amount)}`}
                disabled={submitting}
              />
              <Typography.Text type="tertiary" size="small">
                最小 {decimal(info.min_amount)}
                {info.max_amount > 0 ? `，最大 ${decimal(info.max_amount)}` : ""}
              </Typography.Text>
            </div>

            {info.preset_amounts?.length ? (
              <div>
                <FieldLabel>快捷金额</FieldLabel>
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                  {info.preset_amounts.map((value) => (
                    <Button
                      key={value}
                      size="small"
                      theme={amount === String(value) ? "solid" : "light"}
                      onClick={() => setAmount(String(value))}
                      disabled={submitting}
                    >
                      {decimal(value)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <FieldLabel>支付方式</FieldLabel>
              {info.methods?.length ? (
                <RadioGroup
                  type="button"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as RechargePaymentMethod)}
                  disabled={submitting}
                >
                  {info.methods.map((m) => (
                    <Radio key={m.type} value={m.type}>
                      {m.name}
                    </Radio>
                  ))}
                </RadioGroup>
              ) : (
                <Typography.Text type="tertiary" size="small">
                  上游没有开放可用的支付方式
                </Typography.Text>
              )}
            </div>

            {info.help_text ? <Banner fullMode={false} type="info" closeIcon={null} description={<span className="pre-wrap">{info.help_text}</span>} /> : null}
            {info.help_image_url ? (
              <img
                src={info.help_image_url}
                alt="充值说明"
                style={{ maxHeight: 192, width: "100%", objectFit: "contain", background: "#fff", borderRadius: 8 }}
              />
            ) : null}
          </>
        ) : null}

        {error ? <Banner fullMode={false} type="danger" closeIcon={null} description={error} /> : null}
      </div>
    </Modal>
  )
}
