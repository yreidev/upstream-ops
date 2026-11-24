import type { ReactNode } from "react"

export interface ConfirmOptions {
  title: string
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export interface ConfirmRequest {
  options: ConfirmOptions
  resolve: (confirmed: boolean) => void
}

let currentRequest: ConfirmRequest | null = null
const queue: ConfirmRequest[] = []
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((fn) => fn())
}

/**
 * confirm 弹出确认框，用户点确认时得到 true，取消或关闭时得到 false。
 *
 *   if (await confirm({ title: "删除？", destructive: true })) doStuff()
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const req: ConfirmRequest = { options: opts, resolve }
    if (!currentRequest) {
      currentRequest = req
      emit()
    } else {
      queue.push(req)
    }
  })
}

export function getConfirmSnapshot(): ConfirmRequest | null {
  return currentRequest
}

export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function settleConfirm(confirmed: boolean) {
  const req = currentRequest
  currentRequest = queue.shift() ?? null
  emit()
  req?.resolve(confirmed)
}
