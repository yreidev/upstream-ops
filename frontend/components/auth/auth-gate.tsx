import { lazy, Suspense, type ReactNode } from "react"
import { Spinner } from "@heroui/react"
import { useAuth } from "@/lib/auth-context"

const LoginPage = lazy(() => import("@/components/auth/login-page").then((m) => ({ default: m.LoginPage })))

function FullScreenLoading() {
  return (
    <div className="flex h-full items-center justify-center bg-background">
      <Spinner size="lg" />
    </div>
  )
}

/**
 * AuthGate 按登录状态决定渲染什么：
 *   loading       正在向后端确认登录状态，显示加载中
 *   anonymous     未登录，显示登录页
 *   authenticated 已登录，显示业务页面
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth()

  if (status === "loading") {
    return <FullScreenLoading />
  }
  if (status === "anonymous") {
    return (
      <Suspense fallback={<FullScreenLoading />}>
        <LoginPage />
      </Suspense>
    )
  }
  return <>{children}</>
}
