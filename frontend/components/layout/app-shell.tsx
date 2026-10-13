import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react"
import { Link, Outlet, useLocation } from "react-router-dom"
import { Button, Dropdown, Layout, Nav, SideSheet, Spin, Tag, Tooltip, Typography } from "@douyinfe/semi-ui"
import {
  IconActivity,
  IconBell,
  IconDesktop,
  IconExit,
  IconGithubLogo,
  IconHistory,
  IconHome,
  IconHorn,
  IconLineChartStroked,
  IconMenu,
  IconMoon,
  IconRefresh,
  IconServer,
  IconSetting,
  IconShield,
  IconSun,
} from "@douyinfe/semi-icons"
import { useAuth } from "@/lib/auth-context"
import { relativeTime } from "@/lib/format"
import { useIsMobile } from "@/hooks/use-mobile"
import { useVersionCheck } from "@/hooks/use-version-check"
import { useChannels } from "@/lib/queries"
import { useTriggerRefresh } from "@/lib/refresh-context"
import { setThemeMode, useResolvedTheme, useThemeMode, type ThemeMode } from "@/lib/theme"

const { Sider, Header, Content } = Layout

// 更新日志要渲染 Markdown，体积大，弹窗打开时才加载。
const UpdateNotesModal = lazy(() => import("@/components/monitor/update-notes-modal"))

const REPO_URL = "https://github.com/yreidev/upstream-ops"

const NAV_ITEMS: { itemKey: string; text: string; icon: ReactNode }[] = [
  { itemKey: "/", text: "总览", icon: <IconHome /> },
  { itemKey: "/channels", text: "渠道", icon: <IconServer /> },
  { itemKey: "/rates", text: "倍率变化", icon: <IconLineChartStroked /> },
  { itemKey: "/announcements", text: "上游公告", icon: <IconHorn /> },
  { itemKey: "/notifications", text: "通知", icon: <IconBell /> },
  { itemKey: "/captcha", text: "打码平台", icon: <IconShield /> },
  { itemKey: "/monitor-logs", text: "监控日志", icon: <IconHistory /> },
  { itemKey: "/settings", text: "设置", icon: <IconSetting /> },
]

const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: ReactNode }[] = [
  { mode: "light", label: "亮色", icon: <IconSun /> },
  { mode: "dark", label: "暗色", icon: <IconMoon /> },
  { mode: "system", label: "跟随系统", icon: <IconDesktop /> },
]

/** 当前路由对应的导航项：/channels/xxx 这类子路径也算在 /channels 下。 */
function selectedNavKey(pathname: string): string {
  const hit = NAV_ITEMS.filter((n) => n.itemKey !== "/" && pathname.startsWith(n.itemKey))
  return hit[0]?.itemKey ?? "/"
}

function SideNav({ collapsed, onCollapseChange, onNavigate, title }: {
  collapsed?: boolean
  onCollapseChange?: (collapsed: boolean) => void
  onNavigate?: () => void
  title: string
}) {
  const location = useLocation()
  return (
    <Nav
      style={{ height: "100%" }}
      isCollapsed={collapsed}
      onCollapseChange={onCollapseChange}
      selectedKeys={[selectedNavKey(location.pathname)]}
      items={NAV_ITEMS}
      onClick={() => onNavigate?.()}
      renderWrapper={({ itemElement, props }) => (
        <Link to={String(props.itemKey)} style={{ textDecoration: "none" }}>
          {itemElement}
        </Link>
      )}
      header={{
        logo: <IconActivity style={{ fontSize: 28, color: "var(--semi-color-primary)" }} />,
        text: title,
      }}
      footer={onCollapseChange ? { collapseButton: true } : undefined}
    />
  )
}

