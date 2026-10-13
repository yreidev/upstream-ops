import { SideSheet, Typography } from "@douyinfe/semi-ui"
import type { Channel } from "@/lib/api-types"
import { channelTypeLabel } from "@/lib/format"
import { useIsMobile } from "@/hooks/use-mobile"
import { ChannelRatesTable, type APIKeyAction } from "@/components/channels/channel-parts"

/** 单个渠道的分组倍率，从渠道行尾的“分组”按钮打开。 */
export function ChannelGroupsSheet({ channel, onClose, onAPIKeyAction }: {
  channel: Channel | null
  onClose: () => void
  onAPIKeyAction: APIKeyAction
}) {
  const isMobile = useIsMobile()
  return (
    <SideSheet
      visible={channel != null}
      onCancel={onClose}
      title={
        <div className="stack" style={{ gap: 2 }}>
          <span>分组倍率</span>
          {channel ? (
            <Typography.Text type="tertiary" size="small" style={{ fontWeight: "normal" }}>
              {channel.name} · {channelTypeLabel(channel.type)}
              {channel.only_created_key_groups_enabled ? " · 只看已建密钥的分组" : ""}
            </Typography.Text>
          ) : null}
        </div>
      }
      width={isMobile ? "100%" : 720}
      bodyStyle={{ paddingBottom: 16 }}
    >
      {channel ? <ChannelRatesTable channel={channel} onAPIKeyAction={onAPIKeyAction} /> : null}
    </SideSheet>
  )
}
