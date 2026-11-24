import { lazy, Suspense } from "react"
import { Button, EmptyState, Link, Modal, ScrollShadow, Separator, Spinner } from "@heroui/react"
import { ArrowUpRightFromSquare } from "@gravity-ui/icons"
import type { AppVersion } from "@/lib/api-types"
import { fullDate } from "@/lib/format"

const Markdown = lazy(() => import("@/components/common/markdown"))

/** 检测到新版本时展示当前版本之后各版本的更新日志。默认导出，由页头按需加载。 */
export default function UpdateNotesModal({
  visible,
  onClose,
  version,
}: {
  visible: boolean
  onClose: () => void
  version: AppVersion | null | undefined
}) {
  const notes = version?.release_notes ?? []
  const releaseURL =
    version?.release_url?.trim() || version?.repo_url?.trim() || "https://github.com/yreidev/upstream-ops"

  return (
    <Modal.Backdrop isOpen={visible} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog className="max-w-[720px]">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>发现新版本 {version?.latest_version ?? ""}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <ScrollShadow className="max-h-[65vh] pr-1">
              <p className="m-0 text-sm text-muted">
                当前版本 v{version?.version}，下面是之后各版本的更新内容，升级前请留意“升级前注意”。
              </p>
              {notes.length === 0 ? (
                <EmptyState className="py-8 text-sm text-muted">
                  没有取到更新日志，请到发布页查看。
                </EmptyState>
              ) : (
                <div className="mt-4 flex flex-col gap-5">
                  {notes.map((note) => (
                    <section key={note.version}>
                      <div className="flex items-baseline gap-2">
                        <h3 className="m-0 text-base font-semibold">
                          <Link href={note.url} target="_blank" rel="noopener noreferrer" className="text-accent">
                            {note.version}
                          </Link>
                        </h3>
                        {note.published_at ? (
                          <span className="num text-xs text-muted">{fullDate(note.published_at)}</span>
                        ) : null}
                      </div>
                      <Separator className="my-2" />
                      {note.notes ? (
                        <Suspense fallback={<Spinner size="sm" />}>
                          <Markdown content={note.notes} />
                        </Suspense>
                      ) : (
                        <span className="text-sm text-muted">这个版本没有写更新日志。</span>
                      )}
                    </section>
                  ))}
                </div>
              )}
            </ScrollShadow>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" onPress={onClose}>
              关闭
            </Button>
            <Button
              variant="primary"
              onPress={() => window.open(releaseURL, "_blank", "noopener,noreferrer")}
            >
              <ArrowUpRightFromSquare className="size-4" />
              去发布页
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