export function AppShell() {
  const isMobile = useIsMobile()
  const location = useLocation()
  const { username, authDisabled, logout } = useAuth()
  const refresh = useTriggerRefresh()
  const channels = useChannels()
  const versionCheck = useVersionCheck()
  const themeMode = useThemeMode()
  const resolvedTheme = useResolvedTheme()
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

  // 换页时收起手机上的导航抽屉，并回到页面顶部。
  useEffect(() => {
    setDrawerOpen(false)
    document.querySelector(".app-content")?.scrollTo({ top: 0 })
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

  const themeIcon = resolvedTheme === "dark" ? <IconMoon /> : <IconSun />

  return (
    <Layout style={{ height: "100%" }}>
      {isMobile ? null : (
        <Sider style={{ backgroundColor: "var(--semi-color-bg-1)" }}>
          <SideNav collapsed={collapsed} onCollapseChange={setCollapsed} title={appTitle} />
        </Sider>
      )}
      <Layout style={{ minWidth: 0 }}>
        <Header className="app-header">
          <div className="app-header-left">
            {isMobile ? (
              <Button theme="borderless" icon={<IconMenu />} aria-label="打开导航" onClick={() => setDrawerOpen(true)} />
            ) : null}
            {version ? (
              <Tooltip content="点击检测更新">
                <Button theme="borderless" size="small" loading={versionCheck.checking} onClick={versionCheck.check}>
                  <Typography.Text type="tertiary">v{version}</Typography.Text>
                </Button>
              </Tooltip>
            ) : null}
            {updateAvailable ? (
              <Tag color="green" style={{ cursor: "pointer" }} onClick={versionCheck.openNotes}>
                有新版本 {latestVersion}
              </Tag>
            ) : null}
          </div>
          <div className="app-header-right">
            {isMobile ? null : (
              <Typography.Text type="tertiary" size="small" style={{ marginRight: 4 }}>
                上次采集 {relativeTime(lastCollectedAt)}
              </Typography.Text>
            )}
            <Tooltip
              content={
                <div style={{ maxWidth: 260 }}>
                  重新拉取最新的快照数据。实际采集由后台定时任务执行，要立即采集请到渠道页点“同步”。
                </div>
              }
            >
              <Button theme="borderless" icon={<IconRefresh spin={refreshing} />} aria-label="刷新数据" onClick={handleRefresh} />
            </Tooltip>
            <Dropdown
              position="bottomRight"
              clickToHide
              render={
                <Dropdown.Menu>
                  {THEME_OPTIONS.map((o) => (
                    <Dropdown.Item key={o.mode} icon={o.icon} active={themeMode === o.mode} onClick={() => setThemeMode(o.mode)}>
                      {o.label}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              }
            >
              <Button theme="borderless" icon={themeIcon} aria-label="切换主题" />
            </Dropdown>
            <Tooltip content="GitHub · yreidev/upstream-ops">
              <Button
                theme="borderless"
                icon={<IconGithubLogo />}
                aria-label="GitHub 仓库"
                onClick={() => window.open(REPO_URL, "_blank", "noopener,noreferrer")}
              />
            </Tooltip>
            {authDisabled ? null : (
              <Tooltip content={username ? `${username} · 退出登录` : "退出登录"}>
                <Button theme="borderless" icon={<IconExit />} aria-label="退出登录" onClick={logout} />
              </Tooltip>
            )}
          </div>
        </Header>
        <Content className="app-content">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </Content>
      </Layout>

      {isMobile ? (
        <SideSheet
          visible={drawerOpen}
          onCancel={() => setDrawerOpen(false)}
          placement="left"
          width={240}
          title={null}
          closable={false}
          bodyStyle={{ padding: 0 }}
        >
          <SideNav title={appTitle} onNavigate={() => setDrawerOpen(false)} />
        </SideSheet>
      ) : null}

      {versionCheck.notesOpen ? (
        <Suspense fallback={null}>
          <UpdateNotesModal visible onClose={versionCheck.closeNotes} version={versionCheck.version} />
        </Suspense>
      ) : null}
    </Layout>
  )
}

export function PageLoading() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
      <Spin size="large" />
    </div>
  )
}
