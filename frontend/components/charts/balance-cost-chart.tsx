import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Surface } from "@heroui/react"
import { money } from "@/lib/format"

export interface BalanceCostPoint {
  /** 横轴文字，如 10月13日 */
  day: string
  balance: number | null
  cost: number | null
}

function formatY(n: number) {
  if (n === 0) return "$0"
  const abs = Math.abs(n)
  if (abs >= 1000) return `$${(n / 1000).toFixed(abs >= 10000 ? 0 : 1)}K`
  if (abs >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(abs >= 10 ? 1 : 2)}`
}

interface TooltipPayloadItem {
  name?: string
  value?: number | string | null
  color?: string
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const valid = payload.filter((item) => item.value != null && item.value !== "")
  if (valid.length === 0) return null

  return (
    <Surface className="rounded-xl border border-separator/80 bg-overlay px-3 py-2 text-xs text-foreground shadow-overlay">
      <div className="mb-1.5 font-medium text-muted">{label}</div>
      <div className="flex flex-col gap-1">
        {valid.map((item) => (
          <div key={item.name} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              {item.name}
            </span>
            <span className="num font-semibold text-foreground">{money(Number(item.value))}</span>
          </div>
        ))}
      </div>
    </Surface>
  )
}

/** 余额（左轴）和消费（右轴）双轴折线图。默认导出，由总览页按需加载。 */
export default function BalanceCostChart({
  data,
  height = 280,
  compact = false,
}: {
  data: BalanceCostPoint[]
  height?: number
  compact?: boolean
}) {
  const tickStyle = { fill: "var(--muted)", fontSize: compact ? 10 : 12 }

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={compact ? { top: 8, right: 6, bottom: 4, left: -12 } : { top: 8, right: 12, bottom: 4, left: 4 }}
        >
          <CartesianGrid stroke="var(--separator)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="day"
            tick={tickStyle}
            tickMargin={8}
            axisLine={{ stroke: "var(--separator)" }}
            tickLine={false}
            minTickGap={compact ? 24 : 16}
          />
          <YAxis
            yAxisId="balance"
            orientation="left"
            tick={tickStyle}
            tickFormatter={(v: number) => formatY(Number(v))}
            axisLine={false}
            tickLine={false}
            width={compact ? 46 : 56}
          />
          <YAxis
            yAxisId="cost"
            orientation="right"
            hide={compact}
            tick={tickStyle}
            tickFormatter={(v: number) => formatY(Number(v))}
            axisLine={false}
            tickLine={false}
            width={compact ? 0 : 56}
          />
          <Tooltip content={<ChartTooltip />} />
          <Legend
            verticalAlign="top"
            align="right"
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, paddingBottom: 10, color: "var(--muted)" }}
          />
          <Line
            yAxisId="balance"
            type="monotone"
            dataKey="balance"
            name="余额"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={compact ? false : { r: 2.5, fill: "var(--accent)", strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            yAxisId="cost"
            type="monotone"
            dataKey="cost"
            name="消费"
            stroke="var(--warning)"
            strokeWidth={2}
            dot={compact ? false : { r: 2.5, fill: "var(--warning)", strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
