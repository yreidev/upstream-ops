import { useEffect, useState, type FormEvent } from "react"
import { Alert, Button, Card, Input, Label, Spinner, TextField } from "@heroui/react"
import { Pulse } from "@gravity-ui/icons"
import type { ApiError } from "@/lib/api"
import { useAuth } from "@/lib/auth-context"
import { useAppVersion } from "@/lib/queries"
import { PasswordInput } from "@/components/common/password-input"

export function LoginPage() {
  const { login } = useAuth()
  const appVersion = useAppVersion()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const appTitle = appVersion.data?.title?.trim() || "UpstreamOps"

  useEffect(() => {
    document.title = appTitle
  }, [appTitle])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!username.trim()) {
      setError("请输入账号")
      return
    }
    if (!password) {
      setError("请输入密码")
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      await login(username.trim(), password)
    } catch (err) {
      const apiErr = err as ApiError
      setError(apiErr.status === 401 ? "账号或密码错误" : apiErr.message || "登录失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-[380px] p-6">
        <Card.Header className="gap-1.5 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-foreground shadow-xs">
              <Pulse className="size-5" />
            </div>
            <Card.Title className="text-xl font-semibold tracking-tight">{appTitle}</Card.Title>
          </div>
          <Card.Description>登录后台，监控渠道余额和倍率。</Card.Description>
        </Card.Header>
        <Card.Content>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <TextField
              variant="secondary"
              value={username}
              onChange={setUsername}
              isRequired
              isDisabled={submitting}
              fullWidth
            >
              <Label>账号</Label>
              <Input autoComplete="username" placeholder="请输入账号" />
            </TextField>
            <TextField
              variant="secondary"
              value={password}
              onChange={setPassword}
              isRequired
              isDisabled={submitting}
              fullWidth
            >
              <Label>密码</Label>
              <PasswordInput variant="secondary" autoComplete="current-password" placeholder="请输入密码" fullWidth />
            </TextField>
            {error ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{error}</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            <Button type="submit" variant="primary" fullWidth isPending={submitting} className="mt-1">
              {submitting ? <Spinner size="sm" color="current" /> : null}
              登录
            </Button>
          </form>
        </Card.Content>
      </Card>
    </div>
  )
}
