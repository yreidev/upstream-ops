package cch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yreidev/upstream-ops/backend/channel"
	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/crypto"
	"github.com/yreidev/upstream-ops/backend/jobs"
	"github.com/yreidev/upstream-ops/backend/notify"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// keyTailLen 配对时比较的密钥尾部长度，和 CCH 脱敏后露出的末尾位数一致。
const keyTailLen = 4

// Status 是一个 CCH 供应商在本轮同步里的结果。
type Status string

const (
	StatusInSync  Status = "in_sync" // 成本倍率已经等于分组倍率
	StatusPending Status = "pending" // 不一致，预览时待同步
	StatusUpdated Status = "updated" // 不一致，已改
	StatusFailed  Status = "failed"  // 不一致，修改失败
	StatusSkipped Status = "skipped" // 没配上密钥或拿不到分组倍率，不同步
)

// Item 是一个 CCH 供应商的配对和同步结果。
type Item struct {
	ProviderID      int64    `json:"provider_id"`
	ProviderName    string   `json:"provider_name"`
	ProviderEnabled bool     `json:"provider_enabled"`
	ProviderHost    string   `json:"provider_host"`
	KeyTail         string   `json:"key_tail,omitempty"`
	Current         float64  `json:"current"`
	ChannelID       uint     `json:"channel_id,omitempty"`
	ChannelName     string   `json:"channel_name,omitempty"`
	KeyName         string   `json:"key_name,omitempty"`
	GroupName       string   `json:"group_name,omitempty"`
	Target          *float64 `json:"target,omitempty"`
	Status          Status   `json:"status"`
	Reason          string   `json:"reason,omitempty"`
}

// Result 是一轮配对 / 同步的结果。Applied 为 false 表示只是预览，没有改 CCH。
type Result struct {
	Applied    bool      `json:"applied"`
	FinishedAt time.Time `json:"finished_at"`
	Items      []Item    `json:"items"`
	InSync     int       `json:"in_sync"`
	Pending    int       `json:"pending"`
	Updated    int       `json:"updated"`
	Failed     int       `json:"failed"`
	Skipped    int       `json:"skipped"`
}

// Summary 是一句话结果，存进配置行、显示在设置页。
func (r *Result) Summary() string {
	parts := []string{}
	if r.Updated > 0 {
		parts = append(parts, fmt.Sprintf("改了 %d 个", r.Updated))
	}
	if r.Pending > 0 {
		parts = append(parts, fmt.Sprintf("待同步 %d 个", r.Pending))
	}
	if r.Failed > 0 {
		parts = append(parts, fmt.Sprintf("修改失败 %d 个", r.Failed))
	}
	parts = append(parts, fmt.Sprintf("已一致 %d 个", r.InSync))
	if r.Skipped > 0 {
		parts = append(parts, fmt.Sprintf("未同步 %d 个", r.Skipped))
	}
	return strings.Join(parts, "，")
}

// ProviderClient 是同步用到的 CCH 接口，测试里可以换成假的。
type ProviderClient interface {
	ListProviders(ctx context.Context) ([]Provider, error)
	SetCostMultiplier(ctx context.Context, id int64, value float64) error
}

// KeyLister 拉一个上游渠道的全部密钥（带分组和分组倍率），生产实现是 *channel.Service。
type KeyLister interface {
	ListAllAPIKeys(ctx context.Context, channelID uint) ([]connector.APIKey, error)
}

// ErrBusy 表示上一轮同步还没结束。
var ErrBusy = errors.New("上一轮 CCH 同步还没结束，请稍后再试")

// ErrNotConfigured 表示还没填 CCH 地址或令牌。
var ErrNotConfigured = errors.New("还没填写 CCH 地址和管理令牌")

type Service struct {
	repo       *storage.CCHSync
	channels   *storage.Channels
	keys       KeyLister
	monLogs    *storage.MonitorLogs
	dispatcher *notify.Dispatcher
	cipher     *crypto.Cipher
	log        *slog.Logger

	// NewClient 按配置构造 CCH 客户端；测试里替换成假的。
	NewClient func(baseURL, token string) ProviderClient

	running sync.Mutex
}

