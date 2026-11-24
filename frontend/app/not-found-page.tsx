import { useNavigate } from "react-router-dom"
import { Button, EmptyState } from "@heroui/react"
import { CircleQuestion } from "@gravity-ui/icons"

export default function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <EmptyState className="mt-20 flex flex-col items-center gap-3 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-surface-secondary text-muted">
        <CircleQuestion className="size-7" />
      </div>
      <div className="text-base font-semibold text-foreground">页面不存在</div>
      <div className="text-sm text-muted">当前访问的地址没有对应页面。</div>
      <Button variant="primary" onPress={() => navigate("/")} className="mt-2">
        回到总览
      </Button>
    </EmptyState>
  )
}
