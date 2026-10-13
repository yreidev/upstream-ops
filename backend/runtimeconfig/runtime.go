// Package runtimeconfig 管理可热更新的运行时配置。
package runtimeconfig

import (
	"fmt"
	"log/slog"
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
	upstreamConfig   config.UpstreamConfig
}

type ApplyResult struct {
	AppliedSections []string `json:"applied_sections"`
	Message         string   `json:"message"`
}

func New(
	configPath string,
	securitySecret string,
	log *slog.Logger,
	dispatcher *notify.Dispatcher,
	channelSvc *channel.Service,
	authSvc *auth.Service,
	schedulerSvc *scheduler.Scheduler,
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

func (m *Manager) ApplyFromFile() (*ApplyResult, error) {
	m.mu.RLock()
	path := m.configPath
	secret := m.securitySecret
	dispatcher := m.dispatcher
	channelSvc := m.channelSvc
	factory := m.schedulerFactory
	oldScheduler := m.scheduler
	m.mu.RUnlock()

	cfg, err := config.LoadFile(path)
	if err != nil {
		return nil, err
	}

	authSvc, err := buildAuth(cfg.Auth, secret)
	if err != nil {
		return nil, err
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

	newScheduler := factory(cfg.Scheduler)
	if err := newScheduler.Start(); err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.auth = authSvc
	m.scheduler = newScheduler
	m.upstreamConfig = cfg.Upstream.WithDefaults()
	m.mu.Unlock()

	if oldScheduler != nil {
		oldScheduler.Stop()
	}

	sections := []string{"app", "auth", "scheduler", "notifications", "retention", "upstream"}
	if m.log != nil {
		m.log.Info("runtime config applied",
			"sections", sections,
			"config_path", path,
		)
	}

	return &ApplyResult{
		AppliedSections: sections,
		Message:         "app、auth、scheduler、notifications、retention、upstream 已立即生效",
	}, nil
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
