import { useEffect, useState } from "react"
import { Input, InputNumber, Select, TimePicker, Typography, withField } from "@douyinfe/semi-ui"
import { apiFetch } from "@/lib/api"
import {
  buildCron,
  cronModes,
  describeCron,
  hourSteps,
  minuteSteps,
  pad2,
  parseCron,
  switchMode,
  weekdays,
  type CronMode,
  type CronPlan,
} from "@/lib/cron"

interface NextRuns {
  next: string[]
  utc_offset_seconds: number
}

/** 按服务器时区显示：把 UTC 时间加上服务器的偏移，再按 UTC 读年月日时分 */
function serverWallClock(iso: string, offset: number): Date {
  return new Date(Date.parse(iso) + offset * 1000)
}

function formatRuns(runs: NextRuns): string {
  const today = serverWallClock(new Date().toISOString(), runs.utc_offset_seconds)
  const dayKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
  const tomorrow = new Date(today.getTime() + 86400_000)
  // 自定义里写了秒级的周期（比如每 40 秒）时显示到秒，不然几次看起来一样
  const withSeconds = runs.next.some((iso) => new Date(iso).getUTCSeconds() !== 0)
  return runs.next
    .map((iso) => {
      const d = serverWallClock(iso, runs.utc_offset_seconds)
      const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${withSeconds ? `:${pad2(d.getUTCSeconds())}` : ""}`
      if (dayKey(d) === dayKey(today)) return `今天 ${time}`
      if (dayKey(d) === dayKey(tomorrow)) return `明天 ${time}`
      return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${time}`
    })
    .join("、")
}

function offsetText(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+"
  const abs = Math.abs(seconds)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  return `UTC${sign}${h}${m ? `:${pad2(m)}` : ""}`
}

/** 接下来几次运行时间，由后端按调度器的规则算；写错时显示中文报错 */
function useNextRuns(spec: string): { runs: NextRuns | null; error: string } {
  const [state, setState] = useState<{ spec: string; runs: NextRuns | null; error: string }>({ spec: "", runs: null, error: "" })
  useEffect(() => {
    if (!spec) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      apiFetch<NextRuns>(`/settings/cron/next?spec=${encodeURIComponent(spec)}`)
        .then((runs) => !cancelled && setState({ spec, runs, error: "" }))
        .catch((err) => !cancelled && setState({ spec, runs: null, error: err instanceof Error ? err.message : "算不出运行时间" }))
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [spec])
  return state.spec === spec ? state : { runs: null, error: "" }
}

interface CronPickerProps {
  value?: string
  onChange?: (value: string) => void
  disabled?: boolean
  /** “不运行”时显示的说明，比如“不定时巡检” */
  offText?: string
}

/** 选周期：先选方式再填数字或时间，表达式藏进“自定义”。 */
export function CronPicker({ value, onChange, disabled, offText = "不定时运行" }: CronPickerProps) {
  const spec = (value ?? "").trim()
  // 方式和各项数字自己记着：从“每天”切到“每周”时沿用时间，自定义里打到一半的也不会被重新解析掉
  const [plan, setPlan] = useState<CronPlan>(() => parseCron(spec))
  const [synced, setSynced] = useState(spec)
  if (spec !== synced && spec !== buildCron(plan)) {
    // 外面改了值（比如保存后重新载入），重新认一遍
    setPlan(parseCron(spec))
    setSynced(spec)
  }

  const update = (next: CronPlan) => {
    setPlan(next)
    const built = buildCron(next)
    setSynced(built)
    onChange?.(built)
  }

  const { runs, error } = useNextRuns(spec)
  const description = plan.mode === "custom" ? describeCron(spec) : ""
  const browserOffset = -new Date().getTimezoneOffset() * 60
  const time = `${pad2(plan.hour)}:${pad2(plan.minute)}`
  const setTime = (a: unknown, b: unknown) => {
    const d = a instanceof Date ? a : b instanceof Date ? b : null
    if (d) update({ ...plan, hour: d.getHours(), minute: d.getMinutes() })
  }

  const clampMinute = (v: number, max: number) => (Number.isFinite(v) ? Math.min(Math.max(0, Math.round(v)), max) : 0)
  const preview =
    plan.mode === "off" || !spec
      ? offText
      : error
        ? error
        : runs
          ? runs.next.length > 0
            ? `接下来：${formatRuns(runs)}${runs.utc_offset_seconds !== browserOffset ? `（服务器时间，${offsetText(runs.utc_offset_seconds)}）` : ""}`
            : "这个表达式永远不会运行"
          : "正在计算运行时间…"

  // 设置页一行三列、每列最窄 280 像素：第一行选方式，第二行用带前后缀的小控件填参数
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Select value={plan.mode} disabled={disabled} style={{ width: "100%" }} optionList={cronModes} onChange={(v) => update(switchMode(plan, v as CronMode))} />
      {plan.mode === "minutes" || plan.mode === "hours" ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Select
            value={plan.every}
            disabled={disabled}
            prefix="每"
            style={{ width: 128 }}
            optionList={(plan.mode === "minutes" ? minuteSteps : hourSteps).map((n) => ({ value: n, label: `${n} ${plan.mode === "minutes" ? "分钟" : "小时"}` }))}
            onChange={(v) => update({ ...plan, every: Number(v), minute: plan.mode === "minutes" && plan.minute >= Number(v) ? 0 : plan.minute })}
          />
          {plan.mode === "hours" || plan.every > 1 ? (
            <InputNumber
              value={plan.minute}
              disabled={disabled}
              prefix={plan.mode === "minutes" ? "从第" : "在第"}
              suffix={plan.mode === "minutes" ? "分开始" : "分"}
              min={0}
              max={plan.mode === "minutes" ? plan.every - 1 : 59}
              precision={0}
              hideButtons
              style={{ width: plan.mode === "minutes" ? 136 : 112 }}
              onNumberChange={(v) => update({ ...plan, minute: clampMinute(v, plan.mode === "minutes" ? plan.every - 1 : 59) })}
            />
          ) : null}
        </div>
      ) : null}
      {plan.mode === "daily" || plan.mode === "weekly" ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <TimePicker value={time} format="HH:mm" disabled={disabled} showClear={false} insetLabel="在" style={{ width: 112 }} onChange={setTime} />
          {plan.mode === "weekly" ? (
            <Select
              multiple
              value={plan.days}
              disabled={disabled}
              style={{ flex: 1, minWidth: 150 }}
              optionList={weekdays.map((d) => ({ value: d.value, label: `周${d.label}` }))}
              // 至少留一天，全取消就不是“每周”了
              onChange={(v) => Array.isArray(v) && v.length > 0 && update({ ...plan, days: v.map(Number) })}
            />
          ) : null}
        </div>
      ) : null}
      {plan.mode === "custom" ? (
        <Input
          value={plan.custom}
          disabled={disabled}
          className="mono"
          placeholder="秒 分 时 日 月 周，例如 0 */15 * * * *"
          onChange={(v) => update({ ...plan, custom: v })}
        />
      ) : null}
      {plan.mode === "custom" && description ? (
        <Typography.Text type="tertiary" size="small">
          {description}
        </Typography.Text>
      ) : null}
      <Typography.Text type={error ? "danger" : "tertiary"} size="small">
        {preview}
      </Typography.Text>
    </div>
  )
}

/** 设置页表单里用的版本，和 Form.Input 一样接 field、label、extraText */
export const FormCronPicker = withField(CronPicker, { valueKey: "value", onKeyChangeFnName: "onChange", shouldMemo: false })