func NewService(
	repo *storage.CCHSync,
	channels *storage.Channels,
	keys KeyLister,
	monLogs *storage.MonitorLogs,
	dispatcher *notify.Dispatcher,
	cipher *crypto.Cipher,
	log *slog.Logger,
	upstream func() config.UpstreamConfig,
) *Service {
	return &Service{
		repo:       repo,
		channels:   channels,
		keys:       keys,
		monLogs:    monLogs,
		dispatcher: dispatcher,
		cipher:     cipher,
		log:        log,
		NewClient: func(baseURL, token string) ProviderClient {
			cfg := upstream().WithDefaults()
			return NewClient(baseURL, token, time.Duration(cfg.TimeoutSeconds)*time.Second, cfg.UserAgent)
		},
	}
}

// JobSpec 是 CCH 同步作为后台任务时的描述；手动和定时共用一个 Key，同时只跑一个。
func JobSpec(source storage.JobSource) jobs.Spec {
	return jobs.Spec{
		Kind:    storage.JobCCHSync,
		Source:  source,
		Title:   "CCH 成本倍率同步",
		Key:     string(storage.JobCCHSync),
		Timeout: 3 * time.Minute,
	}
}

// ScheduledEnabled 表示定时同步开着；关着时倍率采集后不跑，也不记任务。
func (s *Service) ScheduledEnabled() bool {
	cfg, err := s.repo.Get()
	if err != nil {
		s.log.Warn("load cch sync config", "err", err)
		return false
	}
	return cfg.Enabled
}

// RunScheduled 在每轮定时倍率采集之后作为后台任务执行，受登录退避限制。
func (s *Service) RunScheduled(ctx context.Context) (string, any, error) {
	return s.run(channel.WithScheduled(ctx), true)
}

// RunNow 手动同步一轮，开关关着也能用；结果同样写监控日志、发通知。
func (s *Service) RunNow(ctx context.Context) (string, any, error) {
	return s.run(ctx, false)
}

// run 执行一轮同步，返回值按后台任务的约定：有供应商改失败时任务记为失败，结果里仍带完整的配对明细。
// scheduled 为 true 时，开关关着就不同步。
func (s *Service) run(ctx context.Context, scheduled bool) (string, any, error) {
	if !s.running.TryLock() {
		return "", nil, ErrBusy
	}
	defer s.running.Unlock()
	cfg, err := s.repo.Get()
	if err != nil {
		return "", nil, err
	}
	if scheduled && !cfg.Enabled {
		return "定时同步已关闭，没有同步", nil, nil
	}
	result, err := s.sync(ctx, cfg)
	if err != nil {
		return "", nil, err
	}
	if result.Failed > 0 {
		return result.Summary(), result, errors.New(failedReasons(result))
	}
	return result.Summary(), result, nil
}

// Preview 只配对、算出要改成多少，不改 CCH，也不写日志和通知。
func (s *Service) Preview(ctx context.Context) (*Result, error) {
	cfg, err := s.repo.Get()
	if err != nil {
		return nil, err
	}
	client, err := s.client(cfg)
	if err != nil {
		return nil, err
	}
	return s.plan(ctx, client)
}

func (s *Service) client(cfg *storage.CCHSyncConfig) (ProviderClient, error) {
	if strings.TrimSpace(cfg.BaseURL) == "" || cfg.TokenCipher == "" {
		return nil, ErrNotConfigured
	}
	token, err := s.cipher.Decrypt(cfg.TokenCipher)
	if err != nil {
		return nil, fmt.Errorf("解密 CCH 令牌：%w", err)
	}
	return s.NewClient(cfg.BaseURL, token), nil
}

