/**
 * API response shapes for UpstreamOps backend.
 * Keep in sync with backend/storage/*.go and backend/api/*.go.
 */

export type ChannelType = "newapi" | "sub2api"

export type CredentialMode = "password" | "token"

export type RechargeMultiplierMode = "divide" | "multiply"

export type NotificationChannelType = "telegram" | "wecom"

export type CaptchaProviderType = "yescaptcha"

/** 监控日志的任务类型（backend/storage/model.go MonitorJob*） */
export type MonitorJob = "login" | "session" | "balance" | "costs" | "rates" | "cch_sync"

export type NotificationEvent =
  | "balance_low"
  | "rate_changed"
  | "rate_structure_changed"
  | "rate_added"
  | "rate_removed"
  | "announcement"
  | "login_failed"
  | "captcha_failed"
  | "monitor_failed"
  | "recovered"
  | "cch_sync"
  | "degrade"

export interface Channel {
  id: number
  name: string
  type: ChannelType
  site_url: string
  username: string
  sort_order: number
  user_id?: string
  credential_mode: CredentialMode
  login_extra_params: string
  turnstile_enabled: boolean
  ignore_announcements: boolean
  captcha_config_id?: number | null
  balance_threshold: number
  recharge_multiplier?: number | null
  recharge_multiplier_mode: RechargeMultiplierMode
  monitor_enabled: boolean
  only_created_key_groups_enabled: boolean
  /** 自定义标签；旧后端可能缺失，按空数组处理 */
  tags?: string[]
  /** 备注；缺失按空字符串处理 */
  notes?: string
  last_balance?: number | null
  last_balance_at?: string | null
  today_cost?: number | null
  today_cost_at?: string | null
  total_cost?: number | null
  last_error?: string
  created_at: string
  updated_at: string
}

export interface ChannelPage {
  items: Channel[]
  total: number
  page: number
  page_size: number
  pages: number
}

/** GET /api/channels 分页模式的 status 筛选值（backend/storage/channel_list.go） */
export type ChannelListStatus = "healthy" | "low" | "failed" | "idle" | "paused"

/** GET /api/channels 分页模式的 sort 取值；不传即 default（sort_order DESC, id ASC） */
export type ChannelListSort = "default" | "name" | "username" | "health" | "balance"

export type ChannelListOrder = "asc" | "desc"

export interface CaptchaConfig {
  id: number
  name: string
  type: CaptchaProviderType
  endpoint?: string
  extra?: string
  enabled: boolean
  last_balance?: number | null
  balance_unit?: string
  balance_at?: string | null
  balance_error?: string
  created_at: string
  updated_at: string
}

export interface RateSnapshot {
  id: number
  channel_id: number
  remote_group_id?: number | null
  model_name: string
  description?: string
  ratio: number
  completion_ratio: number
  first_seen_at: string
  last_seen_at: string
}

export interface RateChangeLog {
  id: number
  channel_id: number
  model_name: string
  old_ratio: number | null
  new_ratio: number
  old_completion_ratio?: number | null
  new_completion_ratio?: number
  changed_at: string
}

