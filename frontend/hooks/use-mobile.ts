import { useSyncExternalStore } from "react"

// 与 Tailwind / HeroUI 的 md 断点一致：小于 768px 按手机布局。
const query = window.matchMedia("(max-width: 767px)")

function subscribe(fn: () => void) {
  query.addEventListener("change", fn)
  return () => query.removeEventListener("change", fn)
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, () => query.matches)
}
