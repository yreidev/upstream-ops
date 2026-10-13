// Package runtimeconfig 管理可热更新的运行时配置。
package runtimeconfig

import (
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/auth"
	"github.com/yreidev/upstream-ops/backend/channel"
	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/notify"
	"github.com/yreidev/upstream-ops/backend/scheduler"
)

type SchedulerFactory func(config.SchedulerConfig) *scheduler.Scheduler

type Manager struct {
	mu               sync.RWMutex
	configPath       string
	securitySecret   string
	log              *slog.Logger
	dispatcher       *notify.Dispatcher
	channelSvc       *channel.Service
	schedulerFactory SchedulerFactory
	auth             *auth.Service
	scheduler        *scheduler.Scheduler
	appConfig        config.AppConfig
	upstreamConfig   config.UpstreamConfig
	onApply          []func(*config.Config)
}

func New(
	configPath string,
	securitySecret string,
	log *slog.Logger,
	dispatcher *notify.Dispatcher,
	channelSvc *channel.Service,
	authSvc *auth.Service,
	schedulerSvc *scheduler.Scheduler,
	appConfig config.AppConfig,
	upstreamConfig config.UpstreamConfig,
	schedulerFactory SchedulerFactory,
) *Manager {
	return &Manager{
		configPath:       configPath,
		securitySecret:   securitySecret,
		log:              log,
		dispatcher:       dispatcher,
		channelSvc:       channelSvc,
		schedulerFactory: schedulerFactory,
		auth:             authSvc,
		scheduler:        schedulerSvc,
		appConfig:        appConfig,
		upstreamConfig:   upstreamConfig.WithDefaults(),
	}
}

func (m *Manager) ConfigPath() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.configPath
}

func (m *Manager) CurrentAuth() *auth.Service {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.auth
}

// CurrentApp 返回正在生效的应用信息（标题、通知前缀）。
func (m *Manager) CurrentApp() config.AppConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.appConfig
}

func (m *Manager) CurrentUpstream() config.UpstreamConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.upstreamConfig
}

func (m *Manager) AuthMiddleware() gin.HandlerFunc {
	whitelist := map[string]struct{}{
		"/healthz":        {},
		"/api/version":    {},
		"/api/auth/login": {},
	}
	return func(c *gin.Context) {
		if _, ok := whitelist[c.FullPath()]; ok {
			c.Next()
			return
		}
		if _, ok := whitelist[c.Request.URL.Path]; ok {
			c.Next()
			return
		}
		svc := m.CurrentAuth()
		if svc == nil {
			c.Next()
			return
		}
		svc.Middleware()(c)
	}
}

// OnApply 登记保存设置后要跟着更新的地方（比如降智检测的默认模型），在程序启动时调用。
func (m *Manager) OnApply(fn func(*config.Config)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onApply = append(m.onApply, fn)
}

// Validate 检查设置页能改的配置能不能生效，有错返回给页面的中文说明。
// 保存前先调用：写错的 cron 一旦写进配置文件，下次启动调度器起不来，进程会直接退出。
func (m *Manager) Validate(cfg *config.Config) error {
	crons := []struct{ label, spec string }{
		{"余额采集 Cron", cfg.Scheduler.BalanceCron},
		{"倍率采集 Cron", cfg.Scheduler.RateCron},
		{"清理任务 Cron", cfg.Scheduler.Retention.Cron},
		{"降智巡检 Cron", cfg.Scheduler.DegradeCron},
	}
	for _, c := range crons {
		if c.spec == "" {
			continue
		}
		if scheduler.ParseSpec(c.spec) != nil {
			return CronError(c.label, c.spec)
		}
	}
	if effort := strings.TrimSpace(cfg.Degrade.Effort); effort != "" && !slices.Contains(config.DegradeEfforts, effort) {
		return fmt.Errorf("降智检测的推理强度只能是 %s", strings.Join(config.DegradeEfforts, "、"))
	}
	if cfg.Auth.Enabled {
		if cfg.Auth.Username == "" {
			return fmt.Errorf("启用登录时管理员账号不能为空")
		}
		if cfg.Auth.Password == "" {
			return fmt.Errorf("启用登录时管理员密码不能为空")
		}
		m.mu.RLock()
		secret := m.securitySecret
		m.mu.RUnlock()
		if cfg.Auth.TokenSecret == "" && secret == "" {
			return fmt.Errorf("启用登录时令牌签名密钥不能为空（也没有设置安全主密钥 APP_SECRET 可以替代）")
		}
	}
	return nil
}

// CronError 给出中文说明；cron 库的报错是英文，不直接给页面。
func CronError(label, spec string) error {
	if n := len(strings.Fields(spec)); !strings.HasPrefix(spec, "@") && n != 6 {
		return fmt.Errorf("%s 写法不对：要带秒，共 6 段（秒 分 时 日 月 周），现在是 %d 段。例如每 15 分钟：0 */15 * * * *", label, n)
	}
	return fmt.Errorf("%s 写法不对：6 段依次是秒 分 时 日 月 周，有一段的数值或写法不对。例如每 15 分钟：0 */15 * * * *", label)
}

// Apply 让 cfg 里的应用信息、鉴权、调度、通知策略和上游请求配置立即生效。
// 先把可能失败的鉴权和新调度器准备好，再一起替换，失败时保持原来的配置不动。
func (m *Manager) Apply(cfg *config.Config) error {
	m.mu.RLock()
	secret := m.securitySecret
	dispatcher := m.dispatcher
	channelSvc := m.channelSvc
	factory := m.schedulerFactory
	oldScheduler := m.scheduler
	m.mu.RUnlock()

	authSvc, err := buildAuth(cfg.Auth, secret)
	if err != nil {
		return err
	}
	newScheduler := factory(cfg.Scheduler)
	if err := newScheduler.Start(); err != nil {
		return err
	}

	if dispatcher != nil {
		dispatcher.UpdatePolicy(notify.Policy{
			NotificationPrefix: cfg.App.NotificationPrefix,
			MinChangePct:       cfg.Notifications.MinChangePct,
			BalanceLowCooldown: time.Duration(cfg.Notifications.BalanceLowCooldownMinutes) * time.Minute,
			SendMaxAttempts:    cfg.Notifications.SendMaxAttempts,
		})
	}
	if channelSvc != nil {
		channelSvc.UpdateUpstreamConfig(cfg.Upstream)
	}

	m.mu.Lock()
	m.auth = authSvc
	m.scheduler = newScheduler
	m.appConfig = cfg.App
	m.upstreamConfig = cfg.Upstream.WithDefaults()
	hooks := m.onApply
	m.mu.Unlock()
	for _, fn := range hooks {
		fn(cfg)
	}

	if oldScheduler != nil {
		oldScheduler.Stop()
	}
	if m.log != nil {
		m.log.Info("runtime config applied", "config_path", m.ConfigPath())
	}
	return nil
}

func buildAuth(cfg config.AuthConfig, securitySecret string) (*auth.Service, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	tokenSecret := cfg.TokenSecret
	if tokenSecret == "" {
		tokenSecret = securitySecret
	}
	svc, err := auth.New(
		cfg.Username,
		cfg.Password,
		tokenSecret,
		time.Duration(cfg.SessionTTLHours)*time.Hour,
	)
	if err != nil {
		return nil, fmt.Errorf("init auth: %w", err)
	}
	return svc, nil
}
