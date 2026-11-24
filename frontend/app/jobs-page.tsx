import { useEffect, useState } from "react"
import { Accordion, Chip, EmptyState, ListBox, Select, Spinner, Surface, type Key } from "@heroui/react"
import { Check, Xmark } from "@gravity-ui/icons"
import { PageHeader } from "@/components/layout/page-header"
import { PaginationBar } from "@/components/common/pagination-bar"
import { stageLabel } from "@/components/channels/channel-parts"
import type { BackgroundJob, JobKind, JobSource, JobStatus, ProgressEvent } from "@/lib/api-types"
import { formatDurationMS, fullDateTime, relativeTime } from "@/lib/format"
import { jobKindLabel, jobSourceLabel, jobStatusMeta } from "@/lib/labels"
import { useJob, useJobs } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const PAGE_SIZE = 20

function durationOf(job: BackgroundJob) {
  if (!job.finished_at) return null
  return new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()
}

function clockTime(iso: string) {
  const d = new Date(iso)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
}

function EventIcon({ ev, running }: { ev: ProgressEvent; running: boolean }) {
  if (ev.stage === "skipped") return <span className="mt-1.5 inline-block h-0.5 w-2.5 rounded-full bg-muted" />
  if (ev.stage === "error" || ev.ok === false) return <Xmark className="size-3.5 text-danger" />
  if (ev.ok === true || ev.stage === "done") return <Check className="size-3.5 text-success" />
  // 没有结论的“进行中”事件：任务还在跑就转圈，已结束说明这一步没跑完
  return running ? <Spinner size="sm" /> : <span className="mt-1.5 inline-block h-0.5 w-2.5 rounded-full bg-warning" />
}

/** 展开一行时才拉这条任务的分步进度；任务还在跑就每秒刷新。 */
function JobDetail({ id }: { id: number }) {
  const job = useJob(id)
  const running = job.data?.status === "running"
  const { refetch } = job

  useEffect(() => {
    if (!running) return
    const t = setInterval(refetch, 1000)
    return () => clearInterval(t)
  }, [running, refetch])

  if (job.loading) return <Spinner size="sm" />
  if (job.error) return <span className="text-xs text-danger">{job.error}</span>
  const events = job.data?.events ?? []
  if (events.length === 0) {
    return <span className="text-xs text-muted">{running ? "准备中…" : "没有分步记录"}</span>
  }
  return (
    <div className="stack gap-1 py-0.5">
      {events.map((ev, i) => {
        const failed = ev.stage === "error" || ev.ok === false
        return (
          <div key={i} className="row items-start gap-2 text-xs">
            <span className="inline-flex w-4 shrink-0 justify-center pt-0.5">
              <EventIcon ev={ev} running={running} />
            </span>
            <span className="num shrink-0 text-muted">{clockTime(ev.time)}</span>
            {ev.channel_name ? <span className="shrink-0 font-medium text-foreground">{ev.channel_name}</span> : null}
            <span className="w-8 shrink-0 text-muted">{stageLabel[ev.stage] ?? ev.stage}</span>
            <span className={`pre-wrap min-w-0 ${failed ? "text-danger" : "text-foreground"}`}>{ev.message}</span>
          </div>
        )
      })}
    </div>
  )
}

const JOBS_GRID = "grid grid-cols-[84px_minmax(140px,1fr)_64px_82px_68px_minmax(160px,1.2fr)] items-center gap-2"

