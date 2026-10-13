/**
 * 设置页选周期用的 Cron 读写：把带秒的 6 段表达式认成“每隔几分钟 / 每隔几小时 / 每天 / 每周”，
 * 选好后再写回表达式。认不出的切到“自定义”原样保留。方案见 docs/cron-picker.md。
 */
import cronstrue from "cronstrue"
import "cronstrue/locales/zh_CN"

export type CronMode = "minutes" | "hours" | "daily" | "weekly" | "off" | "custom"

export interface CronPlan {
  mode: CronMode
  /** 每隔几分钟或几小时 */
  every: number
  /** 每隔几分钟时从第几分开始；每隔几小时、每天、每周时是第几分 */
  minute: number
  hour: number
  /** 星期几，0 是星期日 */
  days: number[]
  /** 自定义时的原表达式 */
  custom: string
}

export const cronModes: Array<{ value: CronMode; label: string }> = [
  { value: "minutes", label: "每隔几分钟" },
  { value: "hours", label: "每隔几小时" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "off", label: "不运行" },
  { value: "custom", label: "自定义" },
]

/** 能整除 60 的间隔，每小时开头都对得上，不会在整点处挤在一起 */
export const minuteSteps = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]
/** 能整除 24 的间隔 */
export const hourSteps = [1, 2, 3, 4, 6, 8, 12]

export const weekdays = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
]

const defaults: CronPlan = { mode: "off", every: 10, minute: 0, hour: 3, days: [1], custom: "" }

function int(s: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(s)) return null
  const n = Number(s)
  return n >= min && n <= max ? n : null
}

/** 解析星期几：0-6 的数字（调度器不认 7），可以用逗号和连字符，比如 1-5 或 1,3,5 */
function parseDays(s: string): number[] | null {
  const days = new Set<number>()
  for (const part of s.split(",")) {
    const range = part.split("-")
    if (range.length > 2) return null
    const from = int(range[0], 0, 6)
    const to = range.length === 2 ? int(range[1], 0, 6) : from
    if (from === null || to === null || to < from) return null
    for (let d = from; d <= to; d++) days.add(d)
  }
  return [...days].sort((a, b) => a - b)
}

/** 把表达式认成选周期的方式；认不出的返回“自定义”。空表达式是“不运行”。 */
export function parseCron(spec: string): CronPlan {
  const text = spec.trim()
  if (!text) return { ...defaults, mode: "off" }
  const custom: CronPlan = { ...defaults, mode: "custom", custom: text }
  const f = text.split(/\s+/)
  if (f.length !== 6 || f[0] !== "0" || f[4] !== "*") return custom
  const [, min, hour, dom, , dow] = f

  if (hour === "*" && dom === "*" && dow === "*") {
    let m: RegExpMatchArray | null
    if (min === "*") return { ...defaults, mode: "minutes", every: 1, minute: 0 }
    if ((m = min.match(/^\*\/(\d+)$/))) {
      const every = Number(m[1])
      if (minuteSteps.includes(every)) return { ...defaults, mode: "minutes", every, minute: 0 }
    }
    if ((m = min.match(/^(\d+)(?:-59)?\/(\d+)$/))) {
      const minute = Number(m[1])
      const every = Number(m[2])
      if (minuteSteps.includes(every) && minute < every) return { ...defaults, mode: "minutes", every, minute }
    }
    const minute = int(min, 0, 59)
    if (minute !== null) return { ...defaults, mode: "hours", every: 1, minute }
    return custom
  }

  const minute = int(min, 0, 59)
  if (minute === null || dom !== "*") return custom
  if (dow === "*") {
    if (hour === "*") return { ...defaults, mode: "hours", every: 1, minute }
    const m = hour.match(/^\*\/(\d+)$/)
    if (m && hourSteps.includes(Number(m[1]))) return { ...defaults, mode: "hours", every: Number(m[1]), minute }
  }
  const h = int(hour, 0, 23)
  if (h === null) return custom
  if (dow === "*") return { ...defaults, mode: "daily", hour: h, minute }
  const days = parseDays(dow)
  if (!days) return custom
  return { ...defaults, mode: "weekly", hour: h, minute, days }
}

/** 按选好的方式写回表达式；“不运行”是空字符串。 */
export function buildCron(p: CronPlan): string {
  switch (p.mode) {
    case "minutes":
      if (p.every <= 1) return "0 * * * * *"
      return p.minute > 0 ? `0 ${p.minute}-59/${p.every} * * * *` : `0 */${p.every} * * * *`
    case "hours":
      return p.every <= 1 ? `0 ${p.minute} * * * *` : `0 ${p.minute} */${p.every} * * *`
    case "daily":
      return `0 ${p.minute} ${p.hour} * * *`
    case "weekly":
      return `0 ${p.minute} ${p.hour} * * ${[...p.days].sort((a, b) => a - b).join(",")}`
    case "off":
      return ""
    default:
      return p.custom.trim()
  }
}

/** 换方式时给个顺手的初值：从当前表达式能认出的部分接着用 */
export function switchMode(p: CronPlan, mode: CronMode): CronPlan {
  const next = { ...p, mode }
  if (mode === "minutes" && !minuteSteps.includes(p.every)) next.every = 10
  if (mode === "minutes" && next.minute >= next.every) next.minute = 0
  if (mode === "hours" && !hourSteps.includes(p.every)) next.every = 1
  if (mode === "weekly" && p.days.length === 0) next.days = [1]
  if (mode === "custom" && !p.custom) next.custom = buildCron(p)
  return next
}

/** 表达式的中文说明；空表达式、写错的或说明库不认的返回空字符串 */
export function describeCron(spec: string): string {
  const text = spec.trim()
  if (!text || text.split(/\s+/).length !== 6) return ""
  try {
    return cronstrue
      .toString(text, { locale: "zh_CN", use24HourTimeFormat: true, throwExceptionOnParseError: true })
      .replace(/在(\d)/g, "在 $1")
      .replace(/,\s*/g, "，")
      .replace(/，和\s*/g, "和")
  } catch {
    return ""
  }
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0")
}
