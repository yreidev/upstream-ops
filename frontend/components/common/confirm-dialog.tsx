import { useState, useSyncExternalStore } from "react"
import { AlertDialog, Button } from "@heroui/react"
import { getConfirmSnapshot, settleConfirm, subscribeConfirm, type ConfirmOptions } from "@/lib/confirm"

/** 全局确认弹窗容器：在应用根节点挂载一次，承接 lib/confirm.ts 的 Promise 调用。 */
export function ConfirmDialog() {
  const request = useSyncExternalStore(subscribeConfirm, getConfirmSnapshot, getConfirmSnapshot)
  // 退出动画期间 request 已为 null，保留最近一次文案避免弹窗淡出瞬间文字闪烁消失。
  const [cachedOpts, setCachedOpts] = useState<ConfirmOptions | undefined>(undefined)
  if (request && request.options !== cachedOpts) {
    setCachedOpts(request.options)
  }
  const opts = request?.options ?? cachedOpts

  return (
    <AlertDialog.Backdrop
      isOpen={Boolean(request)}
      onOpenChange={(open) => {
        if (!open) settleConfirm(false)
      }}
      isDismissable
      isKeyboardDismissDisabled={false}
    >
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog>
          <AlertDialog.CloseTrigger />
          <AlertDialog.Header>
            <AlertDialog.Icon status={opts?.destructive ? "danger" : "accent"} />
            <AlertDialog.Heading>{opts?.title}</AlertDialog.Heading>
          </AlertDialog.Header>
          {opts?.description ? (
            <AlertDialog.Body>
              <div className="text-sm text-muted">{opts.description}</div>
            </AlertDialog.Body>
          ) : null}
          <AlertDialog.Footer>
            <Button variant="tertiary" onPress={() => settleConfirm(false)}>
              {opts?.cancelLabel ?? "取消"}
            </Button>
            <Button
              variant={opts?.destructive ? "danger" : "primary"}
              onPress={() => settleConfirm(true)}
            >
              {opts?.confirmLabel ?? "确认"}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )
}
