package cch

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/crypto"
	"github.com/yreidev/upstream-ops/backend/notify"
	"github.com/yreidev/upstream-ops/backend/storage"
)

const recorderType storage.NotificationChannelType = "cch-test-recorder"

type recorder struct {
	mu   sync.Mutex
	msgs []notify.Message
}

func (r *recorder) Send(_ context.Context, msg notify.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, msg)
	return nil
}

func (r *recorder) Type() storage.NotificationChannelType { return recorderType }

func (r *recorder) take() []notify.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.msgs
	r.msgs = nil
	return out
}

var testRecorder = &recorder{}

func init() {
	notify.Register(recorderType, func(string) (notify.Notifier, error) { return testRecorder, nil })
}

type fakeCCH struct {
	providers []Provider
	listErr   error
	failIDs   map[int64]error
	updates   map[int64]float64
	listCalls int
}

func (f *fakeCCH) ListProviders(context.Context) ([]Provider, error) {
	f.listCalls++
	return f.providers, f.listErr
}

func (f *fakeCCH) SetCostMultiplier(_ context.Context, id int64, value float64) error {
	if err := f.failIDs[id]; err != nil {
		return err
	}
	if f.updates == nil {
		f.updates = map[int64]float64{}
	}
	f.updates[id] = value
	return nil
}

type fakeKeys map[uint][]connector.APIKey

func (f fakeKeys) ListAllAPIKeys(_ context.Context, channelID uint) ([]connector.APIKey, error) {
	if channelID == 99 {
		return nil, errors.New("boom")
	}
	return f[channelID], nil
}

type fixture struct {
	svc      *Service
	repo     *storage.CCHSync
	monLogs  *storage.MonitorLogs
	notifies *storage.Notifications
	cch      *fakeCCH
	channels map[string]uint
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	db, err := storage.Open(storage.DBConfig{Path: filepath.Join(t.TempDir(), "cch.db")})
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := storage.AutoMigrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })

	cipher, err := crypto.NewCipher("test-secret")
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	notifies := storage.NewNotifications(db)
	cfg, _ := cipher.Encrypt("{}")
	if err := notifies.CreateChannel(&storage.NotificationChannel{
		Name: "rec", Type: recorderType, ConfigCipher: cfg, Enabled: true,
		Subscriptions: `[{"channel_ids":[1],"mode":"all","events":["cch_sync","recovered"]}]`,
	}); err != nil {
		t.Fatalf("create notification channel: %v", err)
	}
	testRecorder.take()

	channels := storage.NewChannels(db)
	ids := map[string]uint{}
	for _, c := range []storage.Channel{
		{Name: "demo", SiteURL: "https://demo.example/", MonitorEnabled: true},
		{Name: "dup", SiteURL: "https://dup.example", MonitorEnabled: true},
		{Name: "paused", SiteURL: "https://paused.example", MonitorEnabled: false},
	} {
		c.Type = storage.ChannelTypeNewAPI
		c.Username = "u"
		c.PasswordCipher = "x"
		if err := channels.Create(&c); err != nil {
			t.Fatalf("create channel: %v", err)
		}
		ids[c.Name] = c.ID
	}
	keys := fakeKeys{
		ids["demo"]: {
			{ID: 1, Key: "abcd**********T0k1", Name: "pro", GroupName: "Pro 分组", GroupRatio: 0.12},
			{ID: 2, Key: "efgh**********T0k2", Name: "独享", GroupName: "独享分组", GroupRatio: 0.33},
			{ID: 3, Key: "ijkl**********nogp", Name: "旧的"},
			{ID: 4, Key: "mnop**********fail", Name: "失败", GroupName: "Gemini", GroupRatio: 0.25},
			{ID: 7, Key: "qrst**********gone", Name: "下架", Group: "retired"},
		},
		ids["dup"]: {
			{ID: 5, Key: "sk-aaaaDupX", GroupName: "a", GroupRatio: 1},
			{ID: 6, Key: "sk-bbbbDupX", GroupName: "b", GroupRatio: 2},
		},
	}

	repo := storage.NewCCHSync(db)
	monLogs := storage.NewMonitorLogs(db)
	dispatcher := notify.NewDispatcher(notifies, cipher, nil, notify.Policy{SendMaxAttempts: 1})
	svc := NewService(repo, channels, keys, monLogs, dispatcher, cipher, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	fake := &fakeCCH{}
	svc.NewClient = func(baseURL, token string) ProviderClient {
		if baseURL != "https://cch.example" || token != "admin-token" {
			t.Fatalf("client built with %q / %q", baseURL, token)
		}
		return fake
	}
	if _, err := svc.SaveSettings(SettingsInput{Enabled: true, BaseURL: "https://cch.example/api/v1/", Token: "admin-token"}); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	return &fixture{svc: svc, repo: repo, monLogs: monLogs, notifies: notifies, cch: fake, channels: ids}
}

