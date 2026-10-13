import { useEffect, useState } from "react"
import { Card, Select, Spin, Table, Tag, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { IconClose, IconMinus, IconTick } from "@douyinfe/semi-icons"
import { PageHeader } from "@/components/layout/page-header"
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
  if (ev.stage === "skipped") return <IconMinus size="small" style={{ color: "var(--semi-color-text-2)" }} />
  if (ev.stage === "error" || ev.ok === false) return <IconClose size="small" style={{ color: "var(--semi-color-danger)" }} />
  if (ev.ok === true || ev.stage === "done") return <IconTick size="small" style={{ color: "var(--semi-color-success)" }} />
  // 没有结论的“进行中”事件：任务还在跑就转圈，已结束说明这一步没跑完
  return running ? <Spin size="small" /> : <IconMinus size="small" style={{ color: "var(--semi-color-warning)" }} />
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

  if (job.loading) return <Spin />
  if (job.error) return <Typography.Text type="danger">{job.error}</Typography.Text>
  const events = job.data?.events ?? []
  if (events.length === 0) {
    return <Typography.Text type="tertiary">{running ? "准备中…" : "没有分步记录"}</Typography.Text>
  }
  return (
    <div className="stack" style={{ gap: 4, padding: "4px 0" }}>
      {events.map((ev, i) => {
        const failed = ev.stage === "error" || ev.ok === false
        return (
          <div key={i} className="row" style={{ alignItems: "flex-start", gap: 8 }}>
            <span style={{ width: 16, display: "inline-flex", justifyContent: "center", paddingTop: 2 }}>
              <EventIcon ev={ev} running={running} />
            </span>
            <Typography.Text type="tertiary" size="small" className="num" style={{ flexShrink: 0 }}>
              {clockTime(ev.time)}
            </Typography.Text>
            {ev.channel_name ? (
              <Typography.Text size="small" style={{ flexShrink: 0 }}>
                {ev.channel_name}
              </Typography.Text>
            ) : null}
            <Typography.Text type="tertiary" size="small" style={{ width: 32, flexShrink: 0 }}>
              {stageLabel[ev.stage] ?? ev.stage}
            </Typography.Text>
            <Typography.Text size="small" type={failed ? "danger" : undefined} className="pre-wrap" style={{ minWidth: 0 }}>
              {ev.message}
            </Typography.Text>
          </div>
        )
      })}
    </div>
  )
}

export default function JobsPage() {
  const isMobile = useIsMobile()
  const [kind, setKind] = useState<JobKind | undefined>()
  const [source, setSource] = useState<JobSource | undefined>()
  const [status, setStatus] = useState<JobStatus | undefined>()
  const [page, setPage] = useState(1)
  const jobs = useJobs({ kind, source, status }, page, PAGE_SIZE)
  const items = jobs.data?.items ?? []
  const hasRunning = items.some((j) => j.status === "running")
  const { refetch } = jobs

  // 有任务在跑时每 2 秒刷新列表，跑完自动停
  useEffect(() => {
    if (!hasRunning) return
    const t = setInterval(refetch, 2000)
    return () => clearInterval(t)
  }, [hasRunning, refetch])

  function filterChanged<T>(set: (v: T | undefined) => void) {
    return (v: unknown) => {
      set((v ?? undefined) as T | undefined)
      setPage(1)
    }
  }

  const columns: ColumnProps<BackgroundJob>[] = [
    {
      title: "开始时间",
      dataIndex: "started_at",
      width: 120,
      render: (v: string) => (
        <Tooltip content={fullDateTime(v)}>
          <span>{relativeTime(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: "任务",
      dataIndex: "title",
      width: 220,
      render: (title: string, job) => {
        const kindText = jobKindLabel[job.kind] ?? job.kind
        // 定时任务的标题就是类型名，不重复显示
        return (
          <div className="stack" style={{ gap: 2 }}>
            <Typography.Text>{title}</Typography.Text>
            {kindText !== title ? (
              <Typography.Text type="tertiary" size="small">
                {kindText}
              </Typography.Text>
            ) : null}
          </div>
        )
      },
    },
    {
      title: "触发",
      dataIndex: "source",
      width: 80,
      render: (v: JobSource) => <Tag color={v === "manual" ? "violet" : "grey"}>{jobSourceLabel[v] ?? v}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: JobStatus) => {
        const meta = jobStatusMeta[v] ?? { label: v, color: "grey" as const }
        return (
          <Tag color={meta.color} prefixIcon={v === "running" ? <Spin size="small" /> : undefined}>
            {meta.label}
          </Tag>
        )
      },
    },
    {
      title: "耗时",
      dataIndex: "finished_at",
      width: 90,
      render: (_: unknown, job) => <span className="num">{job.status === "running" ? "—" : formatDurationMS(durationOf(job))}</span>,
    },
    {
      title: "结果",
      dataIndex: "message",
      render: (v: string | undefined, job) =>
        v ? (
          <Typography.Text
            size="small"
            type={job.status === "failed" ? "danger" : job.status === "interrupted" ? "warning" : undefined}
            ellipsis={{ rows: 2, showTooltip: { opts: { style: { maxWidth: 560 } } } }}
          >
            {v}
          </Typography.Text>
        ) : (
          <Typography.Text type="tertiary">—</Typography.Text>
        ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="后台任务"
        description="手动点的同步、测试登录、CCH 同步、降智检测，以及每轮定时采集、巡检和清理，都在后台跑完并记在这里，关掉页面也不影响。展开一行看每一步；记录和监控日志一起按保留天数清理。"
        actions={
          <>
            <Select
              placeholder="全部任务"
              showClear
              value={kind}
              onChange={filterChanged(setKind)}
              style={{ width: 120 }}
              optionList={Object.entries(jobKindLabel).map(([value, label]) => ({ value, label }))}
            />
            <Select
              placeholder="手动和定时"
              showClear
              value={source}
              onChange={filterChanged(setSource)}
              style={{ width: 120 }}
              optionList={Object.entries(jobSourceLabel).map(([value, label]) => ({ value, label }))}
            />
            <Select
              placeholder="全部状态"
              showClear
              value={status}
              onChange={filterChanged(setStatus)}
              style={{ width: 110 }}
              optionList={Object.entries(jobStatusMeta).map(([value, meta]) => ({ value, label: meta.label }))}
            />
          </>
        }
      />
      <Card bodyStyle={{ padding: 0 }}>
        <Table<BackgroundJob>
          rowKey="id"
          size={isMobile ? "small" : "default"}
          columns={columns}
          dataSource={items}
          loading={jobs.loading || jobs.stale}
          scroll={{ x: 860 }}
          expandedRowRender={(job) => (job ? <JobDetail id={job.id} /> : null)}
          empty="没有符合条件的后台任务"
          pagination={{
            currentPage: page,
            pageSize: PAGE_SIZE,
            total: jobs.data?.total ?? 0,
            onPageChange: setPage,
            showTotal: !isMobile,
            size: isMobile ? "small" : "default",
          }}
        />
      </Card>
    </div>
  )
}
