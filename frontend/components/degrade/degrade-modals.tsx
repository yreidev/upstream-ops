import { useEffect, useRef, useState } from "react"
import { AutoComplete, Banner, Input, Modal, Select, Toast, Typography } from "@douyinfe/semi-ui"
import { FormError } from "@/components/common/form-error"
import { apiFetch, type ApiError } from "@/lib/api"
import type { DegradeCandidate, DegradeKey, SystemDegradeConfig } from "@/lib/api-types"
import { channelTypeLabel, formatRatio } from "@/lib/format"
import { apiKeyStatusMeta, degradeEffortLabel, degradeEfforts } from "@/lib/labels"
import { useChannels } from "@/lib/queries"

/** 站点不让接口取完整密钥时，后端返回 422 和 code=reveal_failed，页面改为让用户粘贴。 */
function isRevealFailed(err: unknown) {
  const e = err as ApiError
  return e?.status === 422 && (e.body as { code?: string } | undefined)?.code === "reveal_failed"
}

function errorText(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

/** 粘贴完整密钥的输入框和说明，加入密钥、重新取密钥共用。 */
function PasteKeyField({ reason, tail, value, onChange }: {
  reason: string
  tail?: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Banner
        fullMode={false}
        type="warning"
        closeIcon={null}
        description={`${reason}。请到站点的令牌页复制这把密钥，粘贴到下面。`}
      />
      <Input
        mode="password"
        autoComplete="new-password"
        value={value}
        onChange={onChange}
        placeholder={tail ? `完整密钥，结尾应是 ${tail}` : "完整密钥"}
      />
      <Typography.Text type="tertiary" size="small">
        加密保存在数据库里，页面不会回显；会和站点上这把密钥的尾号核对。
      </Typography.Text>
    </div>
  )
}

function candidateLabel(c: DegradeCandidate) {
  const parts = [c.name || `#${c.id}`, c.group_name || "默认分组"]
  if (c.group_ratio) parts[1] += ` ×${formatRatio(c.group_ratio)}`
  if (c.key_tail) parts.push(`尾号 ${c.key_tail}`)
  const status = c.status && c.status !== "active" ? apiKeyStatusMeta[c.status]?.label ?? c.status : ""
  if (status) parts.push(status)
  if (c.added) parts.push("已加入")
  return parts.join(" · ")
}

/** 按渠道挑一把上游密钥加入检测。完整密钥默认从渠道接口取，取不到时让用户粘贴。 */
export function DegradeAddModal({ visible, onClose, onAdded }: {
  visible: boolean
  onClose: () => void
  onAdded: () => void
}) {
  const channels = useChannels()
  const [channelId, setChannelId] = useState<number>()
  const [candidates, setCandidates] = useState<DegradeCandidate[] | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [keyId, setKeyId] = useState<number>()
  const [revealError, setRevealError] = useState<string | null>(null)
  const [pasted, setPasted] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 快速切换渠道时只认最后一次的结果
  const requestSeq = useRef(0)

  function reset() {
    requestSeq.current++
    setChannelId(undefined)
    setCandidates(null)
    setLoadingCandidates(false)
    setKeyId(undefined)
    setRevealError(null)
    setPasted("")
    setError(null)
  }

  async function pickChannel(id: number | undefined) {
    const seq = ++requestSeq.current
    setChannelId(id)
    setKeyId(undefined)
    setCandidates(null)
    setRevealError(null)
    setPasted("")
    setError(null)
    if (id == null) return
    setLoadingCandidates(true)
    try {
      const list = await apiFetch<DegradeCandidate[]>(`/degrade/candidates?channel_id=${id}`)
      if (seq === requestSeq.current) setCandidates(list)
    } catch (err) {
      if (seq === requestSeq.current) setError(`读取这个渠道的密钥失败：${errorText(err, "未知错误")}`)
    } finally {
      if (seq === requestSeq.current) setLoadingCandidates(false)
    }
  }

  async function handleOk() {
    if (channelId == null || keyId == null) {
      setError("请选择渠道和密钥")
      return
    }
    if (revealError && !pasted.trim()) {
      setError("请粘贴完整密钥")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch("/degrade/keys", {
        method: "POST",
        body: JSON.stringify({ channel_id: channelId, upstream_key_id: keyId, key: revealError ? pasted.trim() : "" }),
      })
      Toast.success("已加入，检测一轮后确定状态")
      onAdded()
      onClose()
    } catch (err) {
      if (isRevealFailed(err)) setRevealError(errorText(err, "站点拒绝"))
      else setError(errorText(err, "加入失败"))
    } finally {
      setSubmitting(false)
    }
  }

  const picked = candidates?.find((c) => c.id === keyId)

  return (
    <Modal
      visible={visible}
      title="加入降智检测"
      onCancel={onClose}
      onOk={handleOk}
      okText="加入"
      confirmLoading={submitting}
      afterClose={reset}
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="stack" style={{ gap: 4 }}>
          <Typography.Text strong>渠道</Typography.Text>
          <Select
            placeholder="选择渠道"
            filter
            value={channelId}
            onChange={(v) => void pickChannel(v == null ? undefined : Number(v))}
            style={{ width: "100%" }}
            optionList={(channels.data ?? []).map((c) => ({ value: c.id, label: `${c.name} · ${channelTypeLabel(c.type)}` }))}
            emptyContent="没有渠道"
          />
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <Typography.Text strong>密钥</Typography.Text>
          <Select
            placeholder={channelId == null ? "先选渠道" : "选择要检测的密钥"}
            filter
            disabled={channelId == null}
            loading={loadingCandidates}
            value={keyId}
            onChange={(v) => {
              setKeyId(v == null ? undefined : Number(v))
              setRevealError(null)
              setPasted("")
              setError(null)
            }}
            style={{ width: "100%" }}
            optionList={(candidates ?? []).map((c) => ({ value: c.id, label: candidateLabel(c), disabled: c.added }))}
            emptyContent={loadingCandidates ? "读取中…" : "这个渠道没有密钥"}
          />
          <Typography.Text type="tertiary" size="small">
            用 GPT 模型的分组才有意义。检测按这把密钥实际计费，每次大约 1.8 万输入 token。
          </Typography.Text>
        </div>
        {revealError ? (
          <PasteKeyField reason={revealError} tail={picked?.key_tail} value={pasted} onChange={setPasted} />
        ) : null}
        <FormError message={error} />
      </div>
    </Modal>
  )
}

/** 重新取一把密钥的完整内容：站点上换过密钥，或者当初是手动粘贴的。 */
export function DegradeReplaceKeyModal({ target, onClose, onSaved }: {
  target: DegradeKey | null
  onClose: () => void
  onSaved: () => void
}) {
  const [revealError, setRevealError] = useState<string | null>(null)
  const [pasted, setPasted] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleOk() {
    if (!target) return
    if (revealError && !pasted.trim()) {
      setError("请粘贴完整密钥")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch(`/degrade/keys/${target.id}/key`, {
        method: "PUT",
        body: JSON.stringify({ key: revealError ? pasted.trim() : "" }),
      })
      Toast.success("已更新密钥")
      onSaved()
      onClose()
    } catch (err) {
      if (isRevealFailed(err)) setRevealError(errorText(err, "站点拒绝"))
      else setError(errorText(err, "更新失败"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      visible={target != null}
      title="重新取密钥"
      onCancel={onClose}
      onOk={handleOk}
      okText={revealError ? "保存" : "从站点取"}
      confirmLoading={submitting}
      afterClose={() => {
        setRevealError(null)
        setPasted("")
        setError(null)
      }}
    >
      <div className="stack" style={{ gap: 12 }}>
        <Typography.Text>
          站点上换过这把密钥，或者检测一直报密钥无效时，用它重新取一次完整密钥。先试着从站点接口取，取不到再粘贴。
        </Typography.Text>
        {revealError ? (
          <PasteKeyField reason={revealError} tail={target?.key_tail} value={pasted} onChange={setPasted} />
        ) : null}
        <FormError message={error} />
      </div>
    </Modal>
  )
}

/** 单独给一把密钥设模型和推理强度；模型留空按设置页的备选列表挑，推理强度留空用默认值。模型列表从中转站的 /v1/models 取，不计费。 */
export function DegradeModelModal({ target, defaults, onClose, onSaved }: {
  target: DegradeKey | null
  defaults: SystemDegradeConfig | undefined
  onClose: () => void
  onSaved: () => void
}) {
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const targetId = target?.id
  useEffect(() => {
    if (targetId == null) return
    let cancelled = false
    setLoadingModels(true)
    setModelsError(null)
    apiFetch<string[]>(`/degrade/keys/${targetId}/models`)
      .then((list) => {
        if (!cancelled) setModels(list)
      })
      .catch((err) => {
        if (!cancelled) setModelsError(errorText(err, "未知错误"))
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false)
      })
    return () => {
      cancelled = true
    }
  }, [targetId])

  // 留空时按备选列表会挑哪个：排最前、分组里有的那个
  const candidates = defaults?.models ?? []
  const autoPick = candidates.find((m) => models.some((a) => a.toLowerCase() === m.toLowerCase()))
  const autoPickText = autoPick
    ? `留空时会用 ${autoPick}（备选：${candidates.join("、")}）。`
    : `备选模型（${candidates.join("、")}）分组里都没有，留空时检测会请求失败：在这里指定一个，或去设置页补备选模型。`

  // 打开时带上这把密钥现在的设置
  const [loadedFor, setLoadedFor] = useState<number | null>(null)
  if (target && loadedFor !== target.id) {
    setLoadedFor(target.id)
    setModel(target.model)
    setEffort(target.effort)
  }

  async function handleOk() {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch(`/degrade/keys/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ model: model.trim(), effort }),
      })
      Toast.success("已保存，下一轮检测起生效")
      onSaved()
      onClose()
    } catch (err) {
      setError(errorText(err, "保存失败"))
    } finally {
      setSubmitting(false)
    }
  }

  const keyword = model.trim().toLowerCase()
  const suggestions = keyword ? models.filter((m) => m.toLowerCase().includes(keyword)) : models
  const gptCount = models.filter((m) => m.toLowerCase().includes("gpt")).length

  return (
    <Modal
      visible={target != null}
      title="检测用的模型"
      onCancel={onClose}
      onOk={handleOk}
      okText="保存"
      confirmLoading={submitting}
      afterClose={() => {
        setLoadedFor(null)
        setModels([])
        setModelsError(null)
        setError(null)
      }}
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="stack" style={{ gap: 4 }}>
          <Typography.Text strong>模型</Typography.Text>
          <AutoComplete<string>
            value={model}
            data={suggestions}
            onChange={(v) => setModel(String(v ?? ""))}
            showClear
            loading={loadingModels}
            placeholder="留空按设置页的备选模型自动挑"
            style={{ width: "100%" }}
            maxHeight={280}
          />
          <Typography.Text type={modelsError ? "warning" : "tertiary"} size="small">
            {modelsError
              ? `取不到这把密钥能用的模型（${modelsError}），可以直接填模型名。`
              : loadingModels
                ? "正在读取这把密钥能用的模型…"
                : `这把密钥能用 ${models.length} 个模型${models.length ? `，其中 ${gptCount} 个带 gpt` : ""}。${autoPickText}`}
          </Typography.Text>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <Typography.Text strong>推理强度</Typography.Text>
          <Select
            value={effort}
            onChange={(v) => setEffort(String(v ?? ""))}
            style={{ width: "100%" }}
            optionList={[
              { value: "", label: `默认（${degradeEffortLabel(defaults?.effort ?? "")}）` },
              ...degradeEfforts.map((e) => ({ value: e, label: e === "none" ? "不指定（由上游决定）" : e })),
            ]}
          />
        </div>
        <FormError message={error} />
      </div>
    </Modal>
  )
}
