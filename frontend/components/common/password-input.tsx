import { useState, type ComponentProps } from "react"
import { Button, InputGroup } from "@heroui/react"
import { Eye, EyeSlash } from "@gravity-ui/icons"

/** 带显隐切换的密码输入框（配合 HeroUI TextField 使用）。 */
export function PasswordInput({
  variant,
  fullWidth,
  className,
  ...inputProps
}: Omit<ComponentProps<typeof InputGroup.Input>, "type" | "className"> & {
  variant?: ComponentProps<typeof InputGroup>["variant"]
  fullWidth?: boolean
  className?: string
}) {
  const [visible, setVisible] = useState(false)

  return (
    <InputGroup variant={variant} fullWidth={fullWidth} className={className}>
      <InputGroup.Input {...inputProps} type={visible ? "text" : "password"} />
      <InputGroup.Suffix className="pr-1">
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={visible ? "隐藏内容" : "显示内容"}
          onPress={() => setVisible((v) => !v)}
        >
          {visible ? <EyeSlash className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </InputGroup.Suffix>
    </InputGroup>
  )
}
