import { useMemo } from "react"
import { VChartSimple } from "@visactor/react-vchart"
import { VChart } from "@visactor/vchart/esm/core"
import { registerCommonChart } from "@visactor/vchart/esm/chart/common"
import { registerLineSeries } from "@visactor/vchart/esm/series/line/line"
import { registerCartesianBandAxis, registerCartesianLinearAxis } from "@visactor/vchart/esm/component/axis/cartesian"
import { registerCartesianCrossHair } from "@visactor/vchart/esm/component/crosshair"
import { registerDiscreteLegend } from "@visactor/vchart/esm/component/legend"
import { registerTooltip } from "@visactor/vchart/esm/component/tooltip"
import { registerDomTooltipHandler } from "@visactor/vchart/esm/plugin/components/tooltip-handler"
import { registerAnimate } from "@visactor/vchart/esm/plugin/other"
import { initVChartSemiTheme } from "@visactor/vchart-semi-theme"
import { money } from "@/lib/format"
import { useResolvedTheme } from "@/lib/theme"

// 按需注册：@visactor/vchart 主入口会连带注册全部图表类型（vchart-all），react-vchart 的 CommonChart 也从主入口引入，
// 图表这块产物因此有 1.3 MB。这里只注册双轴折线图用到的部分，配 VChartSimple 使用。
VChart.useRegisters([
  registerCommonChart,
  registerLineSeries,
  registerCartesianBandAxis,
  registerCartesianLinearAxis,
  registerCartesianCrossHair,
  registerDiscreteLegend,
  registerTooltip,
  registerDomTooltipHandler,
  registerAnimate,
])
// 图表配色跟随 Semi 主题，并监听 body 的 theme-mode 切换亮色、暗色。放在本模块里，只有用到图表的页面才加载 VChart。
initVChartSemiTheme({ isWatchingMode: true })

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

/**
 * 余额（左轴）和消费（右轴）双轴折线图。默认导出，由总览页按需加载。
 *
 * vchart-semi-theme 1.13.1 配 VChart 2.x 时，暗色下分类轴（横轴）的标签仍是亮色主题的颜色，
 * 所以这里按当前主题从 Semi 的 CSS 变量读出文字颜色，写进各坐标轴，并在主题变化时重新挂载图表。
 */
export default function BalanceCostChart({ data, height = 280, compact = false }: {
  data: BalanceCostPoint[]
  height?: number
  compact?: boolean
}) {
  const theme = useResolvedTheme()

  const spec = useMemo(() => {
    const labelColor = getComputedStyle(document.body).getPropertyValue("--semi-color-text-2").trim() || undefined
    const label = { style: { fill: labelColor, fontSize: compact ? 10 : 12 } }
    const balance = data.filter((d) => d.balance != null).map((d) => ({ day: d.day, value: d.balance, type: "余额" }))
    const cost = data.filter((d) => d.cost != null).map((d) => ({ day: d.day, value: d.cost, type: "消费" }))
    const line = { style: { lineWidth: 2, curveType: "monotone" } }
    return {
      type: "common",
      height,
      padding: compact ? [8, 4, 4, 0] : [12, 12, 8, 8],
      data: [
        { id: "balance", values: balance },
        { id: "cost", values: cost },
      ],
      series: [
        { type: "line", id: "balance", dataId: "balance", xField: "day", yField: "value", seriesField: "type", line, point: { visible: !compact } },
        { type: "line", id: "cost", dataId: "cost", xField: "day", yField: "value", seriesField: "type", line, point: { visible: !compact } },
      ],
      axes: [
        { orient: "bottom", type: "band", label },
        { orient: "left", seriesId: ["balance"], label: { ...label, formatMethod: (v: number) => formatY(Number(v)) }, nice: true, zero: true },
        {
          orient: "right",
          seriesId: ["cost"],
          visible: !compact,
          grid: { visible: false },
          label: { ...label, formatMethod: (v: number) => formatY(Number(v)) },
          nice: true,
          zero: true,
        },
      ],
      legends: { visible: true, orient: "top", position: "start", item: { label: { style: { fill: labelColor } } } },
      tooltip: {
        mark: { content: [{ key: (d: any) => d?.type, value: (d: any) => money(Number(d?.value)) }] },
        dimension: { content: [{ key: (d: any) => d?.type, value: (d: any) => money(Number(d?.value)) }] },
      },
    }
    // theme 变了要重新读 CSS 变量
  }, [data, height, compact, theme])

  return <VChartSimple key={theme} vchartConstructor={VChart} spec={spec as any} />
}