// sync 配对并改掉不一致的成本倍率，然后写监控日志、记录结果、发通知。
// 返回的 error 是整轮失败（连不上 CCH、令牌不对等）；单个供应商改失败记在 Result.Failed 里。
func (s *Service) sync(ctx context.Context, cfg *storage.CCHSyncConfig) (*Result, error) {
	started := time.Now()
	client, err := s.client(cfg)
	var result *Result
	if err == nil {
		result, err = s.plan(ctx, client)
	}
	if err == nil {
		s.apply(ctx, client, result)
	}
	if err != nil && channel.IsCanceled(ctx) {
		return nil, err // 服务停止时被中断，不算失败
	}

	runErr := err
	if runErr == nil && result.Failed > 0 {
		runErr = errors.New(failedReasons(result))
	}
	_ = s.monLogs.Append(&storage.MonitorLog{
		Job:          storage.MonitorJobCCHSync,
		Success:      runErr == nil,
		ErrorMessage: errString(runErr),
		StartedAt:    started,
		FinishedAt:   time.Now(),
	})
	summary := ""
	if result != nil {
		summary = result.Summary()
	}
	if recErr := s.repo.RecordRun(time.Now(), summary, errString(runErr)); recErr != nil {
		s.log.Warn("record cch sync run", "err", recErr)
	}

	if result != nil && result.Updated > 0 {
		_ = s.dispatcher.Dispatch(ctx, buildUpdatedMessage(result))
	}
	if runErr != nil {
		if reportErr := s.dispatcher.ReportFailure(ctx, notify.Failure{
			Kind:      notify.FailureCCHSync,
			Err:       runErr,
			Immediate: IsUnauthorized(runErr) || errors.Is(runErr, ErrNotConfigured),
		}); reportErr != nil {
			s.log.Warn("report cch sync failure", "err", reportErr)
		}
	} else if reportErr := s.dispatcher.ReportSuccess(ctx, 0, "", notify.FailureCCHSync); reportErr != nil {
		s.log.Warn("report cch sync success", "err", reportErr)
	}
	return result, err
}

