import { lazy, Suspense, type ReactNode } from "react"
import { Spin } from "@douyinfe/semi-ui"
import { useAuth } from "@/lib/auth-context"

// 登录页用了 Semi Form，Form 会连带打包日期、上传等全部表单控件，单独拆出去，入口包不背这些。
const LoginPage = lazy(() => import("@/components/auth/login-page").then((m) => ({ default: m.LoginPage })))

function FullScreenLoading() {
  return (
    <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center" }}>
      <Spin size="large" />
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
