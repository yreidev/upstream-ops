import type { CSSProperties } from "react"
import { ListBox, Select } from "@heroui/react"
import { channelTypeLabel } from "@/lib/format"
import { useChannels } from "@/lib/queries"

/** 按渠道筛选的下拉框；不选表示全部渠道。 */
export function ChannelSelect({
  value,
  onChange,
  style,
  className,
  variant,
}: {
  value: number | undefined
  onChange: (id: number | undefined) => void
  style?: CSSProperties
  className?: string
  variant?: "primary" | "secondary"
}) {
  const channels = useChannels()
  const list = channels.data ?? []

  return (
    <Select
      aria-label="按渠道筛选"
      placeholder="全部渠道"
      variant={variant}
      value={value != null ? String(value) : null}
      onChange={(k) => onChange(k == null || k === "" ? undefined : Number(k))}
      onClear={() => onChange(undefined)}
      className={className ?? "w-[220px]"}
      style={style}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.ClearButton />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox renderEmptyState={() => <div className="px-3 py-2 text-xs text-muted">没有渠道</div>}>
          {list.map((c) => {
            const label = `${c.name} · ${channelTypeLabel(c.type)}`
            return (
              <ListBox.Item key={c.id} id={String(c.id)} textValue={label}>
                {label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            )
          })}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}
