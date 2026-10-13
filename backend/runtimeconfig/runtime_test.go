package runtimeconfig

import (
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/yreidev/upstream-ops/backend/channel"
	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/scheduler"
)

type fakeHTTPConfigConnector struct {
	cfg connector.HTTPConfig
}

func (f *fakeHTTPConfigConnector) SetHTTPConfig(cfg connector.HTTPConfig) {
	f.cfg = cfg
}

func newTestManager(channelSvc *channel.Service) *Manager {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New("", "test-secret", log, nil, channelSvc, nil, nil,
		config.AppConfig{Title: "Old"}, config.UpstreamConfig{TimeoutSeconds: 20},
		func(scfg config.SchedulerConfig) *scheduler.Scheduler {
			return scheduler.New(scfg, nil, nil, nil, nil, nil, nil, nil, log)
		})
}

func TestApplyUpdatesRuntimeConfig(t *testing.T) {
	channelSvc := channel.NewService(nil, nil, nil, nil, nil, nil)
	mgr := newTestManager(channelSvc)

	err := mgr.Apply(&config.Config{
		App:      config.AppConfig{Title: "New"},
		Auth:     config.AuthConfig{Enabled: true, Username: "admin", Password: "pass"},
		Upstream: config.UpstreamConfig{TimeoutSeconds: 45, UserAgent: "custom-agent"},
	})
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if got := mgr.CurrentApp().Title; got != "New" {
		t.Fatalf("title = %q", got)
	}
	if mgr.CurrentAuth() == nil {
		t.Fatal("login should be on")
	}
	if got := mgr.CurrentUpstream(); got.TimeoutSeconds != 45 || got.UserAgent != "custom-agent" {
		t.Fatalf("current upstream = %#v", got)
	}

	conn := &fakeHTTPConfigConnector{}
	channelSvc.ApplyHTTPConfig(conn)
	if conn.cfg.Timeout != 45*time.Second {
		t.Fatalf("timeout = %s", conn.cfg.Timeout)
	}
	if conn.cfg.UserAgent != "custom-agent" {
		t.Fatalf("user agent = %q", conn.cfg.UserAgent)
	}
}

func TestApplyKeepsOldConfigOnFailure(t *testing.T) {
	channelSvc := channel.NewService(nil, nil, nil, nil, nil, nil)
	channelSvc.UpdateUpstreamConfig(config.UpstreamConfig{TimeoutSeconds: 20})
	mgr := newTestManager(channelSvc)

	// 调度器起不来时，前面的上游请求配置也不能先换掉
	err := mgr.Apply(&config.Config{
		App:       config.AppConfig{Title: "New"},
		Scheduler: config.SchedulerConfig{BalanceCron: "*/15 * * * *"},
		Upstream:  config.UpstreamConfig{TimeoutSeconds: 45},
	})
	if err == nil {
		t.Fatal("Apply should fail on a 5-field cron")
	}
	if got := mgr.CurrentApp().Title; got != "Old" {
		t.Fatalf("title = %q, want the old one", got)
	}
	conn := &fakeHTTPConfigConnector{}
	channelSvc.ApplyHTTPConfig(conn)
	if conn.cfg.Timeout != 20*time.Second {
		t.Fatalf("upstream timeout = %s, want the old 20s", conn.cfg.Timeout)
	}
}

func TestValidate(t *testing.T) {
	mgr := newTestManager(nil)
	ok := []config.Config{
		{},
		{Scheduler: config.SchedulerConfig{BalanceCron: "0 */15 * * * *", RateCron: "@every 30m", Retention: config.RetentionConfig{Cron: "0 17 3 * * *"}}},
		{Auth: config.AuthConfig{Enabled: true, Username: "admin", Password: "pass"}},
	}
	for i := range ok {
		if err := mgr.Validate(&ok[i]); err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
	}

	bad := []struct {
		cfg  config.Config
		want string
	}{
		{config.Config{Scheduler: config.SchedulerConfig{BalanceCron: "*/15 * * * *"}}, "余额采集 Cron 写法不对：要带秒，共 6 段（秒 分 时 日 月 周），现在是 5 段"},
		{config.Config{Scheduler: config.SchedulerConfig{RateCron: "0 70 * * * *"}}, "倍率采集 Cron 写法不对：6 段依次是"},
		{config.Config{Scheduler: config.SchedulerConfig{Retention: config.RetentionConfig{Cron: "@every banana"}}}, "清理任务 Cron 写法不对：6 段依次是"},
		{config.Config{Auth: config.AuthConfig{Enabled: true, Password: "pass"}}, "管理员账号"},
		{config.Config{Auth: config.AuthConfig{Enabled: true, Username: "admin"}}, "管理员密码"},
	}
	for _, tt := range bad {
		err := mgr.Validate(&tt.cfg)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Fatalf("Validate(%+v) = %v, want an error about %s", tt.cfg, err, tt.want)
		}
	}

	noSecret := New("", "", nil, nil, nil, nil, nil, config.AppConfig{}, config.UpstreamConfig{}, nil)
	if err := noSecret.Validate(&config.Config{Auth: config.AuthConfig{Enabled: true, Username: "admin", Password: "pass"}}); err == nil {
		t.Fatal("login without any token secret should be rejected")
	}
}
