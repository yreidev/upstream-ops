import { useEffect, useState } from "react"
import { Banner, Button, Card, Form, Typography } from "@douyinfe/semi-ui"
import { IconActivity } from "@douyinfe/semi-icons"
import type { ApiError } from "@/lib/api"
import { useAuth } from "@/lib/auth-context"
import { useAppVersion } from "@/lib/queries"

export function LoginPage() {
  const { login } = useAuth()
  const appVersion = useAppVersion()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const appTitle = appVersion.data?.title?.trim() || "UpstreamOps"

  useEffect(() => {
    document.title = appTitle
  }, [appTitle])

  async function handleSubmit(values: { username: string; password: string }) {
    setError(null)
    setSubmitting(true)
    try {
      await login(values.username.trim(), values.password)
    } catch (err) {
      const e = err as ApiError
      setError(e.status === 401 ? "账号或密码错误" : e.message || "登录失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100%",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "var(--semi-color-bg-0)",
      }}
    >
      <Card style={{ width: "100%", maxWidth: 380 }} bodyStyle={{ padding: 28 }}>
        <div className="row" style={{ gap: 10, marginBottom: 4 }}>
          <IconActivity style={{ fontSize: 28, color: "var(--semi-color-primary)" }} />
          <Typography.Title heading={3} style={{ margin: 0 }}>
            {appTitle}
          </Typography.Title>
        </div>
        <Typography.Text type="tertiary">登录后台，监控渠道余额和倍率。</Typography.Text>
        <Form<{ username: string; password: string }> onSubmit={handleSubmit} style={{ marginTop: 16 }} disabled={submitting}>
          <Form.Input
            field="username"
            label="账号"
            autoComplete="username"
            rules={[{ required: true, message: "请输入账号" }]}
          />
          <Form.Input
            field="password"
            label="密码"
            mode="password"
            autoComplete="current-password"
            rules={[{ required: true, message: "请输入密码" }]}
          />
          {error ? <Banner fullMode={false} type="danger" description={error} closeIcon={null} style={{ marginTop: 8 }} /> : null}
          <Button htmlType="submit" theme="solid" type="primary" block loading={submitting} style={{ marginTop: 16 }}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  )
}
