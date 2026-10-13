import { lazy, Suspense } from "react"
import { Button, Empty, Modal, Spin, Typography } from "@douyinfe/semi-ui"
import { IconExternalOpen } from "@douyinfe/semi-icons"
import type { AppVersion } from "@/lib/api-types"
import { fullDate } from "@/lib/format"

const Markdown = lazy(() => import("@/components/common/markdown"))

/** 检测到新版本时展示当前版本之后各版本的更新日志。默认导出，由页头按需加载。 */
export default function UpdateNotesModal({ visible, onClose, version }: {
  visible: boolean
  onClose: () => void
  version: AppVersion | null | undefined
}) {
  const notes = version?.release_notes ?? []
  const releaseURL =
    version?.release_url?.trim() || version?.repo_url?.trim() || "https://github.com/yreidev/upstream-ops"

  return (
    <Modal
      visible={visible}
      onCancel={onClose}
      title={`发现新版本 ${version?.latest_version ?? ""}`}
      width={720}
      bodyStyle={{ maxHeight: "65vh", overflowY: "auto" }}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button
            theme="solid"
            icon={<IconExternalOpen />}
            onClick={() => window.open(releaseURL, "_blank", "noopener,noreferrer")}
          >
            去发布页
          </Button>
        </>
      }
    >
      <Typography.Text type="tertiary">
        当前版本 v{version?.version}，下面是之后各版本的更新内容，升级前请留意“升级前注意”。
      </Typography.Text>
      {notes.length === 0 ? (
        <Empty description="没有取到更新日志，请到发布页查看。" style={{ padding: 24 }} />
      ) : (
        notes.map((note) => (
          <section key={note.version} style={{ marginTop: 16 }}>
            <div
              className="row"
              style={{ alignItems: "baseline", borderBottom: "1px solid var(--semi-color-border)", paddingBottom: 6 }}
            >
              <Typography.Title heading={5} style={{ margin: 0 }}>
                <Typography.Text link={{ href: note.url, target: "_blank", rel: "noopener noreferrer" }}>
                  {note.version}
                </Typography.Text>
              </Typography.Title>
              {note.published_at ? (
                <Typography.Text type="tertiary" size="small">
                  {fullDate(note.published_at)}
                </Typography.Text>
              ) : null}
            </div>
            {note.notes ? (
              <Suspense fallback={<Spin />}>
                <Markdown content={note.notes} />
              </Suspense>
            ) : (
              <Typography.Text type="tertiary">这个版本没有写更新日志。</Typography.Text>
            )}
          </section>
        ))
      )}
    </Modal>
  )
}
