// React 19 要在任何 Semi 组件之前引入适配层（见 Semi 文档「React 19 适配」）。
import '@douyinfe/semi-ui/react19-adapter'
import { lazy, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { LocaleProvider } from '@douyinfe/semi-ui'
import zh_CN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN'
import '@/lib/theme'
import { AuthProvider } from '@/lib/auth-context'
import { RefreshProvider } from '@/lib/refresh-context'
import { AuthGate } from '@/components/auth/auth-gate'
import { AppShell } from '@/components/layout/app-shell'
import '@/app/globals.css'

// 每页单独打包，打开时才加载；图表库只有总览页用到。
const DashboardPage = lazy(() => import('@/app/dashboard-page'))
const ChannelsPage = lazy(() => import('@/app/channels-page'))
const RatesPage = lazy(() => import('@/app/rates-page'))
const AnnouncementsPage = lazy(() => import('@/app/announcements-page'))
const NotificationsPage = lazy(() => import('@/app/notifications-page'))
const CaptchaPage = lazy(() => import('@/app/captcha-page'))
const MonitorLogsPage = lazy(() => import('@/app/monitor-logs-page'))
const SettingsPage = lazy(() => import('@/app/settings-page'))
const NotFoundPage = lazy(() => import('@/app/not-found-page'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider locale={zh_CN}>
      <AuthProvider>
        <AuthGate>
          <RefreshProvider>
            <BrowserRouter>
              <Routes>
                <Route element={<AppShell />}>
                  <Route index element={<DashboardPage />} />
                  <Route path="channels" element={<ChannelsPage />} />
                  <Route path="rates" element={<RatesPage />} />
                  <Route path="announcements" element={<AnnouncementsPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                  <Route path="captcha" element={<CaptchaPage />} />
                  <Route path="monitor-logs" element={<MonitorLogsPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </RefreshProvider>
        </AuthGate>
      </AuthProvider>
    </LocaleProvider>
  </StrictMode>,
)
