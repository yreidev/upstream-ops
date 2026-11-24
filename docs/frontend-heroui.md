# 前端改用 HeroUI React v3

2026-11-24 定下：前端从 Semi Design（`@douyinfe/semi-ui`）+ VChart（`@visactor/*`）全面迁移至官方开源 [HeroUI React v3](https://www.heroui.com)（`@heroui/react` + `@heroui/styles` + Tailwind CSS v4）。同时移除与 CCHP 重叠的“CCH 成本倍率同步”与“GPT 降智检测”功能，保留其余 9 个核心页面，后端接口契约保持不变。整体布局层级参考 HeroUI Pro v3 仪表盘美学，全部使用开源 `@heroui/react` 组件实现，不引入闭源商业包。

## 技术选型

| 项 | 方案 |
|---|---|
| 组件库与主题 | `@heroui/react` + `@heroui/styles` + `tailwindcss` v4 + `@tailwindcss/vite`（纯亮色模式） |
| 图标 | `@gravity-ui/icons` |
| 图表 | `recharts`（余额与消费双轴折线图，仅总览页按需加载） |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-raw` + `rehype-sanitize`（GitHub 白名单，按需加载） |
| 国际化与日期时间 | `@heroui/react` 内置 `I18nProvider locale="zh-CN"` + `@internationalized/date`（Cron 选择器时间段输入） |
| 弹窗、抽屉与提示 | HeroUI `Modal`、`Drawer`、`AlertDialog`（全局 `ConfirmDialog`）、`Toast.Provider` + `toast` |
| 二维码 | 继续使用 `qrcode`（充值扫码弹窗） |

## 保留页面（9 页）

| 页面 | 路由 | 内容 |
|---|---|---|
| 总览 | `/` | 指标卡（`Card.Header`/`Title`/`Content`）、近 7 天余额与消费双轴折线图（Recharts + `Surface` 浮层提示）、最近倍率变动、最近通知（`Accordion` 原地展开正文） |
| 渠道 | `/channels` | 渠道列表（桌面 `.expandable-table` + `Disclosure` 展开行，移动端 `Card`）、搜索/状态/标签筛选、排序、分页、同步/全部同步、新增/编辑与测试登录（`TextField`/`TagGroup`/`Switch`）、分组倍率抽屉、全部分组弹窗、上游 API 密钥管理抽屉（`Table` 单行选择迁移）、充值、兑换码 |
| 倍率变化 | `/rates` | 分组倍率变更流水（独立 `Table` + `Table.Footer` 分页），按渠道筛选 |
| 上游公告 | `/announcements` | 各渠道拉取的公告列表（独立 `Table` + `Link` 触发）与 `ScrollShadow` Markdown 详情弹窗 |
| 通知 | `/notifications` | Telegram / 企业微信通知渠道管理（独立 `Table`）、订阅规则编辑器与 `Accordion` 可展开发送记录 |
| 打码平台 | `/captcha` | YesCaptcha 配置管理（独立 `Table`）与余额刷新 |
| 后台任务 | `/jobs` | 手动同步/测试登录及定时任务的执行历史（`.expandable-table` + `Accordion` 按需轮询分步事件） |
| 监控日志 | `/monitor-logs` | 每次登录/会话/余额/消费/倍率采集日志（独立 `Table` + `Table.Footer` 分页），按渠道/任务/结果/条数筛选 |
| 设置 | `/settings` | 应用信息与版本检查、登录鉴权、调度与保留策略（可视化 Cron 选择器）、通知策略、上游请求参数、环境变量锁定提示与 `Surface` 底部吸底保存栏 |

## 关键实现说明

- **CSS 导入顺序**：`frontend/app/globals.css` 严格先 `@import "tailwindcss";` 再 `@import "@heroui/styles";`，避免样式层优先级异常。
- **纯亮色主题**：`frontend/index.html` 固定 `<html lang="zh-CN" class="light" data-theme="light">`，`globals.css` 固定 `color-scheme: light`，去除暗色模式切换逻辑与 `lib/theme.ts`。白底 `Card` / `Modal` / `Drawer` 内的表单控件统一使用 `variant="secondary"`，浅灰主画布上的独立列表直接使用 `Table`（`primary` 嵌套卡片样式，不再外包一层 `Card`），避免双层卡片嵌套。
- **细圆角滚动条与滚动阴影**：`frontend/app/globals.css` 通过 `@supports selector(::-webkit-scrollbar)` 在 Chromium/WebKit 下将 HeroUI 内置 `--scrollbar-width` / `--scrollbar-color` 复位为 `auto`，确保全站滚动容器统一命中 6px 透明轨道、半透明圆角滑块且隐藏系统原生箭头按钮的 `::-webkit-scrollbar` 样式；Firefox 走 `@supports not selector(::-webkit-scrollbar)` 下的 `scrollbar-width: thin`（排除浮层遮罩以避免影响点击关闭）。侧边栏导航、长列表与弹窗正文搭配 HeroUI `ScrollShadow`。
- **可展开详情面板**：HeroUI v3 `Table`（基于 React Aria Table）不支持跨列 `colSpan` 展开行。普通数据表直接使用官方 `Table` 并在 `Table.Footer` 内放置 `PaginationBar`；需要整行宽度展开复杂详情的区域（渠道同步进度与报错、通知发送正文、后台任务分步事件）采用与 `Table primary` 视觉对齐的 `.expandable-table` 容器，配合官方 `Disclosure` / `Accordion` 实现，页面与业务组件中不使用裸 HTML `<button>` / `<input>` 或 `role="button"`。
- **组件复合结构注意点（HeroUI v3.2.8）**：
  - `Switch` 与 `Checkbox` 的交互控件位于 `Switch.Content` / `Checkbox.Content` 内，包装 `Control` 与标签文本。
  - `Drawer` 自定义宽度写在 `Drawer.Dialog` 上，`Drawer.Content` 保留全屏 Flex 定位容器。
  - `Dropdown` 和 `Tooltip` 若直接包在 HeroUI `Button` 外层，直接以 `Button` 作为触发子元素，避免在 `button` 内再嵌 `button`；非按钮元素再使用 `Tooltip.Trigger`。
  - 浮层层级：所有 `Modal`、`Drawer`、`AlertDialog` 及 `Select`/`Dropdown`/`Tooltip` 统一遵循 HeroUI v3 原生 `--z-index-overlay: 100000`（`Toast` 为 `100001`），不要手写低层级 `z-*` 覆盖；由 React Aria portal 挂载顺序自动保证后打开的抽屉（如从“全部分组”弹窗打开的 `ChannelAPIKeysSheet`）、下拉菜单与全局 `ConfirmDialog` 始终位于最上层。
  - 读屏与无障碍：不再需要 Semi 专用的 `lib/aria-labels.ts` DOM 补丁；所有图标按钮均提供明确中文 `aria-label`，外层统一包裹 `<I18nProvider locale="zh-CN">`。
- **分块策略**：`frontend/vite.config.ts` 按路由懒加载各页面，并将 `d3-*` 图形辅助库与 `react-markdown`/`remark`/`rehype` 拆出独立 chunk，控制主包体积。
