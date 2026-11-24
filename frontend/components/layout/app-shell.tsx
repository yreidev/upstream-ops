import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react"
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom"
import { Button, Chip, Drawer, ScrollShadow, Separator, Spinner, Tooltip } from "@heroui/react"
import {
  ArrowRightFromSquare,
  ArrowsRotateRight,
  Bars,
  Bell,
  ChartLine,
  Clock,
  ClockArrowRotateLeft,
  Gear,
  House,
  LayoutSideContentLeft,
  LogoGithub,
  Megaphone,
  Pulse,
  Server,
  Shield,
} from "@gravity-ui/icons"
import { useAuth } from "@/lib/auth-context"
import { relativeTime } from "@/lib/format"
import { useIsMobile } from "@/hooks/use-mobile"
import { useVersionCheck } from "@/hooks/use-version-check"
import { useChannels } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"

// 更新日志要渲染 Markdown，体积大，弹窗打开时才加载。
const UpdateNotesModal = lazy(() => import("@/components/monitor/update-notes-modal"))

const REPO_URL = "https://github.com/yreidev/upstream-ops"

interface NavItem {
  itemKey: string
  text: string
  icon: ReactNode
}

const PRIMARY_NAV_ITEMS: NavItem[] = [
  { itemKey: "/", text: "总览", icon: <House className="size-4 shrink-0" /> },
  { itemKey: "/channels", text: "渠道", icon: <Server className="size-4 shrink-0" /> },
  { itemKey: "/rates", text: "倍率变化", icon: <ChartLine className="size-4 shrink-0" /> },
  { itemKey: "/announcements", text: "上游公告", icon: <Megaphone className="size-4 shrink-0" /> },
  { itemKey: "/notifications", text: "通知", icon: <Bell className="size-4 shrink-0" /> },
  { itemKey: "/captcha", text: "打码平台", icon: <Shield className="size-4 shrink-0" /> },
]

const SYSTEM_NAV_ITEMS: NavItem[] = [
  { itemKey: "/jobs", text: "后台任务", icon: <Clock className="size-4 shrink-0" /> },
  { itemKey: "/monitor-logs", text: "监控日志", icon: <ClockArrowRotateLeft className="size-4 shrink-0" /> },
  { itemKey: "/settings", text: "设置", icon: <Gear className="size-4 shrink-0" /> },
]

const ALL_NAV_ITEMS = [...PRIMARY_NAV_ITEMS, ...SYSTEM_NAV_ITEMS]

/** 当前路由对应的导航项：/channels/xxx 这类子路径也算在 /channels 下。 */
function selectedNavKey(pathname: string): string {
  const hit = ALL_NAV_ITEMS.filter((n) => n.itemKey !== "/" && pathname.startsWith(n.itemKey))
  return hit[0]?.itemKey ?? "/"
}

