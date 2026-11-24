import { Pagination } from "@heroui/react"

function buildPages(current: number, totalPages: number): (number | "ellipsis-left" | "ellipsis-right")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const pages: (number | "ellipsis-left" | "ellipsis-right")[] = [1]
  if (current > 3) pages.push("ellipsis-left")
  const start = Math.max(2, current - 1)
  const end = Math.min(totalPages - 1, current + 1)
  for (let p = start; p <= end; p++) pages.push(p)
  if (current < totalPages - 2) pages.push("ellipsis-right")
  pages.push(totalPages)
  return pages
}

/** 统一分页栏：总条数不足一页时自动隐藏，支持省略号与汇总信息。 */
export function PaginationBar({
  page,
  total,
  pageSize,
  onChange,
  compact = false,
}: {
  page: number
  total: number
  pageSize: number
  onChange: (page: number) => void
  compact?: boolean
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (totalPages <= 1) return null

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  const items = buildPages(page, totalPages)

  return (
    <Pagination size="sm" className="w-full justify-between gap-2">
      {!compact ? (
        <Pagination.Summary className="num text-xs text-muted">
          第 {start}-{end} 条，共 {total} 条
        </Pagination.Summary>
      ) : (
        <Pagination.Summary className="num text-xs text-muted">
          {page} / {totalPages}
        </Pagination.Summary>
      )}
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous
            isDisabled={page <= 1}
            onPress={() => {
              if (page > 1) onChange(page - 1)
            }}
          >
            <Pagination.PreviousIcon />
            {!compact ? <span>上一页</span> : null}
          </Pagination.Previous>
        </Pagination.Item>
        {!compact
          ? items.map((item) =>
              typeof item === "number" ? (
                <Pagination.Item key={item}>
                  <Pagination.Link
                    isActive={item === page}
                    onPress={() => {
                      if (item !== page) onChange(item)
                    }}
                  >
                    {item}
                  </Pagination.Link>
                </Pagination.Item>
              ) : (
                <Pagination.Item key={item}>
                  <Pagination.Ellipsis />
                </Pagination.Item>
              ),
            )
          : null}
        <Pagination.Item>
          <Pagination.Next
            isDisabled={page >= totalPages}
            onPress={() => {
              if (page < totalPages) onChange(page + 1)
            }}
          >
            {!compact ? <span>下一页</span> : null}
            <Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  )
}
