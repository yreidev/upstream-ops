import { Modal } from "@douyinfe/semi-ui"
import type { ReactNode } from "react"

export interface ConfirmOptions {
  title: string
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

/**
 * confirm 弹出确认框，用户点确认时得到 true，取消或关闭时得到 false。
 *
 *   if (await confirm({ title: "删除？", destructive: true })) doStuff()
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: opts.title,
      content: opts.description,
      okText: opts.confirmLabel ?? "确认",
      cancelText: opts.cancelLabel ?? "取消",
      okButtonProps: opts.destructive ? { type: "danger" } : undefined,
      // 密钥抽屉的层级是 1010，确认框要盖在它上面
      zIndex: 1050,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}