export interface RateChangeLogPage {
  items: RateChangeLog[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface BalanceSnapshot {
  id: number
  channel_id: number
  balance: number
  sampled_at: string
}

export interface NotificationSubscription {
  channel_ids: number[]
  /** 订阅全部渠道（含之后新增的）；为 true 时忽略 channel_ids */
  all_channels?: boolean
  mode: "all" | "groups"
  groups?: string[]
  events?: NotificationEvent[]
}

export interface NotificationChannel {
  id: number
  name: string
  type: NotificationChannelType
  enabled: boolean
  subscriptions?: string
  created_at: string
  updated_at: string
}

export interface NotificationLog {
  id: number
  channel_id: number
  upstream_channel_id?: number
  channel_name?: string
  channel_type?: string
  event: NotificationEvent
  subject: string
  body: string
  success: boolean
  error_message?: string
  sent_at: string
}

export interface UpstreamAnnouncement {
  id: number
  channel_id: number
  source_key: string
  title?: string
  content: string
  type?: string
  link?: string
  published_at?: string | null
  source_updated_at?: string | null
  first_seen_at: string
}

export interface MonitorLog {
  id: number
  channel_id: number
  job: MonitorJob
  success: boolean
  error_message?: string
  duration_ms: number
  started_at: string
  finished_at: string
}

/** 后台任务（backend/storage/background_jobs.go）。 */
export type JobKind =
  | "channel_sync"
  | "channel_test_login"
  | "channel_sync_all"
  | "balance_scan"
  | "rate_scan"
  | "cch_sync"
  | "retention"
  | "degrade_check"
  | "degrade_check_all"
export type JobSource = "manual" | "scheduled"
export type JobStatus = "running" | "succeeded" | "failed" | "interrupted"

/** 任务的分步进度（backend/progress）。 */
export type ProgressStage =
  | "captcha"
  | "session"
  | "login"
  | "balance"
  | "cost"
  | "rates"
  | "degrade"
  | "done"
  | "skipped"
  | "error"

export interface ProgressEvent {
  stage: ProgressStage
  message: string
  /** 不带表示进行中。 */
  ok?: boolean
  data?: unknown
  time: string
  channel_id?: number
  channel_name?: string
  index?: number
  total?: number
}

export interface BackgroundJob {
  id: number
  kind: JobKind
  source: JobSource
  channel_id?: number
  title: string
  status: JobStatus
  message?: string
  started_at: string
  finished_at?: string
  /** 列表接口不带，单个任务和运行中列表才带。 */
  events?: ProgressEvent[]
  result?: unknown
}

export interface BackgroundJobPage {
  items: BackgroundJob[]
  total: number
  page: number
  page_size: number
  pages: number
}

/** 发起任务的返回：同一对象已有任务在跑时 started 为 false，job 是正在跑的那个。 */
export interface StartedJob {
  job: BackgroundJob
  started: boolean
}

export interface DashboardLowest {
  channel_id: number
  name: string
  balance: number | null
}

export interface DashboardChannelStat {
  id: number
  name: string
  type: string
  monitor_enabled: boolean
  last_balance?: number | null
  today_cost?: number | null
  total_cost?: number | null
  last_error?: string
}

export interface DashboardSummary {
  total_channels: number
  active_channels: number
  failed_channels: number
  total_balance: number
  today_total_cost: number
  total_cost: number
  lowest_balance: DashboardLowest | null
  channels: DashboardChannelStat[]
  recent_rate_changes: RateChangeLog[]
}

export interface BalanceTrendPoint {
  day: string
  balance: number
}

export interface CostTrendPoint {
  day: string
  cost: number
}

export interface SystemAuthConfig {
  enabled: boolean
  username: string
  password: string
  tokenSecret: string
  sessionTTLHours: number
}

export interface AppConfig {
  title: string
  notificationPrefix: string
}

export interface SystemSchedulerRetentionConfig {
  cron: string
  monitorLogsDays: number
  balanceSnapshotsDays: number
  notificationLogsDays: number
  announcementsDays: number
}

export interface SystemSchedulerConfig {
  balanceCron: string
  rateCron: string
  /** 降智巡检；空表示不定时巡检。 */
  degradeCron: string
  retention: SystemSchedulerRetentionConfig
}

export interface SystemNotificationsConfig {
  minChangePct: number
  balanceLowCooldownMinutes: number
  sendMaxAttempts: number
}

export interface SystemUpstreamConfig {
  timeoutSeconds: number
  userAgent: string
}

/** GPT 降智检测的默认模型和推理强度，单把密钥可以另设。 */
export interface SystemDegradeConfig {
  /** 备选模型，按顺序挑分组里有的第一个 */
  models: string[]
  effort: string
}

export interface SystemConfig {
  app: AppConfig
  auth: SystemAuthConfig
  scheduler: SystemSchedulerConfig
  notifications: SystemNotificationsConfig
  upstream: SystemUpstreamConfig
  degrade: SystemDegradeConfig
}

export interface SystemConfigResponse {
  config_path: string
  config: SystemConfig
  /** 由环境变量决定的配置项：路径（如 auth.enabled）→ 环境变量名 */
  env_overrides?: Record<string, string>
}

export interface AppVersion {
  name: string
  title: string
  version: string
  latest_version?: string
  update_available?: boolean
  repo_url?: string
  release_url?: string
  update_error?: string
  /** 比当前版本新的各个正式发布的更新日志，新版本在前；没有更新时不返回。 */
  release_notes?: AppReleaseNote[]
}

export interface AppReleaseNote {
  version: string
  url: string
  published_at: string
  notes: string
}

/** CCH 成本倍率同步配置（backend/cch/sync.go SettingsView），令牌只返回有没有填。 */
export interface CCHSyncSettings {
  enabled: boolean
  base_url: string
  token_set: boolean
  last_run_at?: string
  last_summary?: string
  last_error?: string
}

/** GPT 降智检测（backend/storage/degrade.go、backend/degrade/service.go）。 */
export type DegradeState = "unknown" | "normal" | "degraded"
export type DegradeResult = "correct" | "wrong" | "failed"

/** 参与检测的一把密钥；model 为空表示按备选模型列表挑，effort 为空表示用默认值。 */
export interface DegradeKey {
  id: number
  channel_id: number
  upstream_key_id: number
  name: string
  group_name: string
  key_tail: string
  key_source: "revealed" | "pasted"
  model: string
  effort: string
  state: DegradeState
  state_changed_at?: string
  last_checked_at?: string
  last_result?: DegradeResult
  last_message?: string
  /** 最近一轮答过题时用的模型 */
  last_model?: string
  created_at: string
  updated_at: string
  channel_name: string
  channel_type: ChannelType | ""
  /** 要试的模型：单独指定了就只有它，否则是备选列表 */
  models: string[]
  effective_effort: string
  /** 正在跑检测（单独检测或全部检测）。 */
  checking: boolean
}

export interface DegradeKeyList {
  items: DegradeKey[]
  defaults: SystemDegradeConfig
  /** 降智巡检 Cron，空表示没开。 */
  cron: string
}

/** 一次检测（一道题）；attempt 1 是首测，2、3 是复测。 */
export interface DegradeCheck {
  id: number
  key_id: number
  channel_id: number
  attempt: number
  model: string
  effort: string
  result: DegradeResult
  answer?: string
  error?: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  duration_ms: number
  checked_at: string
}

/** 渠道里可以加入检测的上游密钥。 */
export interface DegradeCandidate {
  id: number
  name: string
  group_name: string
  group_ratio: number
  status: string
  key_tail?: string
  added: boolean
}

/** 一把密钥一轮检测的结果，是单独检测任务的 result。 */
export interface DegradeRound {
  key_id: number
  label: string
  model: string
  effort: string
  results: DegradeResult[]
  before: DegradeState
  state: DegradeState
  changed: boolean
  message: string
  error?: string
  busy?: boolean
}

/** 一个 CCH 供应商的配对和同步结果（backend/cch/sync.go Status）。 */
export type CCHSyncStatus = "in_sync" | "pending" | "updated" | "failed" | "skipped"

export interface CCHSyncItem {
  provider_id: number
  provider_name: string
  provider_enabled: boolean
  provider_host: string
  key_tail?: string
  current: number
  channel_id?: number
  channel_name?: string
  key_name?: string
  group_name?: string
  target?: number
  status: CCHSyncStatus
  reason?: string
}

/** 一轮配对 / 同步的结果；applied 为 false 表示只是预览。 */
export interface CCHSyncResult {
  applied: boolean
  finished_at: string
  items: CCHSyncItem[]
  in_sync: number
  pending: number
  updated: number
  failed: number
  skipped: number
}

export interface ChannelRedeemResult {
  message: string
  type: string
  value: number
  new_balance?: number
  new_concurrency?: number
  group_name?: string
  validity_days?: number
}

export type RechargePaymentMethod = "alipay" | "wxpay"
export interface ChannelRechargeMethod {
  type: RechargePaymentMethod
  name: string
  min_amount: number
  max_amount: number
}

export interface ChannelRechargeInfo {
  amount_label: string
  amount_step: number
  min_amount: number
  max_amount: number
  preset_amounts: number[]
  help_text?: string
  help_image_url?: string
  alipay_force_qrcode: boolean
  methods: ChannelRechargeMethod[]
}

export interface ChannelRechargeLaunch {
  mode: "qrcode" | "redirect" | "form"
  qr_code?: string
  pay_url?: string
  form_action?: string
  form_fields?: Record<string, string>
  expires_at?: string
}

export type ChannelAPIKeyStatus = "active" | "disabled" | "expired" | "quota_exhausted" | "unknown"

export interface ChannelAPIKey {
  id: number
  key: string
  name: string
  status: ChannelAPIKeyStatus | string
  group?: string
  group_name?: string
  group_description?: string
  group_ratio: number
  group_id?: number | null
  quota: number
  quota_used: number
  unlimited_quota: boolean
  expired_time: number
  expires_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  last_used_at?: string | null
  allow_ips?: string
  ip_whitelist?: string[]
  ip_blacklist?: string[]
  model_limits_enabled: boolean
  model_limits?: string
  cross_group_retry: boolean
  rate_limit_5h: number
  rate_limit_1d: number
  rate_limit_7d: number
  usage_5h: number
  usage_1d: number
  usage_7d: number
}

export interface ChannelAPIKeyPage {
  items: ChannelAPIKey[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface NotificationLogPage {
  items: NotificationLog[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface UpstreamAnnouncementPage {
  items: UpstreamAnnouncement[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface ChannelAPIKeyGroup {
  id?: number | null
  name: string
  description?: string
  ratio: number
}

export interface ChannelAPIKeyReveal {
  key: string
}

/** POST /channels/:id/api-keys/rename-to-group 的返回（backend/channel/api_key_rename.go） */
export interface ChannelAPIKeyRenameIssue {
  id: number
  name: string
  reason: string
}

export interface ChannelAPIKeyRenameResult {
  renamed: number
  unchanged: number
  skipped: ChannelAPIKeyRenameIssue[]
  failed: ChannelAPIKeyRenameIssue[]
}
