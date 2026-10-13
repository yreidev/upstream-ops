package storage

import (
	"encoding/json"
	"testing"
	"time"
)

func TestMigrateNotificationSubscriptions(t *testing.T) {
	db := openTestDB(t)
	// openTestDB 已经跑过一次迁移；清掉标记，模拟从旧版本升级。
	if err := db.Where("1 = 1").Delete(&AppliedMigration{}).Error; err != nil {
		t.Fatalf("reset migrations: %v", err)
	}

	base := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	var upstreamIDs []uint
	for i, created := range []time.Time{base, base.Add(time.Hour), base.Add(48 * time.Hour)} {
		ch := &Channel{Name: string(rune('a' + i)), Type: ChannelTypeNewAPI, SiteURL: "https://x.example", PasswordCipher: "x"}
		if err := db.Create(ch).Error; err != nil {
			t.Fatalf("create channel: %v", err)
		}
		if err := db.Model(&Channel{}).Where("id = ?", ch.ID).UpdateColumn("created_at", created).Error; err != nil {
			t.Fatalf("set created_at: %v", err)
		}
		upstreamIDs = append(upstreamIDs, ch.ID)
	}
	first, second := upstreamIDs[0], upstreamIDs[1]
	savedAt := base.Add(24 * time.Hour) // 第三个上游是通知渠道保存之后才加的

	subs := func(v any) string {
		raw, _ := json.Marshal(v)
		return string(raw)
	}
	fixtures := []NotificationChannel{
		{Name: "covers-all", Type: NotifyTelegram, ConfigCipher: "x", Enabled: true, Subscriptions: subs([]map[string]any{{
			"channel_ids": []uint{second, first},
			"mode":        "all",
			"events":      []string{"balance_low", "captcha_failed", "subscription_expiring", "login_failed"},
		}})},
		{Name: "partial", Type: NotifyWecom, ConfigCipher: "x", Enabled: true, Subscriptions: subs([]map[string]any{{
			"channel_ids": []uint{first},
			"mode":        "all",
		}})},
		{Name: "groups", Type: NotifyWecom, ConfigCipher: "x", Enabled: true, Subscriptions: subs([]map[string]any{{
			"channel_ids": []uint{first, second},
			"mode":        "groups",
			"groups":      []string{"default"},
			"events":      []string{"rate_changed"},
		}})},
		{Name: "empty", Type: NotifyWecom, ConfigCipher: "x", Enabled: true, Subscriptions: "[]"},
		{Name: "broken", Type: NotifyWecom, ConfigCipher: "x", Enabled: true, Subscriptions: "not json"},
	}
	for i := range fixtures {
		if err := db.Create(&fixtures[i]).Error; err != nil {
			t.Fatalf("create %s: %v", fixtures[i].Name, err)
		}
		if err := db.Model(&NotificationChannel{}).Where("id = ?", fixtures[i].ID).UpdateColumn("updated_at", savedAt).Error; err != nil {
			t.Fatalf("set updated_at: %v", err)
		}
	}

	if err := runDataMigrations(db); err != nil {
		t.Fatalf("run migrations: %v", err)
	}

	load := func(name string) (NotificationChannel, []map[string]any) {
		t.Helper()
		var nc NotificationChannel
		if err := db.Where("name = ?", name).Take(&nc).Error; err != nil {
			t.Fatalf("load %s: %v", name, err)
		}
		var out []map[string]any
		_ = json.Unmarshal([]byte(nc.Subscriptions), &out)
		return nc, out
	}

	nc, got := load("covers-all")
	if got[0]["all_channels"] != true {
		t.Fatalf("covers-all: all_channels = %v, want true (%s)", got[0]["all_channels"], nc.Subscriptions)
	}
	if ids := got[0]["channel_ids"].([]any); len(ids) != 2 {
		t.Fatalf("covers-all: channel_ids must be kept for rollback, got %v", ids)
	}
	// 最后的 cch_sync、degrade 是后面的 20261013_subscription_cch_sync_event、20261013_subscription_degrade_event 补上的。
	wantEvents := []any{"balance_low", "captcha_failed", "login_failed", "monitor_failed", "recovered", "cch_sync", "degrade"}
	if events := got[0]["events"].([]any); !equalAny(events, wantEvents) {
		t.Fatalf("covers-all: events = %v, want %v", events, wantEvents)
	}
	if !nc.UpdatedAt.Equal(savedAt) {
		t.Fatalf("covers-all: updated_at changed to %s", nc.UpdatedAt)
	}

	if _, got := load("partial"); got[0]["all_channels"] != nil || got[0]["events"] != nil {
		t.Fatalf("partial subscription must stay untouched: %v", got)
	}
	if _, got := load("groups"); got[0]["all_channels"] != nil {
		t.Fatalf("groups-mode subscription must not become all_channels: %v", got)
	} else if events := got[0]["events"].([]any); !equalAny(events, []any{"rate_changed", "login_failed", "monitor_failed", "recovered", "cch_sync", "degrade"}) {
		t.Fatalf("groups: events = %v", events)
	}
	if nc, _ := load("empty"); nc.Subscriptions != "[]" {
		t.Fatalf("empty subscriptions changed: %s", nc.Subscriptions)
	}
	if nc, _ := load("broken"); nc.Subscriptions != "not json" {
		t.Fatalf("broken subscriptions changed: %s", nc.Subscriptions)
	}

	// 标记写入后再跑不会重复执行：手工改回去的规则保持原样。
	if err := db.Model(&NotificationChannel{}).Where("name = ?", "partial").
		UpdateColumn("subscriptions", subs([]map[string]any{{"channel_ids": []uint{first, second}, "mode": "all"}})).Error; err != nil {
		t.Fatalf("edit partial: %v", err)
	}
	if err := runDataMigrations(db); err != nil {
		t.Fatalf("rerun migrations: %v", err)
	}
	if _, got := load("partial"); got[0]["all_channels"] != nil {
		t.Fatalf("migration ran twice: %v", got)
	}
}