// plan 拉 CCH 供应商和对应站点的上游密钥，逐个配对并算出目标成本倍率。
//
// 配对规则：供应商地址的主机名和上游渠道站点相同，且密钥末 4 位相同；同站点只找到一把才算配上。
// 目标成本倍率 = 这把密钥当前所在分组的倍率，按 CCH 的精度保留 4 位小数，不做换算。
// 只看开着监控的渠道，暂停监控的渠道不去请求上游。
func (s *Service) plan(ctx context.Context, client ProviderClient) (*Result, error) {
	providers, err := client.ListProviders(ctx)
	if err != nil {
		return nil, err
	}
	all, err := s.channels.List()
	if err != nil {
		return nil, err
	}
	byHost := map[string][]storage.Channel{}
	for _, c := range all {
		if h := hostOf(c.SiteURL); h != "" {
			byHost[h] = append(byHost[h], c)
		}
	}

	type channelKeys struct {
		keys []connector.APIKey
		err  error
	}
	keyCache := map[uint]channelKeys{}
	keysOf := func(c storage.Channel) ([]connector.APIKey, error) {
		if cached, ok := keyCache[c.ID]; ok {
			return cached.keys, cached.err
		}
		keys, err := s.keys.ListAllAPIKeys(ctx, c.ID)
		keyCache[c.ID] = channelKeys{keys: keys, err: err}
		return keys, err
	}

	result := &Result{Items: make([]Item, 0, len(providers))}
	for _, p := range providers {
		item := Item{
			ProviderID:      p.ID,
			ProviderName:    p.Name,
			ProviderEnabled: p.IsEnabled,
			ProviderHost:    hostOf(p.URL),
			KeyTail:         visibleTail(p.MaskedKey),
			Current:         round4(p.CostMultiplier),
		}
		s.matchProvider(&item, byHost[item.ProviderHost], keysOf)
		result.Items = append(result.Items, item)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(result.Items, func(i, j int) bool {
		return result.Items[i].ProviderName < result.Items[j].ProviderName
	})
	result.count()
	result.FinishedAt = time.Now()
	return result, nil
}

func (s *Service) matchProvider(item *Item, channels []storage.Channel, keysOf func(storage.Channel) ([]connector.APIKey, error)) {
	skip := func(reason string) {
		item.Status = StatusSkipped
		item.Reason = reason
	}
	if item.ProviderHost == "" {
		skip("供应商地址无法识别")
		return
	}
	if len(channels) == 0 {
		skip("没有站点是 " + item.ProviderHost + " 的渠道")
		return
	}
	if item.KeyTail == "" {
		skip("CCH 没露出密钥尾号，无法配对")
		return
	}

	type candidate struct {
		channel storage.Channel
		key     connector.APIKey
	}
	var candidates []candidate
	var listErrs []string
	monitored := 0
	for _, c := range channels {
		if !c.MonitorEnabled {
			continue
		}
		monitored++
		keys, err := keysOf(c)
		if err != nil {
			listErrs = append(listErrs, fmt.Sprintf("读取 %s 的密钥失败：%v", c.Name, err))
			continue
		}
		for _, k := range keys {
			if visibleTail(k.Key) == item.KeyTail {
				candidates = append(candidates, candidate{channel: c, key: k})
			}
		}
	}
	switch {
	case monitored == 0:
		skip("对应渠道已暂停监控")
		return
	case len(candidates) == 0 && len(listErrs) > 0:
		skip(strings.Join(listErrs, "；"))
		return
	case len(candidates) == 0:
		skip("没找到尾号 " + item.KeyTail + " 的密钥")
		return
	case len(candidates) > 1:
		skip(fmt.Sprintf("有 %d 把密钥尾号都是 %s，无法确定是哪一把", len(candidates), item.KeyTail))
		return
	}

	m := candidates[0]
	item.ChannelID = m.channel.ID
	item.ChannelName = m.channel.Name
	item.KeyName = strings.TrimSpace(m.key.Name)
	item.GroupName = strings.TrimSpace(m.key.GroupName)
	if item.GroupName == "" {
		switch {
		case strings.TrimSpace(m.key.Group) != "":
			skip(fmt.Sprintf("密钥的分组 %s 已不在上游可用分组里", strings.TrimSpace(m.key.Group)))
		case m.key.GroupID != nil:
			skip(fmt.Sprintf("密钥的分组（ID %d）已不在上游可用分组里", *m.key.GroupID))
		default:
			skip("密钥没有分组")
		}
		return
	}
	if m.key.GroupRatio <= 0 {
		skip("分组倍率为 0，不同步")
		return
	}
	target := round4(m.key.GroupRatio)
	item.Target = &target
	if target == item.Current {
		item.Status = StatusInSync
		return
	}
	item.Status = StatusPending
}

// apply 逐个改掉待同步的供应商，单个失败不影响其它。
func (s *Service) apply(ctx context.Context, client ProviderClient, result *Result) {
	result.Applied = true
	for i := range result.Items {
		item := &result.Items[i]
		if item.Status != StatusPending || item.Target == nil {
			continue
		}
		if err := client.SetCostMultiplier(ctx, item.ProviderID, *item.Target); err != nil {
			item.Status = StatusFailed
			item.Reason = err.Error()
			continue
		}
		item.Status = StatusUpdated
	}
	result.count()
	result.FinishedAt = time.Now()
}

func (r *Result) count() {
	r.InSync, r.Pending, r.Updated, r.Failed, r.Skipped = 0, 0, 0, 0, 0
	for _, item := range r.Items {
		switch item.Status {
		case StatusInSync:
			r.InSync++
		case StatusPending:
			r.Pending++
		case StatusUpdated:
			r.Updated++
		case StatusFailed:
			r.Failed++
		case StatusSkipped:
			r.Skipped++
		}
	}
}

func buildUpdatedMessage(r *Result) notify.Message {
	var b strings.Builder
	fmt.Fprintf(&b, "# CCH 成本倍率同步\n\n> 同步时间：%s\n\n## 已修改（%d）\n", r.FinishedAt.Format("2006-01-02 15:04"), r.Updated)
	for _, item := range r.Items {
		if item.Status != StatusUpdated {
			continue
		}
		fmt.Fprintf(&b, "- **%s**：`%gx` %s `%gx`（%s · %s）\n",
			item.ProviderName, item.Current, arrowFor(item.Current, *item.Target), *item.Target, item.ChannelName, item.GroupName)
	}
	if r.Failed > 0 {
		fmt.Fprintf(&b, "\n## 修改失败（%d）\n", r.Failed)
		for _, item := range r.Items {
			if item.Status == StatusFailed {
				fmt.Fprintf(&b, "- **%s**：%s\n", item.ProviderName, item.Reason)
			}
		}
	}
	return notify.Message{
		Event:   storage.EventCCHSync,
		Subject: fmt.Sprintf("【CCH 成本倍率同步】已改 %d 个供应商", r.Updated),
		Body:    b.String(),
	}
}

func failedReasons(r *Result) string {
	reasons := make([]string, 0, r.Failed)
	for _, item := range r.Items {
		if item.Status == StatusFailed {
			reasons = append(reasons, item.ProviderName+"："+item.Reason)
		}
	}
	return fmt.Sprintf("%d 个供应商修改失败：%s", r.Failed, strings.Join(reasons, "；"))
}

func arrowFor(oldV, newV float64) string {
	if newV > oldV {
		return "上涨"
	}
	return "下调"
}

// hostOf 取地址的主机名（小写、去掉端口和开头的 www.），用来判断供应商和渠道是不是同一个站点。
func hostOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}

