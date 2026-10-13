/**
 * 后台任务：发起后由后端在后台跑完，页面只轮询任务记录。
 * 关页面、刷新都不影响任务本身；重新打开页面时用 /jobs/running 接上进度。
 */

import { apiFetch, type ApiError } from "@/lib/api"
import type { BackgroundJob, StartedJob } from "@/lib/api-types"

const POLL_MS = 1000
/** 连续这么多次查不到（网络抖动等）才放弃，任务本身仍在后端跑。 */
const MAX_POLL_FAILURES = 5

/** 发起任务。同一对象已有任务在跑时返回那个任务，started 为 false。 */
export function startJob(path: string): Promise<StartedJob> {
  return apiFetch<StartedJob>(path, { method: "POST" })
}

export function fetchRunningJobs(): Promise<BackgroundJob[]> {
  return apiFetch<BackgroundJob[]>("/jobs/running")
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/**
 * 每秒查一次任务直到结束，每次都把最新记录交给 onUpdate，返回最终记录。
 * signal 中止时只是停止查询（例如离开页面），任务本身不受影响。
 */
export async function watchJob(
  id: number,
  onUpdate: (job: BackgroundJob) => void,
  signal?: AbortSignal,
): Promise<BackgroundJob> {
  let failures = 0
  for (;;) {
    try {
      const job = await apiFetch<BackgroundJob>(`/jobs/${id}`, { signal })
      failures = 0
      onUpdate(job)
      if (job.status !== "running") return job
    } catch (err) {
      if (signal?.aborted || (err as ApiError).status === 404 || ++failures >= MAX_POLL_FAILURES) throw err
    }
    await sleep(POLL_MS, signal)
  }
}

/** 中止导致的异常（离开页面）不用提示。 */
export function isAbort(err: unknown, signal?: AbortSignal) {
  return signal?.aborted === true || (err as Error)?.name === "AbortError"
}