function SidebarNavGroup({
  label,
  items,
  activeKey,
  collapsed,
  onNavigate,
}: {
  label: string
  items: NavItem[]
  activeKey: string
  collapsed: boolean
  onNavigate?: () => void
}) {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col gap-0.5">
      {!collapsed ? (
        <span className="select-none px-2.5 py-1.5 text-[11px] font-medium tracking-wider text-muted uppercase">
          {label}
        </span>
      ) : null}
      {items.map((item) => {
        const active = item.itemKey === activeKey
        if (collapsed) {
          return (
            <Tooltip key={item.itemKey}>
              <Button
                isIconOnly
                variant="ghost"
                size="sm"
                aria-label={item.text}
                aria-current={active ? "page" : undefined}
                onPress={() => {
                  navigate(item.itemKey)
                  onNavigate?.()
                }}
                className={`h-9 w-full rounded-2xl ${
                  active
                    ? "bg-default text-foreground"
                    : "text-muted hover:bg-default/65 hover:text-foreground"
                }`}
              >
                {item.icon}
              </Button>
              <Tooltip.Content placement="right">{item.text}</Tooltip.Content>
            </Tooltip>
          )
        }

        return (
          <Link
            key={item.itemKey}
            to={item.itemKey}
            onClick={() => onNavigate?.()}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-9 items-center gap-3 rounded-2xl px-2.5 py-1.5 text-sm no-underline transition-colors ${
              active
                ? "bg-default font-medium text-foreground"
                : "text-muted hover:bg-default/65 hover:text-foreground"
            }`}
          >
            <span className={active ? "text-foreground" : "text-muted"}>{item.icon}</span>
            <span className="truncate">{item.text}</span>
          </Link>
        )
      })}
    </div>
  )
}

function SideNav({
  collapsed = false,
  onNavigate,
  title,
  version,
}: {
  collapsed?: boolean
  onNavigate?: () => void
  title: string
  version?: string
}) {
  const location = useLocation()
  const activeKey = selectedNavKey(location.pathname)

  return (
    <div className="flex h-full flex-col bg-background">
      <div
        className={`flex h-14 shrink-0 items-center ${
          collapsed ? "justify-center px-2" : "gap-2.5 px-4"
        }`}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground shadow-xs">
          <Pulse className="size-4" />
        </div>
        {!collapsed ? (
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm leading-tight font-semibold tracking-tight text-foreground">
              {title}
            </span>
            {version ? <span className="num text-[11px] leading-tight text-muted">v{version}</span> : null}
          </div>
        ) : null}
      </div>

      <ScrollShadow className={`flex flex-1 flex-col gap-3 py-2 ${collapsed ? "px-1.5" : "px-3"}`}>
        <nav aria-label="主导航" className="flex flex-col gap-3">
          <SidebarNavGroup
            label="监控"
            items={PRIMARY_NAV_ITEMS}
            activeKey={activeKey}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
          {collapsed ? <Separator className="my-1" /> : null}
          <SidebarNavGroup
            label="运维与系统"
            items={SYSTEM_NAV_ITEMS}
            activeKey={activeKey}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </nav>
      </ScrollShadow>
    </div>
  )
}

export function AppShell() {
  const isMobile = useIsMobile()
  const location = useLocation()
  const { username, authDisabled, logout } = useAuth()
  const refresh = useTriggerRefresh()
  const channels = useChannels()
  const versionCheck = useVersionCheck()
  const [collapsed, setCollapsed] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const appTitle = versionCheck.version?.title?.trim() || "UpstreamOps"
  const version = versionCheck.version?.version?.trim()
  const latestVersion = versionCheck.version?.latest_version?.trim()
  const updateAvailable = Boolean(versionCheck.version?.update_available && latestVersion)

  useEffect(() => {
    document.title = appTitle
  }, [appTitle])

  // 换页时收起手机上的导航抽屉，并回到页面顶部。桌面滚的是内容区，手机滚的是整个页面，两个都归零。
  useEffect(() => {
    setDrawerOpen(false)
    document.querySelector(".app-content")?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [location.pathname])

  // “上次采集”取所有渠道里最近的一次余额采集时间，说明页面上的数据有多新。
  const lastCollectedAt = useMemo(() => {
    let best: string | null = null
    let bestT = -Infinity
    for (const c of channels.data ?? []) {
      if (!c.last_balance_at) continue
      const t = new Date(c.last_balance_at).getTime()
      if (Number.isFinite(t) && t > bestT) {
        bestT = t
        best = c.last_balance_at
      }
    }
    return best
  }, [channels.data])

  function handleRefresh() {
    setRefreshing(true)
    refresh()
    setTimeout(() => setRefreshing(false), 800)
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      {!isMobile ? (
        <aside
          className={`h-full shrink-0 shadow-[inset_-1px_0_0_rgba(0,0,0,0.07)] transition-[width] duration-200 ${
            collapsed ? "w-14" : "w-60"
          }`}
        >
          <SideNav collapsed={collapsed} title={appTitle} version={version} />
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="app-header">
          <div className="app-header-left">
            {isMobile ? (
              <Button
                isIconOnly
                variant="tertiary"
                size="sm"
                aria-label="打开导航"
                onPress={() => setDrawerOpen(true)}
              >
                <Bars className="size-4" />
              </Button>
            ) : (
              <Tooltip>
                <Button
                  isIconOnly
                  variant="ghost"
                  size="sm"
                  aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
                  onPress={() => setCollapsed((v) => !v)}
                >
                  <LayoutSideContentLeft className="size-4 text-muted" />
                </Button>
                <Tooltip.Content>{collapsed ? "展开侧边栏" : "收起侧边栏"}</Tooltip.Content>
              </Tooltip>
            )}
            {version ? (
              <Tooltip>
                <Button
                  variant="ghost"
                  size="sm"
                  isPending={versionCheck.checking}
                  onPress={versionCheck.check}
                  className="text-muted"
                >
                  {versionCheck.checking ? <Spinner size="sm" color="current" /> : null}
                  <span className="num text-xs">v{version}</span>
                </Button>
                <Tooltip.Content>点击检测更新</Tooltip.Content>
              </Tooltip>
            ) : null}
            {updateAvailable ? (
              <Button variant="ghost" size="sm" className="h-auto p-0" onPress={versionCheck.openNotes}>
                <Chip color="success" variant="soft" size="sm">
                  有新版本 {latestVersion}
                </Chip>
              </Button>
            ) : null}
          </div>

          <div className="app-header-right">
            {!isMobile ? (
              <span className="mr-1 text-xs text-muted">上次采集 {relativeTime(lastCollectedAt)}</span>
            ) : null}
            <Tooltip>
              <Button
                isIconOnly
                variant="tertiary"
                size="sm"
                aria-label="刷新数据"
                onPress={handleRefresh}
              >
                <ArrowsRotateRight className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
              </Button>
              <Tooltip.Content className="max-w-[260px]">
                重新拉取最新的快照数据。实际采集由后台定时任务执行，要立即采集请到渠道页点“同步”。
              </Tooltip.Content>
            </Tooltip>

            <Tooltip>
              <Button
                isIconOnly
                variant="tertiary"
                size="sm"
                aria-label="GitHub 仓库"
                onPress={() => window.open(REPO_URL, "_blank", "noopener,noreferrer")}
              >
                <LogoGithub className="size-4" />
              </Button>
              <Tooltip.Content>GitHub · yreidev/upstream-ops</Tooltip.Content>
            </Tooltip>

            {!authDisabled ? (
              <Tooltip>
                <Button
                  isIconOnly
                  variant="tertiary"
                  size="sm"
                  aria-label="退出登录"
                  onPress={logout}
                >
                  <ArrowRightFromSquare className="size-4" />
                </Button>
                <Tooltip.Content>{username ? `${username} · 退出登录` : "退出登录"}</Tooltip.Content>
              </Tooltip>
            ) : null}
          </div>
        </header>

        <main className="app-content">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {isMobile ? (
        <Drawer.Backdrop isOpen={drawerOpen} onOpenChange={setDrawerOpen}>
          <Drawer.Content placement="left">
            <Drawer.Dialog className="w-[260px] max-w-[260px] bg-background p-0 sm:w-[260px]" aria-label="主导航菜单">
              <SideNav title={appTitle} version={version} onNavigate={() => setDrawerOpen(false)} />
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      ) : null}

      {versionCheck.notesOpen ? (
        <Suspense fallback={null}>
          <UpdateNotesModal visible onClose={versionCheck.closeNotes} version={versionCheck.version} />
        </Suspense>
      ) : null}
    </div>
  )
}

export function PageLoading() {
  return (
    <div className="flex justify-center py-20">
      <Spinner size="lg" />
    </div>
  )
}
