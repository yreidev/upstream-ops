package config

import (
	"path/filepath"
	"testing"
)

func TestEnvOverridesMatchLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := Save(path, &Config{Auth: AuthConfig{Enabled: false, Password: "file-pass"}, Scheduler: SchedulerConfig{RateCron: "0 0 * * * *"}}); err != nil {
		t.Fatalf("save: %v", err)
	}
	t.Setenv("AUTH_ENABLED", "true")
	t.Setenv("ADMIN_PASSWORD", "env-pass")
	t.Setenv("SCHEDULER_RATECRON", "5 * * * * *")
	t.Setenv("SCHEDULER_RETENTION_MONITORLOGSDAYS", "7")
	t.Setenv("AUTH_TOKEN_SECRET", "") // 空值不算覆盖

	got := EnvOverrides(KeyPaths())
	want := map[string]string{
		"auth.enabled":                        "AUTH_ENABLED",
		"auth.password":                       "ADMIN_PASSWORD",
		"scheduler.rateCron":                  "SCHEDULER_RATECRON",
		"scheduler.retention.monitorLogsDays": "SCHEDULER_RETENTION_MONITORLOGSDAYS",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("override %s = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
	if _, ok := got["auth.tokenSecret"]; ok {
		t.Errorf("empty env must not count: %v", got)
	}

	// 列出来的覆盖必须和 Load 实际读到的一致
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.Auth.Enabled || cfg.Auth.Password != "env-pass" || cfg.Scheduler.RateCron != "5 * * * * *" || cfg.Scheduler.Retention.MonitorLogsDays != 7 {
		t.Fatalf("Load did not apply env: auth=%+v scheduler=%+v", cfg.Auth, cfg.Scheduler)
	}
}

func TestCopyKeys(t *testing.T) {
	dst := &Config{Auth: AuthConfig{Enabled: true, Username: "new"}, Scheduler: SchedulerConfig{Retention: RetentionConfig{Cron: "new"}}}
	src := &Config{Auth: AuthConfig{Enabled: false, Username: "old"}, Scheduler: SchedulerConfig{Retention: RetentionConfig{Cron: "old"}}}
	CopyKeys(dst, src, []string{"auth.enabled", "scheduler.retention.cron", "no.such.key"})
	if dst.Auth.Enabled || dst.Scheduler.Retention.Cron != "old" || dst.Auth.Username != "new" {
		t.Fatalf("dst = auth %+v retention %+v", dst.Auth, dst.Scheduler.Retention)
	}
}
