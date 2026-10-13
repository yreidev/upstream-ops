import { Select } from "@douyinfe/semi-ui"
import { channelTypeLabel } from "@/lib/format"
import { useChannels } from "@/lib/queries"

/** 按渠道筛选的下拉框；不选表示全部渠道。 */
export function ChannelSelect({ value, onChange, style }: {
  value: number | undefined
  onChange: (id: number | undefined) => void
  style?: React.CSSProperties
}) {
  const channels = useChannels()
  return (
    <Select
      placeholder="全部渠道"
      showClear
      filter
      value={value}
      onChange={(v) => onChange(v == null ? undefined : Number(v))}
      style={{ width: 220, ...style }}
      optionList={(channels.data ?? []).map((c) => ({
        value: c.id,
        label: `${c.name} · ${channelTypeLabel(c.type)}`,
      }))}
      emptyContent="没有渠道"
    />
  )
}
