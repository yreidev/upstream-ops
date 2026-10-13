import { Button, Empty } from "@douyinfe/semi-ui"
import { IllustrationNotFound, IllustrationNotFoundDark } from "@douyinfe/semi-illustrations"
import { Link } from "react-router-dom"

export default function NotFoundPage() {
  return (
    <Empty
      image={<IllustrationNotFound style={{ width: 150, height: 150 }} />}
      darkModeImage={<IllustrationNotFoundDark style={{ width: 150, height: 150 }} />}
      title="页面不存在"
      style={{ marginTop: 80 }}
    >
      <Link to="/">
        <Button theme="solid">回到总览</Button>
      </Link>
    </Empty>
  )
}