// visibleTail 取密钥末 4 位；末尾是脱敏符号（* 或 •）或不够长时返回空，表示没法比。
func visibleTail(key string) string {
	r := []rune(strings.TrimSpace(key))
	if len(r) < keyTailLen {
		return ""
	}
	tail := string(r[len(r)-keyTailLen:])
	if strings.ContainsAny(tail, "*•") {
		return ""
	}
	return tail
}

func round4(v float64) float64 {
	return math.Round(v*10000) / 10000
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// SettingsView 是设置页看到的同步配置，令牌只告诉有没有填。
type SettingsView struct {
	Enabled     bool       `json:"enabled"`
	BaseURL     string     `json:"base_url"`
	TokenSet    bool       `json:"token_set"`
	LastRunAt   *time.Time `json:"last_run_at,omitempty"`
	LastSummary string     `json:"last_summary,omitempty"`
	LastError   string     `json:"last_error,omitempty"`
}

// SettingsInput 是设置页提交的同步配置。Token 留空表示保留原令牌。
type SettingsInput struct {
	Enabled bool   `json:"enabled"`
	BaseURL string `json:"base_url"`
	Token   string `json:"token"`
}

func (s *Service) Settings() (*SettingsView, error) {
	cfg, err := s.repo.Get()
	if err != nil {
		return nil, err
	}
	return &SettingsView{
		Enabled:     cfg.Enabled,
		BaseURL:     cfg.BaseURL,
		TokenSet:    cfg.TokenCipher != "",
		LastRunAt:   cfg.LastRunAt,
		LastSummary: cfg.LastSummary,
		LastError:   cfg.LastError,
	}, nil
}

// SaveSettings 校验并保存同步配置；令牌加密后入库。开启自动同步时地址和令牌都必须有。
func (s *Service) SaveSettings(in SettingsInput) (*SettingsView, error) {
	cfg, err := s.repo.Get()
	if err != nil {
		return nil, err
	}
	baseURL := ""
	if strings.TrimSpace(in.BaseURL) != "" {
		if baseURL, err = NormalizeBaseURL(in.BaseURL); err != nil {
			return nil, err
		}
	}
	var tokenCipher *string
	if token := strings.TrimSpace(in.Token); token != "" {
		enc, err := s.cipher.Encrypt(token)
		if err != nil {
			return nil, fmt.Errorf("加密 CCH 令牌：%w", err)
		}
		tokenCipher = &enc
	}
	if in.Enabled && (baseURL == "" || (tokenCipher == nil && cfg.TokenCipher == "")) {
		return nil, errors.New("开启自动同步前请先填写 CCH 地址和管理令牌")
	}
	if err := s.repo.SaveSettings(in.Enabled, baseURL, tokenCipher); err != nil {
		return nil, err
	}
	return s.Settings()
}