func itemsByName(r *Result) map[string]Item {
	out := map[string]Item{}
	for _, item := range r.Items {
		out[item.ProviderName] = item
	}
	return out
}

func TestRunNowMatchesByHostAndKeyTail(t *testing.T) {
	f := newFixture(t)
	f.cch.providers = []Provider{
		{ID: 1, Name: "demo-Pro", URL: "https://demo.example/v1", MaskedKey: "sk-a••••••T0k1", CostMultiplier: 0.12},
		{ID: 2, Name: "demo-独享", URL: "https://www.DEMO.example", MaskedKey: "sk-e••••••T0k2", CostMultiplier: 0.28, IsEnabled: true},
		{ID: 3, Name: "demo-旧", URL: "https://demo.example", MaskedKey: "sk-i••••••nogp", CostMultiplier: 0.2},
		{ID: 4, Name: "demo-Gemini", URL: "https://demo.example", MaskedKey: "sk-m••••••fail", CostMultiplier: 0.2},
		{ID: 5, Name: "other", URL: "https://other.example", MaskedKey: "sk-a••••••T0k1", CostMultiplier: 1},
		{ID: 6, Name: "dup", URL: "https://dup.example", MaskedKey: "sk-a••••••DupX", CostMultiplier: 1},
		{ID: 7, Name: "paused", URL: "https://paused.example", MaskedKey: "sk-a••••••T0k1", CostMultiplier: 1},
		{ID: 8, Name: "short", URL: "https://demo.example", MaskedKey: "••••••", CostMultiplier: 1},
		{ID: 9, Name: "demo-错尾号", URL: "https://demo.example", MaskedKey: "sk-a••••••none", CostMultiplier: 1},
		{ID: 10, Name: "demo-下架", URL: "https://demo.example", MaskedKey: "sk-q••••••gone", CostMultiplier: 1},
	}
	f.cch.failIDs = map[int64]error{4: &APIError{Status: 422, Code: "validation", Detail: "bad"}}

	result, err := f.svc.RunNow(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	items := itemsByName(result)
	want := map[string]Status{
		"demo-Pro": StatusInSync, "demo-独享": StatusUpdated, "demo-旧": StatusSkipped,
		"demo-Gemini": StatusFailed, "other": StatusSkipped, "dup": StatusSkipped, "paused": StatusSkipped,
		"short": StatusSkipped, "demo-错尾号": StatusSkipped, "demo-下架": StatusSkipped,
	}
	for name, status := range want {
		if items[name].Status != status {
			t.Errorf("%s: status = %s (%s), want %s", name, items[name].Status, items[name].Reason, status)
		}
	}
	for name, reason := range map[string]string{
		"demo-旧": "密钥没有分组", "demo-下架": "密钥的分组 retired 已不在上游可用分组里", "other": "没有站点是 other.example", "dup": "有 2 把密钥尾号都是 DupX",
		"paused": "已暂停监控", "short": "没露出密钥尾号", "demo-错尾号": "没找到尾号 none",
	} {
		if !strings.Contains(items[name].Reason, reason) {
			t.Errorf("%s: reason = %q, want it to mention %q", name, items[name].Reason, reason)
		}
	}
	if got := items["demo-独享"]; got.ChannelName != "demo" || got.GroupName != "独享分组" || got.KeyName != "独享" {
		t.Errorf("matched item = %+v", got)
	}
	if len(f.cch.updates) != 1 || f.cch.updates[2] != 0.33 {
		t.Fatalf("updates = %v, want only provider 2 -> 0.33", f.cch.updates)
	}
	if result.Updated != 1 || result.Failed != 1 || result.InSync != 1 || result.Skipped != 7 || !result.Applied {
		t.Fatalf("counts = %+v", result)
	}

	msgs := testRecorder.take()
	if len(msgs) != 1 || msgs[0].Event != storage.EventCCHSync || msgs[0].Subject != "【CCH 成本倍率同步】已改 1 个供应商" ||
		!strings.Contains(msgs[0].Body, "**demo-独享**：`0.28x` 上涨 `0.33x`（demo · 独享分组）") ||
		!strings.Contains(msgs[0].Body, "修改失败（1）") {
		t.Fatalf("notifications = %+v", msgs)
	}

	logs, _ := f.monLogs.List(0, 10)
	if len(logs) != 1 || logs[0].Job != storage.MonitorJobCCHSync || logs[0].Success || logs[0].ChannelID != 0 ||
		!strings.Contains(logs[0].ErrorMessage, "demo-Gemini：CCH 返回 422 validation：bad") {
		t.Fatalf("monitor logs = %+v", logs)
	}
	cfg, _ := f.repo.Get()
	if cfg.LastRunAt == nil || cfg.LastSummary != "改了 1 个，修改失败 1 个，已一致 1 个，未同步 7 个" || cfg.LastError == "" {
		t.Fatalf("recorded run = %+v", cfg)
	}
}

func TestPreviewDoesNotChangeAnything(t *testing.T) {
	f := newFixture(t)
	f.cch.providers = []Provider{
		{ID: 2, Name: "demo-独享", URL: "https://demo.example", MaskedKey: "sk-e••••••T0k2", CostMultiplier: 0.28},
	}
	result, err := f.svc.Preview(context.Background())
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if result.Applied || result.Pending != 1 || result.Items[0].Target == nil || *result.Items[0].Target != 0.33 {
		t.Fatalf("preview = %+v", result)
	}
	if len(f.cch.updates) != 0 {
		t.Fatalf("preview must not update CCH: %v", f.cch.updates)
	}
	if logs, _ := f.monLogs.List(0, 10); len(logs) != 0 {
		t.Fatalf("preview must not write monitor logs: %+v", logs)
	}
	if msgs := testRecorder.take(); len(msgs) != 0 {
		t.Fatalf("preview must not notify: %+v", msgs)
	}
}

func TestRunScheduledRespectsSwitch(t *testing.T) {
	f := newFixture(t)
	if _, err := f.svc.SaveSettings(SettingsInput{Enabled: false, BaseURL: "https://cch.example"}); err != nil {
		t.Fatalf("disable: %v", err)
	}
	f.svc.RunScheduled(context.Background())
	if f.cch.listCalls != 0 {
		t.Fatalf("disabled sync must not call CCH, got %d calls", f.cch.listCalls)
	}

	if _, err := f.svc.SaveSettings(SettingsInput{Enabled: true, BaseURL: "https://cch.example"}); err != nil {
		t.Fatalf("enable keeps the saved token: %v", err)
	}
	f.svc.RunScheduled(context.Background())
	if f.cch.listCalls != 1 {
		t.Fatalf("enabled sync must call CCH once, got %d", f.cch.listCalls)
	}
}

func TestRunNowUnauthorizedNotifiesThenRecovers(t *testing.T) {
	f := newFixture(t)
	f.cch.listErr = &APIError{Status: 401, Code: "auth.invalid", Detail: "Authentication is invalid or expired."}

	if _, err := f.svc.RunNow(context.Background()); err == nil || !IsUnauthorized(err) {
		t.Fatalf("want unauthorized error, got %v", err)
	}
	msgs := testRecorder.take()
	if len(msgs) != 1 || msgs[0].Subject != "CCH 倍率同步失败" || !strings.Contains(msgs[0].Body, "请到设置页检查 CCH 令牌") {
		t.Fatalf("unauthorized must notify immediately: %+v", msgs)
	}
	cfg, _ := f.repo.Get()
	if !strings.Contains(cfg.LastError, "401") || cfg.LastSummary != "" {
		t.Fatalf("recorded run = %+v", cfg)
	}

	f.cch.listErr = nil
	if _, err := f.svc.RunNow(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}
	msgs = testRecorder.take()
	if len(msgs) != 1 || msgs[0].Event != storage.EventRecovered || msgs[0].Subject != "CCH 倍率同步已恢复" {
		t.Fatalf("want a recovery notification, got %+v", msgs)
	}
}

func TestSaveSettings(t *testing.T) {
	f := newFixture(t)
	view, err := f.svc.Settings()
	if err != nil || !view.Enabled || view.BaseURL != "https://cch.example" || !view.TokenSet {
		t.Fatalf("settings = %+v, %v", view, err)
	}
	cfg, _ := f.repo.Get()
	if cfg.TokenCipher == "" || strings.Contains(cfg.TokenCipher, "admin-token") {
		t.Fatalf("token must be stored encrypted: %q", cfg.TokenCipher)
	}

	if _, err := f.svc.SaveSettings(SettingsInput{Enabled: true}); err == nil {
		t.Fatal("enabling without base url must fail")
	}
	if _, err := f.svc.SaveSettings(SettingsInput{BaseURL: "cch.example"}); err == nil {
		t.Fatal("base url without scheme must fail")
	}

	fresh := newFixture(t)
	if err := fresh.repo.SaveSettings(false, "", nil); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if _, err := fresh.svc.Preview(context.Background()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("preview without base url = %v, want ErrNotConfigured", err)
	}
}

func TestVisibleTailAndHost(t *testing.T) {
	for key, want := range map[string]string{
		"sk-a••••••T0k1":     "T0k1",
		"abcd**********wxyz": "wxyz",
		"sk-full-key-1234":   "1234",
		"••••••":             "",
		"abcd****":           "",
		"abc":                "",
	} {
		if got := visibleTail(key); got != want {
			t.Errorf("visibleTail(%q) = %q, want %q", key, got, want)
		}
	}
	for raw, want := range map[string]string{
		"https://www.Example.com:8443/v1": "example.com",
		"http://10.0.0.1:3000":            "10.0.0.1",
		"not a url":                       "",
	} {
		if got := hostOf(raw); got != want {
			t.Errorf("hostOf(%q) = %q, want %q", raw, got, want)
		}
	}
}
