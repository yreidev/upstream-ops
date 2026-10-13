package runtimeconfig

import (
	"io"
	"log/slog"
	"path/filepath"
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

func TestApplyFromFileUpdatesUpstreamConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	cfg := &config.Config{
		Scheduler: config.SchedulerConfig{
			BalanceCron: "",
			RateCron:    "",
			Retention:   config.RetentionConfig{Cron: ""},
		},
		Upstream: config.UpstreamConfig{
			TimeoutSeconds: 45,
			UserAgent:      "custom-agent",
		},
	}
	if err := config.Save(path, cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}

	channelSvc := channel.NewService(nil, nil, nil, nil, nil, nil)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := New(
		path,
		"",
		log,
		nil,
		channelSvc,
		nil,
		nil,
		config.UpstreamConfig{},
		func(scfg config.SchedulerConfig) *scheduler.Scheduler {
			return scheduler.New(scfg, nil, nil, nil, nil, nil, nil, nil, log)
		},
	)

	result, err := mgr.ApplyFromFile()
	if err != nil {
		t.Fatalf("ApplyFromFile: %v", err)
	}
	if len(result.AppliedSections) == 0 {
		t.Fatalf("applied sections empty")
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

func TestApplyFromFileKeepsEnvOverrides(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	// 配置文件里登录是关的，只靠环境变量开着；应用后必须仍然开着
	if err := config.Save(path, &config.Config{Auth: config.AuthConfig{Enabled: false}}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	t.Setenv("AUTH_ENABLED", "true")
	t.Setenv("ADMIN_USERNAME", "admin")
	t.Setenv("ADMIN_PASSWORD", "env-pass")
	t.Setenv("AUTH_TOKEN_SECRET", "env-secret")

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := New(path, "", log, nil, nil, nil, nil, config.UpstreamConfig{},
		func(config.SchedulerConfig) *scheduler.Scheduler {
			return scheduler.New(config.SchedulerConfig{}, nil, nil, nil, nil, nil, nil, nil, log)
		})
	if _, err := mgr.ApplyFromFile(); err != nil {
		t.Fatalf("ApplyFromFile: %v", err)
	}
	if mgr.CurrentAuth() == nil {
		t.Fatal("login was turned off by applying a config file that predates AUTH_ENABLED")
	}
}
