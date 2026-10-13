import { lazy, Suspense, useMemo, useState } from "react"
import { Card, Modal, Spin, Table, Tag, Tooltip, Typography } from "@douyinfe/semi-ui"
import type { ColumnProps } from "@douyinfe/semi-ui/lib/es/table"
import { PageHeader } from "@/components/layout/page-header"
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

  const columns: ColumnProps<UpstreamAnnouncement>[] = [
    {
      title: "标题",
      key: "title",
      render: (_: unknown, r: UpstreamAnnouncement) => (
        <Typography.Text link onClick={() => setActive(r)} ellipsis={{ showTooltip: true }} style={{ maxWidth: 480 }}>
          {announcementTitle(r)}
        </Typography.Text>
      ),
    },
    { title: "渠道", dataIndex: "channel_id", width: 220, render: (id: number) => channelText(id) },
    {
      title: "类型",
      dataIndex: "type",
      width: 110,
      render: (v?: string) => (v ? <Tag>{v}</Tag> : <Typography.Text type="tertiary">—</Typography.Text>),
    },
    {
      title: "发布时间",
      key: "when",
      width: 140,
      render: (_: unknown, r: UpstreamAnnouncement) => {
        const when = r.published_at || r.first_seen_at
        return (
          <Tooltip content={fullDateTime(when)}>
            <span>{relativeTime(when)}</span>
          </Tooltip>
        )
      },
    },
  ]

  const data = announcements.data
  return (
    <div className="page">
      <PageHeader title="上游公告" description="采集时从各渠道拉取的公告；在渠道设置里可以关掉某个渠道的公告。" />
      <Card bodyStyle={{ padding: 0 }}>
        <Table<UpstreamAnnouncement>
          rowKey="id"
          size={isMobile ? "small" : "default"}
          columns={columns}
          dataSource={data?.items ?? []}
          loading={announcements.loading || announcements.stale}
          scroll={{ x: 720 }}
          empty="暂无上游公告"
          onRow={(r) => ({ onClick: () => r && setActive(r), style: { cursor: "pointer" } })}
          pagination={{
            currentPage: page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            onPageChange: setPage,
            // 手机上用紧凑分页，放不下“显示第几条”
            showTotal: !isMobile,
            size: isMobile ? "small" : "default",
          }}
        />
      </Card>

      <Modal
        visible={active !== null}
        onCancel={() => setActive(null)}
        title={active ? announcementTitle(active) : ""}
        footer={null}
        width={720}
        bodyStyle={{ maxHeight: "65vh", overflowY: "auto", paddingBottom: 24 }}
      >
        {active ? (
          <>
            <div className="row" style={{ flexWrap: "wrap", marginBottom: 12 }}>
              <Tag>{channelText(active.channel_id)}</Tag>
              {active.type ? <Tag>{active.type}</Tag> : null}
              <Typography.Text type="tertiary" size="small">
                {dateTime(active.published_at || active.first_seen_at)}
              </Typography.Text>
            </div>
            <Suspense fallback={<Spin />}>
              <Markdown content={active.content || "—"} />
            </Suspense>
            {active.link ? (
              <div style={{ marginTop: 12 }}>
                <Typography.Text link={{ href: active.link, target: "_blank", rel: "noopener noreferrer" }} size="small">
                  {active.link}
                </Typography.Text>
              </div>
            ) : null}
          </>
        ) : null}
      </Modal>
    </div>
  )
}
