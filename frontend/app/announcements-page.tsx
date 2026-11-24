import { lazy, Suspense, useMemo, useState } from "react"
import { Chip, EmptyState, Link, Modal, ScrollShadow, Separator, Spinner, Surface, Table, Tooltip } from "@heroui/react"
import { PageHeader } from "@/components/layout/page-header"
import { PaginationBar } from "@/components/common/pagination-bar"
import type { UpstreamAnnouncement } from "@/lib/api-types"
import { channelTypeLabel, dateTime, fullDateTime, relativeTime } from "@/lib/format"
import { useAnnouncements, useChannels } from "@/lib/queries"
import { useIsMobile } from "@/hooks/use-mobile"

const Markdown = lazy(() => import("@/components/common/markdown"))

const PAGE_SIZE = 20

/** 公告标题：没有标题时取正文前 32 个字。 */
function announcementTitle(item: UpstreamAnnouncement): string {
  const title = item.title?.trim()
  if (title) return title
  const content = item.content.trim()
  if (!content) return "上游公告"
  const chars = Array.from(content)
  return chars.length > 32 ? `${chars.slice(0, 32).join("")}...` : content
}

export default function AnnouncementsPage() {
  const isMobile = useIsMobile()
  const [page, setPage] = useState(1)
  const [active, setActive] = useState<UpstreamAnnouncement | null>(null)
  const announcements = useAnnouncements(page, PAGE_SIZE)
  const channels = useChannels()
  const channelMap = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c] as const)), [channels.data])

  const channelText = (id: number) => {
    const ch = channelMap.get(id)
    return ch ? `${ch.name} · ${channelTypeLabel(ch.type)}` : `渠道 #${id}`
  }

  const data = announcements.data
  const items = data?.items ?? []
  const total = data?.total ?? 0
  const loading = announcements.loading && !data

  return (
    <div className="page">
      <PageHeader title="上游公告" description="采集时从各渠道拉取的公告；在渠道设置里可以关掉某个渠道的公告。" />

      {loading ? (
        <Surface className="flex justify-center rounded-[20px] py-16">
          <Spinner />
        </Surface>
      ) : (
        <Table className={`transition-opacity ${announcements.stale ? "opacity-60" : "opacity-100"}`}>
          <Table.ScrollContainer>
            <Table.Content aria-label="上游公告列表" className="min-w-[700px]">
              <Table.Header>
                <Table.Column isRowHeader>标题</Table.Column>
                <Table.Column className="w-56">渠道</Table.Column>
                <Table.Column className="w-28">类型</Table.Column>
                <Table.Column className="w-36">发布时间</Table.Column>
              </Table.Header>
              <Table.Body
                items={items}
                renderEmptyState={() => <EmptyState className="py-12 text-sm text-muted">暂无上游公告</EmptyState>}
              >
                {(r) => {
                  const when = r.published_at || r.first_seen_at
                  const title = announcementTitle(r)
                  return (
                    <Table.Row key={r.id} id={r.id} className="cursor-pointer" onAction={() => setActive(r)}>
                      <Table.Cell>
                        <Link
                          onPress={() => setActive(r)}
                          className="block max-w-[480px] text-sm font-medium text-accent no-underline hover:underline"
                        >
                          <span className="block truncate" title={title}>
                            {title}
                          </span>
                        </Link>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="text-sm text-foreground">{channelText(r.channel_id)}</span>
                      </Table.Cell>
                      <Table.Cell>
                        {r.type ? (
                          <Chip size="sm" variant="soft">
                            {r.type}
                          </Chip>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Tooltip>
                          <Tooltip.Trigger className="inline-flex">
                            <span className="text-xs text-muted">{relativeTime(when)}</span>
                          </Tooltip.Trigger>
                          <Tooltip.Content>{fullDateTime(when)}</Tooltip.Content>
                        </Tooltip>
                      </Table.Cell>
                    </Table.Row>
                  )
                }}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
          {total > PAGE_SIZE ? (
            <Table.Footer>
              <PaginationBar
                page={page}
                total={total}
                pageSize={PAGE_SIZE}
                onChange={setPage}
                compact={isMobile}
              />
            </Table.Footer>
          ) : null}
        </Table>
      )}

      <Modal.Backdrop isOpen={active !== null} onOpenChange={(open) => !open && setActive(null)}>
        <Modal.Container size="lg" scroll="inside" className="w-[min(720px,calc(100vw-24px))] max-w-none">
          <Modal.Dialog className="w-full max-w-none">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{active ? announcementTitle(active) : ""}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="pb-6">
              {active ? (
                <ScrollShadow className="max-h-[65vh] pr-1">
                  <div className="row flex-wrap">
                    <Chip size="sm" variant="soft">
                      {channelText(active.channel_id)}
                    </Chip>
                    {active.type ? (
                      <Chip size="sm" variant="soft" color="accent">
                        {active.type}
                      </Chip>
                    ) : null}
                    <span className="num text-xs text-muted">
                      {dateTime(active.published_at || active.first_seen_at)}
                    </span>
                  </div>
                  <Separator className="my-3" />
                  <Suspense fallback={<Spinner size="sm" />}>
                    <Markdown content={active.content || "—"} />
                  </Suspense>
                  {active.link ? (
                    <>
                      <Separator className="my-3" />
                      <Link
                        href={active.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-xs text-accent"
                      >
                        {active.link}
                      </Link>
                    </>
                  ) : null}
                </ScrollShadow>
              ) : null}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  )
}
