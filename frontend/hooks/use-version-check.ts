import { useState } from "react"
import { Toast } from "@douyinfe/semi-ui"
import { apiFetch } from "@/lib/api"
import type { AppVersion } from "@/lib/api-types"
import { useAppVersion } from "@/lib/queries"

/**
 * 版本信息和“检测更新”。检测到新版本时打开更新日志弹窗（notesOpen），否则提示已是最新。
 * 顶栏和设置页都用它，两处共用 /version 的缓存。
 */
export function useVersionCheck() {
  const appVersion = useAppVersion()
  const [checking, setChecking] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)

  async function check() {
    setChecking(true)
    try {
      const result = await apiFetch<AppVersion>("/version")
      appVersion.setData(result)
      if (result.update_error) {
        Toast.error(result.update_error)
      } else if (result.update_available && result.latest_version) {
        setNotesOpen(true)
      } else {
        Toast.success("当前已是最新版本")
      }
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "检测更新失败")
    } finally {
      setChecking(false)
    }
  }

  return {
    version: appVersion.data,
    checking,
    check,
    notesOpen,
    openNotes: () => setNotesOpen(true),
    closeNotes: () => setNotesOpen(false),
  }
}
