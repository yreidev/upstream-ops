import { useRef, useState } from "react"
import { Banner, Form, Modal } from "@douyinfe/semi-ui"
import type { FormApi } from "@douyinfe/semi-ui/lib/es/form"
import type { CaptchaConfig, CaptchaProviderType } from "@/lib/api-types"
import { apiFetch } from "@/lib/api"
import { useTriggerRefresh } from "@/lib/refresh-context"

// 只支持 YesCaptcha，新建与编辑都固定提交这个类型。
const CAPTCHA_TYPE: CaptchaProviderType = "yescaptcha"

interface FormValues {
  name: string
  api_key: string
  endpoint: string
  enabled: boolean
}

/** 新增或编辑打码配置。config 为空时是新增。 */
export function CaptchaFormModal({ visible, onClose, config }: {
  visible: boolean
  onClose: () => void
  config?: CaptchaConfig | null
}) {
  const formApi = useRef<FormApi<FormValues> | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useTriggerRefresh()
  const isEdit = !!config

  async function handleOk() {
    let values: FormValues
    try {
      values = await formApi.current!.validate()
    } catch {
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        name: values.name,
        type: CAPTCHA_TYPE,
        endpoint: values.endpoint ?? "",
        enabled: values.enabled,
      }
      if (values.api_key) body.api_key = values.api_key
      if (isEdit) {
        await apiFetch(`/captcha-configs/${config!.id}`, { method: "PUT", body: JSON.stringify(body) })
      } else {
        await apiFetch(`/captcha-configs`, { method: "POST", body: JSON.stringify(body) })
      }
      onClose()
      refresh()
    } catch (e) {
      setError((e as Error).message || "保存失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      visible={visible}
      title={isEdit ? "编辑打码平台" : "新增打码平台"}
      onCancel={onClose}
      onOk={handleOk}
      okText="保存"
      confirmLoading={submitting}
      afterClose={() => setError(null)}
    >
      <Banner
        fullMode={false}
        type="info"
        closeIcon={null}
        description="上游站点开启 Turnstile 时，会用 YesCaptcha 拿 token。siteKey 由 UpstreamOps 自动从上游公开接口获取，不用手填。"
        style={{ marginBottom: 12 }}
      />
      {visible ? (
        <Form<FormValues>
          getFormApi={(api) => (formApi.current = api)}
          initValues={{
            name: config?.name ?? "",
            api_key: "",
            endpoint: config?.endpoint ?? "",
            enabled: config?.enabled ?? true,
          }}
          disabled={submitting}
        >
          <Form.Input field="name" label="配置名" placeholder="例如：YesCaptcha-主账号" rules={[{ required: true, message: "请填写配置名" }]} />
          <Form.Input
            field="api_key"
            label={isEdit ? "API Key（留空则不变）" : "API Key"}
            mode="password"
            placeholder="YesCaptcha clientKey"
            extraText="从打码平台后台获取，加密存储后不会回显。"
            rules={isEdit ? [] : [{ required: true, message: "新建时必须填写 API Key" }]}
          />
          <Form.Input field="endpoint" label="Endpoint（可选）" placeholder="https://api.yescaptcha.com（留空走默认）" />
          <Form.Switch field="enabled" label="启用" extraText="关闭后渠道无法使用此配置过验证码" />
        </Form>
      ) : null}
      {error ? <Banner fullMode={false} type="danger" closeIcon={null} description={error} style={{ marginTop: 12 }} /> : null}
    </Modal>
  )
}
