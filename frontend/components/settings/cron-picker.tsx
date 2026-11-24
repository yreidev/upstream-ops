import { useEffect, useState } from "react"
import { Time } from "@internationalized/date"
import { Description, Input, InputGroup, Label, ListBox, Select, TextField, TimeField } from "@heroui/react"
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
  const [state, setState] = useState<{ spec: string; runs: NextRuns | null; error: string }>({
    spec: "",
    runs: null,
    error: "",
  })
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

export interface CronPickerProps {
  label: string
  value?: string
  onChange?: (value: string) => void
  disabled?: boolean
  /** “不运行”时显示的说明，比如“不定时巡检” */
  offText?: string
  /** 环境变量覆盖说明 */
  extraText?: string
}

/** 选周期：先选方式再填数字或时间，表达式藏进“自定义”。 */
export function CronPicker({ label, value, onChange, disabled, offText = "不定时运行", extraText }: CronPickerProps) {
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
  const maxMinute = plan.mode === "minutes" ? plan.every - 1 : 59
  const clampMinute = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(0, Math.round(v)), maxMinute) : 0)

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

  // 设置页一行两到三列、每列最窄 280 像素：第一行选方式，第二行用带前后缀的小控件填参数
  return (
    <div className="stack gap-1.5">
      <Select
        variant="secondary"
        fullWidth
        value={plan.mode}
        isDisabled={disabled}
        onChange={(k) => k != null && update(switchMode(plan, String(k) as CronMode))}
      >
        <Label>{label}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {cronModes.map((m) => (
              <ListBox.Item key={m.value} id={m.value} textValue={m.label}>
                {m.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>

      {plan.mode === "minutes" || plan.mode === "hours" ? (
        <div className="row flex-wrap gap-2">
          <Select
            variant="secondary"
            aria-label={`${label} 间隔`}
            value={String(plan.every)}
            isDisabled={disabled}
            onChange={(k) => {
              if (k == null) return
              const every = Number(k)
              update({
                ...plan,
                every,
                minute: plan.mode === "minutes" && plan.minute >= every ? 0 : plan.minute,
              })
            }}
            className="w-32"
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {(plan.mode === "minutes" ? minuteSteps : hourSteps).map((n) => {
                  const text = `每 ${n} ${plan.mode === "minutes" ? "分钟" : "小时"}`
                  return (
                    <ListBox.Item key={n} id={String(n)} textValue={text}>
                      {text}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  )
                })}
              </ListBox>
            </Select.Popover>
          </Select>

          {plan.mode === "hours" || plan.every > 1 ? (
            <InputGroup variant="secondary" className={plan.mode === "minutes" ? "w-36" : "w-32"}>
              <InputGroup.Prefix className="text-xs text-muted">
                {plan.mode === "minutes" ? "从第" : "在第"}
              </InputGroup.Prefix>
              <InputGroup.Input
                aria-label={`${label} 分钟偏移`}
                type="number"
                min={0}
                max={maxMinute}
                step={1}
                disabled={disabled}
                value={String(plan.minute)}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  update({ ...plan, minute: e.target.value === "" ? 0 : clampMinute(n) })
                }}
                className="num text-center"
              />
              <InputGroup.Suffix className="text-xs text-muted">
                {plan.mode === "minutes" ? "分开始" : "分"}
              </InputGroup.Suffix>
            </InputGroup>
          ) : null}
        </div>
      ) : null}

      {plan.mode === "daily" || plan.mode === "weekly" ? (
        <div className="row flex-wrap gap-2">
          <TimeField
            aria-label={`${label} 执行时间`}
            hourCycle={24}
            granularity="minute"
            isDisabled={disabled}
            value={new Time(plan.hour, plan.minute)}
            onChange={(t) => {
              if (t) update({ ...plan, hour: t.hour, minute: t.minute })
            }}
            className="w-28"
          >
            <TimeField.Group variant="secondary">
              <TimeField.Prefix className="text-xs text-muted">在</TimeField.Prefix>
              <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
            </TimeField.Group>
          </TimeField>

          {plan.mode === "weekly" ? (
            <Select
              variant="secondary"
              aria-label={`${label} 星期`}
              selectionMode="multiple"
              value={plan.days.map(String)}
              isDisabled={disabled}
              onChange={(keys) => {
                // 至少留一天，全取消就不是“每周”了
                if (Array.isArray(keys) && keys.length > 0) {
                  update({ ...plan, days: keys.map(Number) })
                }
              }}
              className="min-w-[150px] flex-1"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {weekdays.map((d) => (
                    <ListBox.Item key={d.value} id={String(d.value)} textValue={`周${d.label}`}>
                      周{d.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          ) : null}
        </div>
      ) : null}

      {plan.mode === "custom" ? (
        <TextField
          variant="secondary"
          aria-label={`${label} Cron 表达式`}
          fullWidth
          value={plan.custom}
          isDisabled={disabled}
          onChange={(v) => update({ ...plan, custom: v })}
        >
          <Input className="mono text-xs" placeholder="秒 分 时 日 月 周，例如 0 */15 * * * *" />
        </TextField>
      ) : null}

      {plan.mode === "custom" && description ? <Description>{description}</Description> : null}
      <Description className={error ? "text-danger" : undefined}>{preview}</Description>
      {extraText ? <Description className="text-warning">{extraText}</Description> : null}
    </div>
  )
}
