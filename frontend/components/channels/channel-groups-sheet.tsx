import { Drawer } from "@heroui/react"
import type { Channel } from "@/lib/api-types"
import { channelTypeLabel } from "@/lib/format"
import { ChannelRatesTable, type APIKeyAction } from "@/components/channels/channel-parts"

/** 单个渠道的分组倍率，从渠道行尾的“分组”按钮打开。 */
export function ChannelGroupsSheet({
  channel,
  onClose,
  onAPIKeyAction,
}: {
  channel: Channel | null
  onClose: () => void
  onAPIKeyAction: APIKeyAction
}) {
  return (
    <Drawer.Backdrop isOpen={channel != null} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className="w-full max-w-[720px] sm:w-[720px]">
          <Drawer.CloseTrigger />
          <Drawer.Header className="flex flex-col items-start gap-0.5">
            <Drawer.Heading>分组倍率</Drawer.Heading>
            {channel ? (
              <span className="text-xs font-normal text-muted">
                {channel.name} · {channelTypeLabel(channel.type)}
                {channel.only_created_key_groups_enabled ? " · 只看已建密钥的分组" : ""}
              </span>
            ) : null}
          </Drawer.Header>
          <Drawer.Body className="pb-4">
            {channel ? <ChannelRatesTable channel={channel} onAPIKeyAction={onAPIKeyAction} /> : null}
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  )
}
