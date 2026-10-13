"use client"

import { useEffect, useState, type FormEvent } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type { CaptchaConfig, CaptchaProviderType } from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { useTriggerRefresh } from "@/lib/refresh-context"

interface CaptchaFormDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  config?: CaptchaConfig | null
}

// 只支持 YesCaptcha，新建与编辑都固定提交这个类型。
const CAPTCHA_TYPE: CaptchaProviderType = "yescaptcha"

interface FormState {
  name: string
  api_key: string
  endpoint: string
  enabled: boolean
}

function initialState(c?: CaptchaConfig | null): FormState {
  return {
    name: c?.name ?? "",
    api_key: "",
    endpoint: c?.endpoint ?? "",
    enabled: c?.enabled ?? true,
  }
}

export function CaptchaFormDialog({ open, onOpenChange, config }: CaptchaFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialState(config))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useTriggerRefresh()

  useEffect(() => {
    if (open) {
      setForm(initialState(config))
      setError(null)
    }
  }, [open, config])

  const isEdit = !!config

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        type: CAPTCHA_TYPE,
        endpoint: form.endpoint,
        enabled: form.enabled,
      }
      if (form.api_key) body.api_key = form.api_key
      if (isEdit) {
        if (!form.api_key && !config!.id) {
          // shouldn't happen, defensive
          throw new Error("缺少 API Key")
        }
        await apiFetch(`/captcha-configs/${config!.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        })
      } else {
        if (!form.api_key) {
          throw new Error("新建时必须填写 API Key")
        }
        await apiFetch(`/captcha-configs`, {
          method: "POST",
          body: JSON.stringify(body),
        })
      }
      onOpenChange(false)
      refresh()
    } catch (e) {
      const err = e as Error
      setError(err.message || "保存失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑打码平台" : "新增打码平台"}</DialogTitle>
          <DialogDescription>
            上游站点开启 Turnstile 时，会用 YesCaptcha 拿 token。siteKey 由 UpstreamOps 自动从上游公开接口拉，无需手填。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="captcha-name">配置名</Label>
            <Input
              id="captcha-name"
              placeholder="例如：YesCaptcha-主账号"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="captcha-key">
              API Key {isEdit ? <span className="text-xs text-muted-foreground">(留空则不变)</span> : null}
            </Label>
            <Input
              id="captcha-key"
              type="password"
              placeholder="YesCaptcha clientKey"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              required={!isEdit}
              disabled={submitting}
            />
            <p className="text-[11px] text-muted-foreground">{"从打码平台后台获取，加密存储后不会回显。"}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="captcha-endpoint">Endpoint（可选）</Label>
            <Input
              id="captcha-endpoint"
              placeholder="https://api.yescaptcha.com（留空走默认）"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              disabled={submitting}
            />
          </div>

          <div className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">启用</p>
              <p className="text-xs text-muted-foreground">关闭后渠道无法使用此 provider 求解</p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              disabled={submitting}
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
