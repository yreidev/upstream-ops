# 前端改用 Semi Design

2026-10-13 定下：前端整体改用 [Semi Design](https://semi.design)（`@douyinfe/semi-ui`），不再用 shadcn/ui + Radix + Tailwind。打包体积变大可以接受。功能与现有前端一致，后端接口不变。

## 已定的方案

| 项 | 决定 |
|---|---|
| 布局 | 左侧导航，按功能分页；窄屏时导航收进抽屉 |
| 页面 | 总览、渠道、倍率变化、上游公告、通知、打码平台、设置、监控日志，共 8 页 |
| 渠道列表 | 桌面端用表格加展开行，窄屏用卡片 |
| 图表 | VChart（`@visactor/react-vchart`）+ `@visactor/vchart-semi-theme` |
| Markdown | Semi 的 `MarkdownRender`，`format="md"` 加 HTML 白名单过滤，按需加载 |
| 图标、提示、弹窗 | 全部用 Semi 自带的：`@douyinfe/semi-icons`、`Toast`、`Modal`、`SideSheet` |

## 页面与现有功能的对应

| 页面 | 路由 | 内容（括号里是现有组件） |
|---|---|---|
| 总览 | `/` | 指标卡（`kpi-row`）、余额走势图（`balance-overview`）、最近倍率变化前几条、最近通知前几条，各自带“查看全部”跳到对应页 |
| 渠道 | `/channels` | 渠道列表（`channel-cards`）：搜索、状态和标签筛选、排序、分页；同步、测试登录、编辑、删除、充值、兑换、清空登录信息、密钥管理；新增渠道 |
| 倍率变化 | `/rates` | 全部倍率变化（`multiplier-changes` 的“查看全部”弹窗内容） |
| 上游公告 | `/announcements` | 公告列表与详情（`bottom-panels` 的 `UpstreamAnnouncements`） |
| 通知 | `/notifications` | 通知渠道的增删改、测试（`NotificationStatus`、`notification-form-dialog`）和发送记录（`AlertFeed`） |
| 打码平台 | `/captcha` | YesCaptcha 配置与余额（`CaptchaStatus`、`captcha-form-dialog`） |
| 设置 | `/settings` | 应用信息与检测更新、登录鉴权、调度与保留策略、通知策略、上游请求，保存与应用。现在设置页里重复的“通知渠道”“验证码服务”两块不再放这里，只在各自页面 |
| 监控日志 | `/monitor-logs` | 新页面，读现有的 `GET /api/monitor-logs?channel_id=&limit=`，可按渠道筛选 |

### 渠道表格

- 列：渠道、类型、余额、今日累计、状态、更新时间、操作。
- 展开行：分组倍率（可在这里建密钥、迁移密钥）、备注、完整报错。
- 窄屏（与 Semi 的断点一致）改用卡片，字段和操作与表格相同。

### 页头

版本号、“有新版本”标签（点开显示更新日志）、上次采集时间、手动刷新、亮色和暗色切换、GitHub 链接。登录页单独一页，不显示导航。

## 技术要点

- **React 19**：入口第一行引入 `@douyinfe/semi-ui/react19-adapter`。
- **中文**：用 `LocaleProvider` 设为 `zh_CN`。
- **暗色**：Semi 靠 `body` 上的 `theme-mode="dark"` 切换。选择存在 `localStorage`，可选“跟随系统”，在 React 渲染前就设好，避免闪一下亮色。
- **图表**：入口调用 `initVChartSemiTheme({ isWatchingMode: true })`，图表就会跟着 Semi 的亮色和暗色走。但主题包 1.13.1 配 VChart 2.1.7 时，暗色下横轴（分类轴）的标签仍是亮色主题的深灰字，纵轴正常，实测确认过。解决办法：用一个公共图表组件，按当前主题在配置里写明坐标轴文字颜色，并在主题变化时重新挂载图表。目前只在面积图上测过，其他图表类型未确认。
- **按路由拆分**：每页用 `React.lazy` 加载。VChart 只有总览页用，打开总览页才加载。
- **Markdown**：上游公告来自第三方站点，属于不可信内容；内容里可能夹着 HTML（线上数据里有没有未确认）。做法是 `format="md"` 按纯 Markdown 编译（不执行 MDX 表达式），再用 `rehype-raw` 解析 HTML、`rehype-sanitize`（GitHub 同款白名单）过滤：`<script>`、事件属性、`style`、`javascript:` 链接都会去掉，排版标签保留，实测过。链接统一新窗口打开，带 `rel="noopener noreferrer"`。现在上游公告用的手写解析和 `react-markdown` 一起删掉。
- **样式**：不用 Tailwind。只用 Semi 组件的属性和它的 CSS 变量（如 `var(--semi-color-text-2)`），少量布局写在一个全局 CSS 文件里。

## 保留和删除

以下文件保留，只改用法，不改行为：`lib/api.ts`（`apiFetch`、`uh_token`、401 回登录页）、`lib/api-types.ts`、`lib/queries.ts`、`lib/sync-stream.ts`、`lib/auth-context.tsx`、`lib/refresh-context.tsx`、`lib/format.ts`、`lib/clipboard.ts`，以及 `react-router-dom` 和 `qrcode`（充值二维码，Semi 没有二维码组件）。新增 `@douyinfe/semi-ui`、`@douyinfe/semi-icons`、`@douyinfe/semi-illustrations`、VChart 三个包、`rehype-raw`、`rehype-sanitize`。

删除 `components/ui/` 整个目录、`components.json`、`app/globals.css` 里 Tailwind 的部分，以及这些依赖：所有 `@radix-ui/*`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`、`next-themes`、`sonner`、`react-markdown`、`recharts`、`@fontsource-variable/*`、`tailwindcss`、`@tailwindcss/vite`、`tw-animate-css`。另外删掉 `frontend/package-lock.json`：构建和 CI 都用 pnpm，这个文件从 v0.0.7 起就没再更新过。

## 做法

1. 在 main 上开分支，直接改写 `frontend/`，不另建目录。演示版（`semi-demo` 分支的 `frontend-semi/`）里的布局和组件拿来参考。
2. 按页面逐个迁移，每迁完一页跑 `pnpm lint`、`pnpm exec tsc --noEmit`、`pnpm build`。
3. 全部迁完后，在亮色、暗色、桌面、窄屏下逐页截图核对，并把上面表格里的每个操作都走一遍。
4. 在 `docs/CHANGELOG.md` 的“未发布”下记录，作为 v0.4.0 发布。

## 实现时的调整

和上面方案不一样、或者方案里没写到的地方：

- **VChart 主题**：`initVChartSemiTheme` 放在图表组件里调用，不在入口，这样只有打开总览页才加载图表相关的包。
- **登录页按需加载**：登录页用了 `Form`，`Form` 会连带打包日期、上传等全部表单控件，所以登录页和 404 页也用 `React.lazy` 拆出去。入口包从 989 KB（gzip 273 KB）降到 326 KB（gzip 100 KB）。
- **全部分组**：上面表格漏了旧版渠道列表上方的“分组”按钮（所有渠道的分组倍率放在一张表里比较），新版保留，按钮改名“全部分组”。

### Semi 的坑与全局补丁

- **表格宽度**：设了 `scroll.x` 的 `Table` 会被写死成 x 那么宽，Semi 只给固定列布局补了 `min-width: 100%`。`globals.css` 里给 `.semi-table` 统一补上，容器更宽时铺满。
- **弹窗宽度**：`Modal` 的 `width` 按桌面写死，手机上会被裁掉。`globals.css` 里给 `.semi-modal` 加了 `max-width: calc(100vw - 24px)`。
- **展开行按钮**：默认塞进第一列，会被多行的渠道信息挤到上面，所以渠道表格用 `hideExpandedColumn={false}` 让它单独占一列。
- **Banner**：默认是通栏样式（文字居中、没有圆角），放在卡片和弹窗里不好看，全部写成 `fullMode={false}`。
- **表单报错**：长表单里报错在可滚动区域最下面，看不到。统一用 `components/common/form-error.tsx`，出现时自动滚到看得见的位置。
- **Markdown 表格**：`MarkdownRender` 默认把 Markdown 表格渲染成带分页器的数据表格，公告里改成不分页的小表格。
- **下拉菜单**：`Dropdown` 默认点菜单项后不收起，要加 `clickToHide`；放在按钮上的都用 `trigger="click"`。
- **侧边抽屉**：`SideSheet` 默认按 Esc 不关闭，保持默认，避免在抽屉里的弹窗上按 Esc 时连抽屉一起关掉。
- **Tag 省略**：`Tag` 只有子元素是纯字符串时才会超长省略，需要省略的地方要拼成一个字符串再传。
- **无障碍名称**：只有图标的按钮都加了中文 `aria-label`；Semi 自带的 `Modal` 底部按钮的 `aria-label` 写死成英文 `confirm`、`cancel`，没有改。

## 验收

- 上面表格里列的功能都在，后端没有改动。
- 亮色和暗色下文字、图表都看得清。
- 窄屏下导航和渠道列表可用。
- `pnpm lint`、`tsc`、`pnpm build` 通过，Docker 镜像能构建，CI 通过。