export default function JobsPage() {
  const isMobile = useIsMobile()
  const [kind, setKind] = useState<JobKind | undefined>()
  const [source, setSource] = useState<JobSource | undefined>()
  const [status, setStatus] = useState<JobStatus | undefined>()
  const [page, setPage] = useState(1)
  const [expandedKeys, setExpandedKeys] = useState<Set<Key>>(() => new Set())
  const jobs = useJobs({ kind, source, status }, page, PAGE_SIZE)
  const items = jobs.data?.items ?? []
  const total = jobs.data?.total ?? 0
  const hasRunning = items.some((j) => j.status === "running")
  const { refetch } = jobs

  // 有任务在跑时每 2 秒刷新列表，跑完自动停
  useEffect(() => {
    if (!hasRunning) return
    const t = setInterval(refetch, 2000)
    return () => clearInterval(t)
  }, [hasRunning, refetch])

  return (
    <div className="page">
      <PageHeader
        title="后台任务"
        description="手动点的同步、测试登录，以及每轮定时采集和清理，都在后台跑完并记在这里，关掉页面也不影响。展开一行看每一步；记录和监控日志一起按保留天数清理。"
        actions={
          <>
            <Select
              aria-label="按任务类型筛选"
              placeholder="全部任务"
              value={kind ?? null}
              onChange={(k) => {
                setKind(k == null || k === "" ? undefined : (String(k) as JobKind))
                setPage(1)
              }}
              onClear={() => {
                setKind(undefined)
                setPage(1)
              }}
              className="w-36"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.ClearButton />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {Object.entries(jobKindLabel).map(([value, label]) => (
                    <ListBox.Item key={value} id={value} textValue={label}>
                      {label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            <Select
              aria-label="按触发方式筛选"
              placeholder="手动和定时"
              value={source ?? null}
              onChange={(k) => {
                setSource(k == null || k === "" ? undefined : (String(k) as JobSource))
                setPage(1)
              }}
              onClear={() => {
                setSource(undefined)
                setPage(1)
              }}
              className="w-36"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.ClearButton />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {Object.entries(jobSourceLabel).map(([value, label]) => (
                    <ListBox.Item key={value} id={value} textValue={label}>
                      {label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            <Select
              aria-label="按状态筛选"
              placeholder="全部状态"
              value={status ?? null}
              onChange={(k) => {
                setStatus(k == null || k === "" ? undefined : (String(k) as JobStatus))
                setPage(1)
              }}
              onClear={() => {
                setStatus(undefined)
                setPage(1)
              }}
              className="w-36"
            >
              <Select.Trigger>
                <Select.Value />
                <Select.ClearButton />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {Object.entries(jobStatusMeta).map(([value, meta]) => (
                    <ListBox.Item key={value} id={value} textValue={meta.label}>
                      {meta.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </>
        }
      />

      {jobs.loading && !jobs.data ? (
        <Surface className="flex justify-center rounded-[20px] py-16">
          <Spinner />
        </Surface>
      ) : (
        <div className={`expandable-table transition-opacity ${jobs.stale ? "opacity-60" : "opacity-100"}`}>
          <div className="expandable-table__scroll">
            <div className="min-w-[720px]">
              <div className="expandable-table__header flex items-center gap-2">
                <span className="w-4 shrink-0" />
                <div className={`${JOBS_GRID} flex-1`}>
                  <span>开始时间</span>
                  <span>任务</span>
                  <span>触发</span>
                  <span>状态</span>
                  <span>耗时</span>
                  <span>结果</span>
                </div>
              </div>
              <div className="expandable-table__body">
                {items.length === 0 ? (
                  <EmptyState className="py-12 text-sm text-muted">没有符合条件的后台任务</EmptyState>
                ) : (
                  <Accordion
                    allowsMultipleExpanded
                    expandedKeys={expandedKeys}
                    onExpandedChange={setExpandedKeys}
                    className="w-full"
                  >
                    {items.map((job) => {
                      const key = String(job.id)
                      const open = expandedKeys.has(key)
                      const kindText = jobKindLabel[job.kind] ?? job.kind
                      const meta = jobStatusMeta[job.status] ?? { label: job.status, color: "default" as const }
                      return (
                        <Accordion.Item key={job.id} id={key}>
                          <Accordion.Heading>
                            <Accordion.Trigger className="gap-2 px-3.5 py-2.5 font-normal">
                              <Accordion.Indicator className="ms-0 shrink-0" />
                              <div className={`${JOBS_GRID} min-w-0 flex-1`}>
                                <span className="truncate text-xs text-muted" title={fullDateTime(job.started_at)}>
                                  {relativeTime(job.started_at)}
                                </span>
                                <div className="stack min-w-0 gap-0.5">
                                  <span className="truncate text-sm font-medium text-foreground" title={job.title}>
                                    {job.title}
                                  </span>
                                  {/* 定时任务的标题就是类型名，不重复显示 */}
                                  {kindText !== job.title ? (
                                    <span className="text-xs text-muted">{kindText}</span>
                                  ) : null}
                                </div>
                                <div>
                                  <Chip color={job.source === "manual" ? "accent" : "default"} variant="soft" size="sm">
                                    {jobSourceLabel[job.source] ?? job.source}
                                  </Chip>
                                </div>
                                <div>
                                  <Chip color={meta.color} variant="soft" size="sm">
                                    {job.status === "running" ? <Spinner size="sm" color="current" /> : null}
                                    <Chip.Label>{meta.label}</Chip.Label>
                                  </Chip>
                                </div>
                                <span className="num text-xs text-foreground">
                                  {job.status === "running" ? "—" : formatDurationMS(durationOf(job))}
                                </span>
                                <div className="min-w-0">
                                  {job.message ? (
                                    <span
                                      title={job.message}
                                      className={`line-clamp-2 text-xs ${
                                        job.status === "failed"
                                          ? "text-danger"
                                          : job.status === "interrupted"
                                            ? "text-warning"
                                            : "text-foreground"
                                      }`}
                                    >
                                      {job.message}
                                    </span>
                                  ) : (
                                    <span className="text-xs text-muted">—</span>
                                  )}
                                </div>
                              </div>
                            </Accordion.Trigger>
                          </Accordion.Heading>
                          <Accordion.Panel>
                            <Accordion.Body className="border-t border-separator/70 bg-surface-secondary/45 px-4 py-3 pl-10 text-foreground">
                              {open ? <JobDetail id={job.id} /> : null}
                            </Accordion.Body>
                          </Accordion.Panel>
                        </Accordion.Item>
                      )
                    })}
                  </Accordion>
                )}
              </div>
            </div>
          </div>
          {total > PAGE_SIZE ? (
            <div className="expandable-table__footer">
              <PaginationBar
                page={page}
                total={total}
                pageSize={PAGE_SIZE}
                onChange={setPage}
                compact={isMobile}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
