import { useSyncExternalStore } from "react"

/**
 * 亮色 / 暗色主题。Semi 靠 body 上的 theme-mode="dark" 切换暗色，图表（VChart Semi 主题）也监听这个属性。
 *
 * 选择存在 localStorage 的 "theme" 键里，取值 light / dark / system，和改版前 next-themes 用的键、取值相同，
 * 升级后沿用用户之前的选择。index.html 里有一段同样逻辑的内联脚本，在 React 渲染前先设好，避免闪一下亮色。
 */
export type ThemeMode = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

const STORAGE_KEY = "theme"
const DEFAULT_MODE: ThemeMode = "light"
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)")
const listeners = new Set<() => void>()

function readMode(): ThemeMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === "light" || v === "dark" || v === "system") return v
  } catch {
    // localStorage 不可用（隐私模式等）时用默认值
  }
  return DEFAULT_MODE
}

let mode = readMode()

function resolve(m: ThemeMode): ResolvedTheme {
  if (m === "system") return darkQuery.matches ? "dark" : "light"
  return m
}

function apply() {
  if (resolve(mode) === "dark") document.body.setAttribute("theme-mode", "dark")
  else document.body.removeAttribute("theme-mode")
}

function emit() {
  apply()
  for (const fn of listeners) fn()
}

darkQuery.addEventListener("change", () => {
  if (mode === "system") emit()
})

apply()

export function setThemeMode(next: ThemeMode) {
  mode = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 存不下就只在本次会话生效
  }
  emit()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 当前选择的模式（含“跟随系统”）。 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, () => mode)
}

/** 实际生效的亮色或暗色。 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => resolve(mode))
}
