/**
 * Semi 把一些按钮、图标的读屏名称写死成英文：弹窗的 confirm / cancel / close、分页的 Previous / Next、
 * 表格的 Expand this row、标签的 Tag: xxx 等，LocaleProvider 管不到。这里盯着页面，把这些名称换成中文；
 * 弹窗底部的确定、取消按钮直接用按钮上的文字（比如“同步”“删除”）。
 * 图标默认拿图标名（home、refresh 这类）当名称，而图标旁边都有文字或按钮自己的名称，按装饰处理，读屏跳过。
 */
const fixed = new Map<string, string>([
  ["close", "关闭"],
  ["Close", "关闭"],
  ["Expand this row", "展开或收起这一行"],
  ["Filter data with this column", "按这一列筛选"],
  ["Select all rows", "全选"],
  ["Deselect all rows", "取消全选"],
  ["Select this row", "选中这一行"],
  ["Deselect this row", "取消选中这一行"],
  ["Previous", "上一页"],
  ["Next", "下一页"],
  ["More", "更多页码"],
  ["Page size selector", "每页条数"],
  ["Use the input box to create an optional item", "用输入的内容新建选项"],
  ["selected", "已选"],
  ["Input group", "输入框组"],
  ["input value", "输入内容"],
  ["Toggle the checked state of checkbox", "勾选或取消勾选"],
  ["Show password", "显示密码"],
  ["Hidden password", "隐藏密码"],
  ["info", "提示"],
  ["success", "成功"],
  ["warning", "警告"],
  ["danger", "错误"],
  ["default type", "提示"],
  ["info type", "提示"],
  ["success type", "成功"],
  ["warning type", "警告"],
  ["error type", "错误"],
])

const fromText = new Map<string, string>([
  ["confirm", "确定"],
  ["cancel", "取消"],
])

function translate(el: Element) {
  const label = el.getAttribute("aria-label")
  if (!label) return
  let next = fixed.get(label)
  if (!next && fromText.has(label)) next = el.textContent?.trim() || fromText.get(label)
  if (!next) {
    const page = /^Page (\d+)$/.exec(label)
    if (page) next = `第 ${page[1]} 页`
  }
  if (!next) {
    const tag = /^(Closable )?Tag: (.*)$/.exec(label)
    if (tag) next = `${tag[1] ? "可关闭的标签" : "标签"}：${tag[2]}`
  }
  if (!next && el.classList.contains("semi-icon")) {
    el.setAttribute("aria-hidden", "true")
    return
  }
  // 换成的中文不在表里，再触发一次也不会改，不会循环
  if (next && next !== label) el.setAttribute("aria-label", next)
}

function scan(root: Element) {
  translate(root)
  root.querySelectorAll("[aria-label]").forEach(translate)
}

new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === "attributes") translate(r.target as Element)
    else r.addedNodes.forEach((n) => n instanceof Element && scan(n))
  }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label"] })

scan(document.body)
