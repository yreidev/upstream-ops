package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/runtimeconfig"
	"github.com/yreidev/upstream-ops/backend/scheduler"
)

func newSettingsRuntime(path string) *runtimeconfig.Manager {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return runtimeconfig.New(path, "test-secret", log, nil, nil, nil, nil,
		config.AppConfig{Title: "Old"}, config.UpstreamConfig{},
		func(scfg config.SchedulerConfig) *scheduler.Scheduler {
			return scheduler.New(scfg, nil, nil, nil, nil, nil, nil, nil, log)
		})
}

func putSettings(r http.Handler, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPut, "/api/settings/config", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestSaveSettingsKeepsAppVersion(t *testing.T) {
	gin.SetMode(gin.TestMode)

	path := filepath.Join(t.TempDir(), "config.yaml")
	cfg := &config.Config{
		App: config.AppConfig{
			Title:              "Old",
			NotificationPrefix: "[Old] ",
		},
	}
	if err := config.Save(path, cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}

	r := gin.New()
	rt := newSettingsRuntime(path)
	registerSettings(r.Group("/api"), &Deps{Runtime: rt})

	body := `{
		"app":{"title":"New","notificationPrefix":"[New] "},
		"auth":{"enabled":false,"username":"admin","password":"","tokenSecret":"","sessionTTLHours":168},
		"scheduler":{"balanceCron":"37 */15 * * * *","rateCron":"13 */30 * * * *","retention":{"cron":"0 17 3 * * *","monitorLogsDays":30,"balanceSnapshotsDays":90,"notificationLogsDays":90,"announcementsDays":90}},
		"notifications":{"minChangePct":0,"balanceLowCooldownMinutes":60,"sendMaxAttempts":3},
		"upstream":{"timeoutSeconds":45,"userAgent":"custom-agent"}
	}`
	rec := putSettings(r, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	got, err := config.LoadFile(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if got.App.Title != "New" {
		t.Fatalf("title = %q", got.App.Title)
	}
	if got.App.NotificationPrefix != "[New] " {
		t.Fatalf("notification prefix = %q", got.App.NotificationPrefix)
	}
	if got.Upstream.TimeoutSeconds != 45 || got.Upstream.UserAgent != "custom-agent" {
		t.Fatalf("upstream = %#v", got.Upstream)
	}
	// 保存即生效，不用再单独“应用”
	if rt.CurrentApp().Title != "New" || rt.CurrentUpstream().TimeoutSeconds != 45 {
		t.Fatalf("not applied: app = %#v, upstream = %#v", rt.CurrentApp(), rt.CurrentUpstream())
	}
}

func TestSaveSettingsRejectsBadCron(t *testing.T) {
	gin.SetMode(gin.TestMode)
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := config.Save(path, &config.Config{App: config.AppConfig{Title: "Old"}}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	r := gin.New()
	rt := newSettingsRuntime(path)
	registerSettings(r.Group("/api"), &Deps{Runtime: rt})

	// 常见的 5 段写法：写进文件的话下次启动调度器起不来，进程直接退出
	rec := putSettings(r, `{
		"app":{"title":"New","notificationPrefix":""},
		"auth":{"enabled":false},
		"scheduler":{"balanceCron":"*/15 * * * *","rateCron":"","retention":{"cron":""}},
		"notifications":{"minChangePct":0,"balanceLowCooldownMinutes":60,"sendMaxAttempts":3},
		"upstream":{}
	}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "余额采集 Cron") {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	file, err := config.LoadFile(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if file.App.Title != "Old" {
		t.Fatalf("config file must stay untouched, title = %q", file.App.Title)
	}
	if rt.CurrentApp().Title != "Old" {
		t.Fatalf("running config must stay untouched, title = %q", rt.CurrentApp().Title)
	}
}

func TestSettingsRespectEnvOverrides(t *testing.T) {
	gin.SetMode(gin.TestMode)
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := config.Save(path, &config.Config{Auth: config.AuthConfig{Enabled: false, Username: "admin", Password: "file-pass"}}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	t.Setenv("AUTH_ENABLED", "true")
	t.Setenv("ADMIN_PASSWORD", "env-pass")

	r := gin.New()
	rt := newSettingsRuntime(path)
	registerSettings(r.Group("/api"), &Deps{Runtime: rt})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings/config", nil))
	var got struct {
		Data struct {
			Config       settingsConfigView `json:"config"`
			EnvOverrides map[string]string  `json:"env_overrides"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if !got.Data.Config.Auth.Enabled {
		t.Fatal("page must show the effective value from AUTH_ENABLED")
	}
	if got.Data.Config.Auth.Password != "" {
		t.Fatalf("password from env must not be echoed, got %q", got.Data.Config.Auth.Password)
	}
	if got.Data.EnvOverrides["auth.enabled"] != "AUTH_ENABLED" || got.Data.EnvOverrides["auth.password"] != "ADMIN_PASSWORD" {
		t.Fatalf("env_overrides = %v", got.Data.EnvOverrides)
	}

	body := `{
		"app":{"title":"New","notificationPrefix":""},
		"auth":{"enabled":true,"username":"admin","password":"","tokenSecret":"","sessionTTLHours":168},
		"scheduler":{"balanceCron":"","rateCron":"","retention":{"cron":""}},
		"notifications":{"minChangePct":0,"balanceLowCooldownMinutes":60,"sendMaxAttempts":3},
		"upstream":{}
	}`
	rec = putSettings(r, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	file, err := config.LoadFile(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if file.App.Title != "New" {
		t.Fatalf("title = %q", file.App.Title)
	}
	if file.Auth.Enabled || file.Auth.Password != "file-pass" {
		t.Fatalf("env-controlled items must keep the file values, got enabled=%v password=%q", file.Auth.Enabled, file.Auth.Password)
	}
	// 文件里登录是关的，只靠 AUTH_ENABLED 开着；保存生效后必须仍然开着
	if rt.CurrentAuth() == nil {
		t.Fatal("login was turned off by saving a config file that predates AUTH_ENABLED")
	}
}

func TestSaveSettingsDegrade(t *testing.T) {
	gin.SetMode(gin.TestMode)
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := config.Save(path, &config.Config{App: config.AppConfig{Title: "Old"}}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	r := gin.New()
	rt := newSettingsRuntime(path)
	var applied config.DegradeConfig
	rt.OnApply(func(c *config.Config) { applied = c.Degrade })
	registerSettings(r.Group("/api"), &Deps{Runtime: rt})

	body := func(degradeCron, effort string) string {
		return `{
			"app":{"title":"Old","notificationPrefix":""},
			"auth":{"enabled":false},
			"scheduler":{"balanceCron":"","rateCron":"","degradeCron":"` + degradeCron + `","retention":{"cron":""}},
			"notifications":{"minChangePct":0,"balanceLowCooldownMinutes":60,"sendMaxAttempts":3},
			"upstream":{},
			"degrade":{"model":"gpt-test","effort":"` + effort + `"}
		}`
	}
	if rec := putSettings(r, body("0 0 * * *", "low")); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "降智巡检 Cron") {
		t.Fatalf("bad cron: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec := putSettings(r, body("", "extreme")); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "推理强度") {
		t.Fatalf("bad effort: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec := putSettings(r, body("0 0 */6 * * *", "high")); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	got, err := config.LoadFile(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if got.Scheduler.DegradeCron != "0 0 */6 * * *" || got.Degrade.Model != "gpt-test" || got.Degrade.Effort != "high" {
		t.Fatalf("saved scheduler = %#v degrade = %#v", got.Scheduler, got.Degrade)
	}
	// 保存后默认模型立即生效
	if applied.Model != "gpt-test" || applied.Effort != "high" {
		t.Fatalf("applied = %#v", applied)
	}
	// 留空回到默认值
	if rec := putSettings(r, body("", "")); rec.Code != http.StatusOK || applied.Effort != config.DefaultDegradeEffort {
		t.Fatalf("empty effort: status = %d, applied = %#v", rec.Code, applied)
	}
}
