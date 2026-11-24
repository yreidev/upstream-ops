import { useEffect, useState, type FormEvent } from "react"
import { Alert, Button, Description, Input, Label, Modal, Spinner, Surface, Switch, TextField } from "@heroui/react"
import type { CaptchaConfig, CaptchaProviderType } from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { PasswordInput } from "@/components/common/password-input"

// 只支持 YesCaptcha，新建与编辑都固定提交这个类型。
const CAPTCHA_TYPE: CaptchaProviderType = "yescaptcha"

/** 新增或编辑打码配置。config 为空时是新增。 */
export function CaptchaFormModal({
  visible,
  onClose,
  config,
}: {
  visible: boolean
  onClose: () => void
  config?: CaptchaConfig | null
}) {
  const [name, setName] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [enabled, setEnabled] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useTriggerRefresh()
  const isEdit = !!config

  useEffect(() => {
    if (visible) {
      setName(config?.name ?? "")
      setApiKey("")
      setEndpoint(config?.endpoint ?? "")
      setEnabled(config?.enabled ?? true)
      setError(null)
    }
  }, [visible, config])

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (!name.trim()) {
      setError("请填写配置名")
      return
    }
    if (!isEdit && !apiKey.trim()) {
      setError("新建时必须填写 API Key")
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        type: CAPTCHA_TYPE,
        endpoint: endpoint.trim(),
        enabled,
      }
      if (apiKey) body.api_key = apiKey
      if (isEdit) {
        await apiFetch(`/captcha-configs/${config!.id}`, { method: "PUT", body: JSON.stringify(body) })
      } else {
        await apiFetch(`/captcha-configs`, { method: "POST", body: JSON.stringify(body) })
      }
      onClose()
      refresh()
    } catch (err) {
      setError((err as Error).message || "保存失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal.Backdrop
      isOpen={visible}
      isDismissable={!submitting}
      isKeyboardDismissDisabled={submitting}
      onOpenChange={(open) => !open && !submitting && onClose()}
    >
      <Modal.Container size="md">
        <Modal.Dialog className="max-w-[500px]">
          <Modal.CloseTrigger isDisabled={submitting} />
          <Modal.Header>
            <Modal.Heading>{isEdit ? "编辑打码平台" : "新增打码平台"}</Modal.Heading>
          </Modal.Header>
          <form onSubmit={handleSubmit}>
            <Modal.Body>
              <div className="stack gap-3.5">
                <Alert status="accent">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>
                      上游站点开启 Turnstile 时，会用 YesCaptcha 拿 token。siteKey 由 UpstreamOps 自动从上游公开接口获取，不用手填。
                    </Alert.Description>
                  </Alert.Content>
                </Alert>

                <TextField variant="secondary" value={name} onChange={setName} isRequired isDisabled={submitting} fullWidth>
                  <Label>配置名</Label>
                  <Input placeholder="例如：YesCaptcha-主账号" />
                </TextField>

                <TextField variant="secondary" value={apiKey} onChange={setApiKey} isRequired={!isEdit} isDisabled={submitting} fullWidth>
                  <Label>{isEdit ? "API Key（留空则不变）" : "API Key"}</Label>
                  <PasswordInput variant="secondary" placeholder="YesCaptcha clientKey" fullWidth />
                  <Description>从打码平台后台获取，加密存储后不会回显。</Description>
                </TextField>

                <TextField variant="secondary" value={endpoint} onChange={setEndpoint} isDisabled={submitting} fullWidth>
                  <Label>Endpoint（可选）</Label>
                  <Input placeholder="https://api.yescaptcha.com（留空走默认）" />
                </TextField>

                <Surface variant="secondary" className="rounded-xl p-3">
                  <Switch
                    isSelected={enabled}
                    onChange={setEnabled}
                    isDisabled={submitting}
                    className="w-full justify-between"
                  >
                    <Switch.Content className="w-full justify-between">
                      <div className="stack gap-0.5">
                        <Label className="text-sm font-medium">启用</Label>
                        <Description className="text-xs">关闭后渠道无法使用此配置过验证码</Description>
                      </div>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Content>
                  </Switch>
                </Surface>

                {error ? (
                  <Alert status="danger">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={submitting} onPress={onClose}>
                取消
              </Button>
              <Button type="submit" variant="primary" isPending={submitting}>
                {submitting ? <Spinner size="sm" color="current" /> : null}
                保存
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
