import { useEffect, useRef, useState } from "react"
import { Button, Card, Dropdown, Spin, Table, Tag, Toast, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { IconDelete, IconKey, IconMore, IconPlay, IconPlus, IconSetting } from "@douyinfe/semi-icons"
import { DegradeAddModal, DegradeModelModal, DegradeReplaceKeyModal } from "@/components/degrade/degrade-modals"
import { PageHeader } from "@/components/layout/page-header"
import { apiFetch } from "@/lib/api"
import type { BackgroundJob, DegradeCheck, DegradeKey, DegradeResult, DegradeState } from "@/lib/api-types"
import { confirm } from "@/lib/confirm"
import { describeCron } from "@/lib/cron"
import { formatDurationMS, formatTokens, fullDateTime, relativeTime } from "@/lib/format"
import { fetchRunningJobs, startJob } from "@/lib/jobs"
import { degradeEffortLabel, degradeResultMeta, degradeStateMeta } from "@/lib/labels"
import { useDegradeChecks, useDegradeKeys } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const POLL_MS = 2000

function isDegradeJob(j: BackgroundJob) {
  return j.kind === "degrade_check" || j.kind === "degrade_check_all"
}

function keyName(k: DegradeKey) {
  return k.name || `#${k.upstream_key_id}`
}

function ResultTag({ result }: { result: DegradeResult }) {
  const meta = degradeResultMeta[result] ?? { label: result, color: "grey" as const }
  return (
    <Tag size="small" color={meta.color}>
      {meta.label}
    </Tag>
  )
}

/** 展开一行看这把密钥最近的检测，正在检测时每 3 秒刷新。 */
function CheckHistory({ k }: { k: DegradeKey }) {
  const isMobile = useIsMobile()
  const checks = useDegradeChecks(k.id)
  const refetch = useRef(checks.refetch)
  refetch.current = checks.refetch

  useEffect(() => {
    if (!k.checking) return
    const t = setInterval(() => refetch.current(), 3000)
    return () => clearInterval(t)
  }, [k.checking])

  if (checks.loading) return <Spin />
  if (checks.error) return <Typography.Text type="danger">{checks.error}</Typography.Text>

  const columns: ColumnProps<DegradeCheck>[] = [
    {
      title: "时间",
      dataIndex: "checked_at",
      width: 110,
      render: (v: string) => (
        <Tooltip content={fullDateTime(v)}>
          <span>{relativeTime(v)}</span>
        </Tooltip>
      ),
    },
    {
      title: "第几次",
      dataIndex: "attempt",
      width: 80,
      render: (v: number) => (v <= 1 ? "首测" : `复测 ${v - 1}`),
    },
    { title: "结果", dataIndex: "result", width: 90, render: (v: DegradeResult) => <ResultTag result={v} /> },
    {
      title: "回答",
      dataIndex: "answer",
      render: (_: unknown, c) =>
        c.error ? (
          <Typography.Text type="danger" size="small" className="pre-wrap">
            {c.error}
          </Typography.Text>
        ) : (
          <Typography.Paragraph
            size="small"
            className="pre-wrap"
            ellipsis={{ rows: 2, expandable: true, collapsible: true, expandText: "展开", collapseText: "收起" }}
            style={{ minWidth: 0 }}
          >
            {c.answer || "—"}
          </Typography.Paragraph>
        ),
    },
    {
      title: "模型",
      dataIndex: "model",
      width: 170,
      render: (v: string, c) => (
        <Typography.Text size="small" className="mono">
          {v} · {degradeEffortLabel(c.effort || "none")}
        </Typography.Text>
      ),
    },
    {
      title: "用量",
      dataIndex: "input_tokens",
      width: 150,
      render: (_: unknown, c) =>
        c.input_tokens || c.output_tokens ? (
          <Tooltip content={`输入 ${c.input_tokens}，输出 ${c.output_tokens}（其中推理 ${c.reasoning_tokens}）`}>
            <Typography.Text size="small" className="num">
              {formatTokens(c.input_tokens)} / {formatTokens(c.output_tokens)}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="tertiary">—</Typography.Text>
        ),
    },
    {
      title: "耗时",
      dataIndex: "duration_ms",
      width: 90,
      render: (v: number) => <span className="num">{formatDurationMS(v)}</span>,
    },
  ]

  return (
    <Table<DegradeCheck>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={checks.data ?? []}
      pagination={false}
      scroll={{ x: isMobile ? 860 : undefined }}
      empty={k.checking ? "正在检测，第一次的结果出来后显示在这里" : "还没有检测记录"}
    />
  )
}

/** 正在跑的降智检测任务：标题和最新一步。 */
function RunningJobs({ jobs }: { jobs: BackgroundJob[] }) {
  if (jobs.length === 0) return null
  return (
    <div className="stack" style={{ gap: 6, padding: "8px 12px", borderRadius: 6, background: "var(--semi-color-fill-0)" }}>
      {jobs.map((job) => {
        const ev = job.events?.[job.events.length - 1]
        const step = ev
          ? job.kind === "degrade_check_all" && ev.channel_name
            ? `${ev.index}/${ev.total} ${ev.channel_name}：${ev.message}`
            : ev.message
          : "准备中…"
        return (
          <div key={job.id} className="row" style={{ alignItems: "flex-start", gap: 8 }}>
            <span style={{ paddingTop: 2 }}>
              <Spin size="small" />
            </span>
            <Typography.Text size="small" strong style={{ flexShrink: 0 }}>
              {job.title}
            </Typography.Text>
            <Typography.Text size="small" type="tertiary" className="pre-wrap" style={{ minWidth: 0 }}>
              {step}
            </Typography.Text>
          </div>
        )
      })}
    </div>
  )
}

export default function DegradePage() {
  const isMobile = useIsMobile()
  const keys = useDegradeKeys()
  const items = keys.data?.items ?? []
  const [running, setRunning] = useState<BackgroundJob[]>([])
  const [starting, setStarting] = useState<number | "all" | null>(null)
  const [adding, setAdding] = useState(false)
  const [modelTarget, setModelTarget] = useState<DegradeKey | null>(null)
  const [replaceTarget, setReplaceTarget] = useState<DegradeKey | null>(null)
  // 在这页发起的任务，跑完时弹出结果；离开页面就不提示了，结果在列表和“后台任务”页
  const mine = useRef(new Set<number>())
  const refetchKeys = useRef(keys.refetch)
  refetchKeys.current = keys.refetch

  async function announce(id: number) {
    try {
      const job = await apiFetch<BackgroundJob>(`/jobs/${id}`)
      const text = `${job.title}：${job.message || "已结束"}`
      if (job.status === "succeeded") Toast.success(text)
      else if (job.status === "failed") Toast.error(text)
      else Toast.warning(text)
    } catch {
      // 任务记录取不到时不提示，列表照常刷新
    }
  }

  async function pollRunning() {
    try {
      const list = (await fetchRunningJobs()).filter(isDegradeJob)
      for (const id of [...mine.current]) {
        if (!list.some((j) => j.id === id)) {
          mine.current.delete(id)
          void announce(id)
        }
      }
      setRunning(list)
    } catch {
      // 下一轮再查
    }
  }

  // 打开页面时接上还在跑的检测（手动或定时巡检）
  useEffect(() => {
    void pollRunning()
  }, [])

  const active = running.length > 0 || items.some((k) => k.checking)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => {
      void pollRunning()
      refetchKeys.current()
    }, POLL_MS)
    return () => clearInterval(t)
  }, [active])

  function track(job: BackgroundJob) {
    mine.current.add(job.id)
    setRunning((list) => (list.some((j) => j.id === job.id) ? list : [...list, job]))
  }

  async function checkOne(k: DegradeKey) {
    setStarting(k.id)
    try {
      const { job, started } = await startJob(`/degrade/keys/${k.id}/check`)
      Toast.info(started ? "已开始检测，一般 1～2 分钟；需要复测时更久" : "这把密钥已经在检测")
      track(job)
      refetchKeys.current()
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "发起检测失败")
    } finally {
      setStarting(null)
    }
  }

  async function checkAll() {
    const ok = await confirm({
      title: `检测全部 ${items.length} 把密钥？`,
      description:
        "每把先问一次，结果和已确认的状态不一样时再问两次。每次大约 1.8 万输入 token，按各自分组的倍率计费。正在单独检测的密钥这次跳过。",
      confirmLabel: "开始检测",
    })
    if (!ok) return
    setStarting("all")
    try {
      const { job, started } = await startJob("/degrade/check-all")
      Toast.info(started ? "已开始检测全部密钥，可以离开这页" : "已经有一轮全部检测在跑")
      track(job)
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "发起检测失败")
    } finally {
      setStarting(null)
    }
  }

  async function remove(k: DegradeKey) {
    const ok = await confirm({
      title: `移除“${keyName(k)}”？`,
      description: "这把密钥的检测记录会一起删除；站点上的密钥不受影响。",
      confirmLabel: "移除",
      destructive: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/degrade/keys/${k.id}`, { method: "DELETE" })
      Toast.success("已移除")
      keys.refetch()
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : "移除失败")
    }
  }

  const allRunning = running.some((j) => j.kind === "degrade_check_all")
  const defaults = keys.data?.defaults
  const cron = keys.data?.cron

  const columns: ColumnProps<DegradeKey>[] = [
    {
      title: "密钥",
      dataIndex: "name",
      width: 260,
      render: (_: unknown, k) => (
        <div className="stack" style={{ gap: 2 }}>
          <Typography.Text strong>{keyName(k)}</Typography.Text>
          <Typography.Text type="tertiary" size="small">
            {k.channel_name || `渠道 #${k.channel_id}`} · {k.group_name || "默认分组"}
          </Typography.Text>
          <Typography.Text type="tertiary" size="small">
            尾号 <span className="mono">{k.key_tail || "—"}</span>
            {k.key_source === "pasted" ? " · 手动粘贴" : ""}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "状态",
      dataIndex: "state",
      width: 120,
      render: (v: DegradeState, k) => {
        const meta = degradeStateMeta[v] ?? { label: v, color: "grey" as const }
        return (
          <div className="stack" style={{ gap: 4, alignItems: "flex-start" }}>
            <Tooltip content={k.state_changed_at ? `确认于 ${fullDateTime(k.state_changed_at)}` : "还没有三次一致的结果"}>
              <Tag color={meta.color}>{meta.label}</Tag>
            </Tooltip>
            {k.checking ? (
              <Tag size="small" color="blue" prefixIcon={<Spin size="small" />}>
                检测中
              </Tag>
            ) : null}
          </div>
        )
      },
    },
    {
      title: "最近一轮",
      dataIndex: "last_checked_at",
      render: (v: string | undefined, k) =>
        v ? (
          <div className="stack" style={{ gap: 2 }}>
            <div className="row" style={{ gap: 6 }}>
              <Tooltip content={fullDateTime(v)}>
                <Typography.Text size="small">{relativeTime(v)}</Typography.Text>
              </Tooltip>
              {k.last_result ? <ResultTag result={k.last_result} /> : null}
            </div>
            {k.last_message ? (
              <Typography.Text
                size="small"
                type={k.last_result === "failed" ? "danger" : "tertiary"}
                ellipsis={{ rows: 2, showTooltip: { opts: { style: { maxWidth: 480 } } } }}
              >
                {k.last_message}
              </Typography.Text>
            ) : null}
          </div>
        ) : (
          <Typography.Text type="tertiary">还没检测</Typography.Text>
        ),
    },
    {
      title: "模型",
      key: "model",
      width: 200,
      render: (_: unknown, k) => {
        // 单独指定了就是它；否则显示最近一轮答题用的，还没检测过时说明会按备选列表挑
        const model = k.model || k.last_model
        return (
          <div className="stack" style={{ gap: 2 }}>
            <Typography.Text size="small" className={model ? "mono" : undefined} type={model ? undefined : "tertiary"}>
              {model || "检测时按备选列表挑"}
            </Typography.Text>
            <Typography.Text type="tertiary" size="small">
              {k.model ? "单独指定" : "自动挑选"} · 推理强度 {degradeEffortLabel(k.effective_effort)}
              {k.effort ? "（单独设置）" : ""}
            </Typography.Text>
          </div>
        )
      },
    },
    {
      title: "操作",
      key: "actions",
      width: 150,
      fixed: isMobile ? undefined : "right",
      render: (_: unknown, k) => (
        <div className="row" style={{ gap: 4 }}>
          <Button
            size="small"
            icon={<IconPlay />}
            loading={starting === k.id}
            disabled={k.checking}
            onClick={() => void checkOne(k)}
          >
            检测
          </Button>
          <Dropdown
            position="bottomRight"
            trigger="click"
            clickToHide
            render={
              <Dropdown.Menu>
                <Dropdown.Item icon={<IconSetting />} onClick={() => setModelTarget(k)}>
                  检测用的模型
                </Dropdown.Item>
                <Dropdown.Item icon={<IconKey />} onClick={() => setReplaceTarget(k)}>
                  重新取密钥
                </Dropdown.Item>
                <Dropdown.Divider />
                <Dropdown.Item icon={<IconDelete />} type="danger" disabled={k.checking} onClick={() => void remove(k)}>
                  移除
                </Dropdown.Item>
              </Dropdown.Menu>
            }
          >
            <Button theme="borderless" size="small" icon={<IconMore />} aria-label="更多操作" />
          </Dropdown>
        </div>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader
        title="降智检测"
        description={
          <>
            用一道糖果题（正确答案 21）检测中转站的 GPT 有没有被降智。每轮先问一次，和已确认的状态不一样时再问两次，三次一致才改状态；确认降智和恢复时发通知。
            <span style={{ display: "block" }}>
              {cron ? (
                describeCron(cron) ? (
                  `定时巡检：${describeCron(cron)}。`
                ) : (
                  <>
                    定时巡检：<span className="mono">{cron}</span>。
                  </>
                )
              ) : (
                "没开定时巡检，可以在设置页的“降智巡检”选周期。"
              )}
              {defaults ? `备选模型 ${defaults.models.join("、")}，推理强度 ${degradeEffortLabel(defaults.effort)}。` : ""}
            </span>
          </>
        }
        actions={
          <>
            <Button
              icon={<IconPlay />}
              loading={starting === "all"}
              disabled={items.length === 0 || allRunning}
              onClick={() => void checkAll()}
            >
              {allRunning ? "全部检测中" : "全部检测"}
            </Button>
            <Button theme="solid" icon={<IconPlus />} onClick={() => setAdding(true)}>
              加入密钥
            </Button>
          </>
        }
      />
      <RunningJobs jobs={running} />
      <Card bodyStyle={{ padding: 0 }}>
        <Table<DegradeKey>
          rowKey="id"
          size={isMobile ? "small" : "default"}
          columns={columns}
          dataSource={items}
          loading={keys.loading}
          scroll={{ x: 900 }}
          pagination={false}
          // 第一列是多行内容，展开按钮单独占一列，免得挤到名称上面
          hideExpandedColumn={false}
          expandedRowRender={(k) => (k ? <CheckHistory key={`${k.id}:${k.last_checked_at ?? ""}`} k={k} /> : null)}
          empty={keys.error ?? "还没有加入检测的密钥，点右上角“加入密钥”从渠道里挑。"}
        />
      </Card>

      <DegradeAddModal visible={adding} onClose={() => setAdding(false)} onAdded={() => keys.refetch()} />
      <DegradeModelModal
        target={modelTarget}
        defaults={defaults}
        onClose={() => setModelTarget(null)}
        onSaved={() => keys.refetch()}
      />
      <DegradeReplaceKeyModal target={replaceTarget} onClose={() => setReplaceTarget(null)} onSaved={() => keys.refetch()} />
    </div>
  )
}
