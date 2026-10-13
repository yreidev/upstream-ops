package config

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestLoadAppliesUpstreamDefaults(t *testing.T) {
	cfg, err := LoadFile(filepath.Join(t.TempDir(), "missing.yaml"))
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if cfg.Upstream.TimeoutSeconds != DefaultUpstreamTimeoutSeconds {
		t.Fatalf("timeout seconds = %d", cfg.Upstream.TimeoutSeconds)
	}
	if cfg.Upstream.UserAgent != DefaultUpstreamUserAgent {
		t.Fatalf("user agent = %q", cfg.Upstream.UserAgent)
	}
}

func TestUpstreamConfigWithDefaultsKeepsCustomUserAgent(t *testing.T) {
	cfg := UpstreamConfig{
		TimeoutSeconds: 0,
		UserAgent:      "custom-agent",
	}.WithDefaults()
	if cfg.TimeoutSeconds != DefaultUpstreamTimeoutSeconds {
		t.Fatalf("timeout seconds = %d", cfg.TimeoutSeconds)
	}
	if cfg.UserAgent != "custom-agent" {
		t.Fatalf("user agent = %q", cfg.UserAgent)
	}
}

func TestDegradeModels(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write config: %v", err)
		}
		return path
	}

	// 没写时只有默认模型
	cfg, err := LoadFile(filepath.Join(dir, "missing.yaml"))
	if err != nil || !slices.Equal(cfg.Degrade.Models, []string{DefaultDegradeModel}) {
		t.Fatalf("default models = %v, %v", cfg.Degrade.Models, err)
	}

	// v0.6.0 写的单个模型当作只有一个模型的列表，保存后改写成 models
	old := write("old.yaml", "degrade:\n  model: gpt-old\n  effort: high\n")
	cfg, err = LoadFile(old)
	if err != nil || !slices.Equal(cfg.Degrade.Models, []string{"gpt-old"}) || cfg.Degrade.Effort != "high" {
		t.Fatalf("old config = %#v, %v", cfg.Degrade, err)
	}
	if err := Save(old, cfg); err != nil {
		t.Fatalf("save: %v", err)
	}
	body, _ := os.ReadFile(old)
	if strings.Contains(string(body), "model:") || !strings.Contains(string(body), "- gpt-old") {
		t.Fatalf("saved config:\n%s", body)
	}

	// 列表去掉空项和重复项，顺序不变
	list := write("list.yaml", "degrade:\n  models: [\" gpt-a \", \"\", gpt-b, gpt-a]\n")
	cfg, err = LoadFile(list)
	if err != nil || !slices.Equal(cfg.Degrade.Models, []string{"gpt-a", "gpt-b"}) {
		t.Fatalf("list = %v, %v", cfg.Degrade.Models, err)
	}

	// 环境变量用逗号分隔，盖过配置文件（包括旧的单个模型）
	t.Setenv("DEGRADE_MODELS", "gpt-x, gpt-y")
	for _, path := range []string{old, list, write("legacy.yaml", "degrade:\n  model: gpt-old\n")} {
		cfg, err = Load(path)
		if err != nil || !slices.Equal(cfg.Degrade.Models, []string{"gpt-x", "gpt-y"}) {
			t.Fatalf("env models for %s = %v, %v", filepath.Base(path), cfg.Degrade.Models, err)
		}
	}
}
