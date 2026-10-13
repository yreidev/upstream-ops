import { useEffect, useRef } from "react"
import { Banner } from "@douyinfe/semi-ui"

/** 表单底部的报错。长表单里报错在可滚动区域最下面，出现时自动滚到看得见的位置。 */
export function FormError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [message])

  if (!message) return null
  return (
    <div ref={ref}>
      <Banner fullMode={false} type="danger" closeIcon={null} description={message} />
    </div>
  )
}
