"use client"

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import QRCode from "qrcode"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiFetch } from "@/lib/api"
import { channelTypeLabel, dateTime, decimal } from "@/lib/format"
import { useIsMobile } from "@/hooks/use-mobile"
import type {
  Channel,
  ChannelRechargeInfo,
  ChannelRechargeLaunch,
  RechargePaymentMethod,
} from "@/lib/api-types"

interface ChannelRechargeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel: Channel | null
}

function openFormInNewTab(action: string, fields: Record<string, string>) {
  const form = document.createElement("form")
  form.method = "POST"
  form.action = action
  form.target = "_blank"
  form.style.display = "none"
  Object.entries(fields).forEach(([key, value]) => {
    const input = document.createElement("input")
    input.type = "hidden"
    input.name = key
    input.value = value
    form.appendChild(input)
  })
  document.body.appendChild(form)
  form.submit()
  document.body.removeChild(form)
}

function paymentMethodLabel(type: string) {
  const map: Record<string, string> = {
    alipay: "支付宝",
    wxpay: "微信",
  }
  return map[type] ?? type
}

export function ChannelRechargeDialog({
  open,
  onOpenChange,
  channel,
}: ChannelRechargeDialogProps) {
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
    if (!open || channelID == null) return
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
        const methods = data.methods ?? []
        const presetAmounts = data.preset_amounts ?? []
        setMethod(methods[0]?.type ?? "")
        if (presetAmounts[0] != null) {
          setAmount(String(presetAmounts[0]))
        } else if (data.min_amount > 0) {
          setAmount(String(data.min_amount))
        }
      })
      .catch((e) => {
        if (cancelled) return
        const err = e as Error
        setError(err.message || "加载充值信息失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, channelID])

  useEffect(() => {
    if (!launch || launch.mode !== "qrcode" || !launch.qr_code || !qrCanvasRef.current) {
      return
    }
    void QRCode.toCanvas(qrCanvasRef.current, launch.qr_code, {
      width: 220,
      margin: 1,
    })
  }, [launch])

  const parsedAmount = Number(amount)
  const selectedMethod = useMemo(
    () => info?.methods?.find((item) => item.type === method) ?? null,
    [info, method],
  )
  const canSubmit = !!info && !!selectedMethod && Number.isFinite(parsedAmount) && parsedAmount > 0

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
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
        onOpenChange(false)
        return
      }
      if (result.mode === "form" && result.form_action && result.form_fields) {
        openFormInNewTab(result.form_action, result.form_fields)
        onOpenChange(false)
        return
      }
      if (result.mode === "qrcode" && result.qr_code) {
        setLaunch(result)
        setLaunchMethod(selectedMethod.type)
        return
      }
      throw new Error("上游返回了不完整的支付结果")
    } catch (e) {
      const err = e as Error
      setError(err.message || "发起充值失败")
    } finally {
      setSubmitting(false)
    }
  }

  function renderRechargeForm() {
    if (loading) {
      return <p className="text-sm text-muted-foreground">加载中…</p>
    }
    return (
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="recharge-amount">{info?.amount_label ?? "充值金额"}</Label>
          <Input
            id="recharge-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={info ? `最低 ${decimal(info.min_amount)}` : "请输入"}
            disabled={submitting}
          />
          {info ? (
            <p className="text-[11px] text-muted-foreground">
              {`最小 ${decimal(info.min_amount)}${info.max_amount > 0 ? `，最大 ${decimal(info.max_amount)}` : ""}`}
            </p>
          ) : null}
        </div>

        {info?.preset_amounts?.length ? (
          <div className="space-y-1.5">
            <Label>快捷金额</Label>
            <div className="flex flex-wrap gap-2">
              {info.preset_amounts.map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={amount === String(value) ? "default" : "outline"}
                  onClick={() => setAmount(String(value))}
                  disabled={submitting}
                >
                  {decimal(value)}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label>支付方式</Label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {info?.methods?.map((item) => (
              <Button
                key={item.type}
                type="button"
                variant={method === item.type ? "default" : "outline"}
                onClick={() => setMethod(item.type)}
                disabled={submitting}
                className="justify-start"
              >
                {item.name}
              </Button>
            ))}
          </div>
        </div>

        {info?.help_text ? (
          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
            {info.help_text}
          </div>
        ) : null}

        {info?.help_image_url ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <img src={info.help_image_url} alt="充值说明" className="max-h-48 w-full object-contain bg-white" />
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={!canSubmit || submitting}>
            {submitting ? "发起中…" : "立即充值"}
          </Button>
        </DialogFooter>
      </form>
    )
  }

  const description = channel
    ? `${channel.name} · ${channelTypeLabel(channel.type)}`
    : "选择充值方式后发起支付。"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>充值</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {launch?.mode === "qrcode" ? (
          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex justify-center">
                <canvas ref={qrCanvasRef} className="rounded bg-white p-2" />
              </div>
              <p className="mt-3 text-center text-sm text-foreground">
                请使用{paymentMethodLabel(launchMethod)}扫码支付
              </p>
              {launch.expires_at ? (
                <p className="mt-1 text-center text-xs text-muted-foreground">
                  过期时间：{dateTime(launch.expires_at)}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setLaunch(null)}>
                返回
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </DialogFooter>
          </div>
        ) : (
          renderRechargeForm()
        )}
      </DialogContent>
    </Dialog>
  )
}
