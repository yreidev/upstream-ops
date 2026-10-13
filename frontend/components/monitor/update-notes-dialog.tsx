import { lazy, Suspense } from "react"
import { ExternalLink } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { AppVersion } from "@/lib/api-types"
import { fullDate } from "@/lib/format"

const ReleaseNotesMarkdown = lazy(() => import("./release-notes-markdown"))

/** 检测到新版本时展示从当前版本到最新版本之间各版本的更新日志。 */
export function UpdateNotesDialog({
  open,
  onOpenChange,
  version,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  version: AppVersion | null | undefined
}) {
  const notes = version?.release_notes ?? []
  const releaseURL =
    version?.release_url?.trim() || version?.repo_url?.trim() || "https://github.com/yreidev/upstream-ops"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>发现新版本 {version?.latest_version}</DialogTitle>
          <DialogDescription>
            当前版本 v{version?.version}，下面是之后各版本的更新内容，升级前请留意“升级前注意”。
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-5">
          {notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有取到更新日志，请到发布页查看。</p>
          ) : (
            notes.map((note) => (
              <section key={note.version} className="space-y-2">
                <div className="flex items-baseline gap-2 border-b border-border pb-1.5">
                  <a
                    href={note.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-base font-semibold text-foreground underline-offset-2 hover:underline"
                  >
                    {note.version}
                  </a>
                  {note.published_at ? (
                    <span className="text-xs text-muted-foreground">{fullDate(note.published_at)}</span>
                  ) : null}
                </div>
                {note.notes ? (
                  <Suspense fallback={<p className="text-sm text-muted-foreground">加载中...</p>}>
                    <ReleaseNotesMarkdown>{note.notes}</ReleaseNotesMarkdown>
                  </Suspense>
                ) : (
                  <p className="text-sm text-muted-foreground">这个版本没有写更新日志。</p>
                )}
              </section>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button asChild>
            <a href={releaseURL} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" />
              去发布页
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
