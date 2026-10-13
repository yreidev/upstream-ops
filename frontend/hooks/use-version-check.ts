import { useEffect, useState } from "react"
import { Toast } from "@douyinfe/semi-ui"
import { apiFetch } from "@/lib/api"
import type { AppVersion } from "@/lib/api-types"
import { useAppVersion } from "@/lib/queries"

// 顶栏和设置页各有一份版本信息；任何一处重新取到（检测更新、保存设置改了标题）都同步给其它几处
const subscribers = new Set<(v: AppVersion) => void>()

function publish(v: AppVersion) {
  subscribers.forEach((fn) => fn(v))
}

/**
 * 版本信息和“检测更新”。检测到新版本时打开更新日志弹窗（notesOpen），否则提示已是最新。
 * 顶栏和设置页都用它，首次加载共用 /version 的缓存，之后的更新互相同步。
 */
export function useVersionCheck() {
  const appVersion = useAppVersion()
  const [checking, setChecking] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)

  const { setData } = appVersion
  useEffect(() => {
    subscribers.add(setData)
    return () => {
      subscribers.delete(setData)
    }
  }, [setData])

  async function check() {
    setChecking(true)
    try {
      const result = await apiFetch<AppVersion>("/version")
      publish(result)
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

  /** 静默重新取一次，比如保存设置改了标题之后；失败就等下次打开页面 */
  async function reload() {
    try {
      publish(await apiFetch<AppVersion>("/version"))
    } catch {
      // 忽略
    }
  }

  return {
    version: appVersion.data,
    checking,
    check,
    reload,
    notesOpen,
    openNotes: () => setNotesOpen(true),
    closeNotes: () => setNotesOpen(false),
  }
}