func TestRedactNotificationLogSecretsMigration(t *testing.T) {
	db := openTestDB(t)
	if err := db.Where("1 = 1").Delete(&AppliedMigration{}).Error; err != nil {
		t.Fatalf("reset migrations: %v", err)
	}
	now := time.Now()
	logs := []NotificationLog{
		{ChannelID: 1, Event: EventBalanceLow, Subject: "a", SentAt: now,
			ErrorMessage: `Post "https://api.telegram.org/bot123:ABC-def/sendMessage": context deadline exceeded`},
		{ChannelID: 2, Event: EventBalanceLow, Subject: "b", SentAt: now,
			ErrorMessage: `Post "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123": i/o timeout`},
		{ChannelID: 1, Event: EventBalanceLow, Subject: "c", SentAt: now, ErrorMessage: "telegram returned 429 Too Many Requests"},
	}
	for i := range logs {
		if err := db.Create(&logs[i]).Error; err != nil {
			t.Fatalf("create log: %v", err)
		}
	}
	if err := runDataMigrations(db); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
	want := []string{
		`Post "https://api.telegram.org/bot***/sendMessage": context deadline exceeded`,
		`Post "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***": i/o timeout`,
		"telegram returned 429 Too Many Requests",
	}
	for i := range logs {
		var got NotificationLog
		if err := db.Take(&got, logs[i].ID).Error; err != nil {
			t.Fatalf("load log: %v", err)
		}
		if got.ErrorMessage != want[i] {
			t.Errorf("log %d = %q, want %q", i, got.ErrorMessage, want[i])
		}
	}
}

func TestNotificationFailureStates(t *testing.T) {
	repo := NewNotifications(openTestDB(t))
	t0 := time.Date(2026, 10, 13, 1, 0, 0, 0, time.UTC)

	st, err := repo.RecordFailure(7, "login", "first", t0)
	if err != nil || st.Failures != 1 || !st.FirstFailedAt.Equal(t0) {
		t.Fatalf("first failure = %+v, %v", st, err)
	}
	st, err = repo.RecordFailure(7, "login", "second", t0.Add(15*time.Minute))
	if err != nil || st.Failures != 2 || !st.FirstFailedAt.Equal(t0) || st.LastError != "second" {
		t.Fatalf("second failure = %+v, %v", st, err)
	}
	if err := repo.MarkFailureNotified(7, "login", t0.Add(15*time.Minute)); err != nil {
		t.Fatalf("mark notified: %v", err)
	}
	if _, err := repo.RecordFailure(7, "rates", "x", t0); err != nil {
		t.Fatalf("record rates: %v", err)
	}

	cleared, err := repo.ClearFailures(7, []string{"login", "captcha"})
	if err != nil || len(cleared) != 1 || cleared[0].Kind != "login" || cleared[0].NotifiedAt == nil || cleared[0].Failures != 2 {
		t.Fatalf("clear = %+v, %v", cleared, err)
	}
	if cleared, err := repo.ClearFailures(7, []string{"login"}); err != nil || len(cleared) != 0 {
		t.Fatalf("second clear = %+v, %v", cleared, err)
	}
	if st, err := repo.RecordFailure(7, "rates", "y", t0.Add(time.Minute)); err != nil || st.Failures != 2 {
		t.Fatalf("other kind must be untouched: %+v, %v", st, err)
	}
}

func equalAny(a, b []any) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestAddSubscriptionEvent(t *testing.T) {
	db := openTestDB(t)
	fixtures := []NotificationChannel{
		{Name: "picked", Type: NotifyTelegram, ConfigCipher: "x", Enabled: true,
			Subscriptions: `[{"channel_ids":[1],"mode":"all","events":["rate_changed","recovered"]},{"channel_ids":[2],"mode":"all"}]`},
		{Name: "already", Type: NotifyWecom, ConfigCipher: "x", Enabled: true,
			Subscriptions: `[{"channel_ids":[1],"mode":"all","events":["cch_sync","degrade"]}]`},
		{Name: "everything", Type: NotifyWecom, ConfigCipher: "x", Enabled: true, Subscriptions: "[]"},
		{Name: "broken", Type: NotifyWecom, ConfigCipher: "x", Enabled: true, Subscriptions: "not json"},
	}
	for i := range fixtures {
		if err := db.Create(&fixtures[i]).Error; err != nil {
			t.Fatalf("create %s: %v", fixtures[i].Name, err)
		}
	}
	// 按发布顺序先补 CCH 同步，再补降智检测
	for _, event := range []NotificationEvent{EventCCHSync, EventDegrade} {
		if err := addSubscriptionEvent(event)(db); err != nil {
			t.Fatalf("migrate %s: %v", event, err)
		}
	}

	got := map[string]string{}
	var rows []NotificationChannel
	if err := db.Order("id").Find(&rows).Error; err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, r := range rows {
		got[r.Name] = r.Subscriptions
	}
	want := map[string]string{
		"picked":     `[{"channel_ids":[1],"events":["rate_changed","recovered","cch_sync","degrade"],"mode":"all"},{"channel_ids":[2],"mode":"all"}]`,
		"already":    fixtures[1].Subscriptions,
		"everything": "[]",
		"broken":     "not json",
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s subscriptions = %s, want %s", name, got[name], w)
		}
	}
}
