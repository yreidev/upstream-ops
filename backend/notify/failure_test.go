package notify

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yreidev/upstream-ops/backend/crypto"
	"github.com/yreidev/upstream-ops/backend/storage"
)

const recorderType storage.NotificationChannelType = "test-recorder"

type recorder struct {
	mu   sync.Mutex
	msgs []Message
}

func (r *recorder) Send(_ context.Context, msg Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, msg)
	return nil
}

func (r *recorder) Type() storage.NotificationChannelType { return recorderType }

func (r *recorder) take() []Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.msgs
	r.msgs = nil
	return out
}

var testRecorder = &recorder{}

func init() {
	Register(recorderType, func(string) (Notifier, error) { return testRecorder, nil })
}

func newTestDispatcher(t *testing.T, subscriptions string) (*Dispatcher, *storage.Notifications) {
	t.Helper()
	db, err := storage.Open(storage.DBConfig{Path: filepath.Join(t.TempDir(), "notify.db")})
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
	cfg, _ := cipher.Encrypt("{}")
	repo := storage.NewNotifications(db)
	if err := repo.CreateChannel(&storage.NotificationChannel{
		Name: "rec", Type: recorderType, ConfigCipher: cfg, Subscriptions: subscriptions, Enabled: true,
	}); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	testRecorder.take()
	return NewDispatcher(repo, cipher, nil, Policy{SendMaxAttempts: 1}), repo
}

// backdate 把失败状态的时间往前挪，模拟定时任务隔了一段时间再次失败。
func backdate(t *testing.T, repo *storage.Notifications, channelID uint, kind FailureKind, d time.Duration) {
	t.Helper()
	cleared, err := repo.ClearFailures(channelID, []string{string(kind)})
	if err != nil || len(cleared) != 1 {
		t.Fatalf("load state: %+v, %v", cleared, err)
	}
	st := cleared[0]
	first := st.FirstFailedAt.Add(-d)
	for i := 0; i < st.Failures; i++ {
		if _, err := repo.RecordFailure(channelID, string(kind), st.LastError, first); err != nil {
			t.Fatalf("restore state: %v", err)
		}
	}
	if st.NotifiedAt != nil {
		if err := repo.MarkFailureNotified(channelID, string(kind), st.NotifiedAt.Add(-d)); err != nil {
			t.Fatalf("restore notified_at: %v", err)
		}
	}
}

func TestReportFailureWaitsForConsecutiveFailures(t *testing.T) {
	d, repo := newTestDispatcher(t, "[]")
	ctx := context.Background()
	fail := Failure{ChannelID: 3, ChannelName: "mdkj", Kind: FailureCosts, Err: errors.New("status 404")}

	_ = d.ReportFailure(ctx, fail)
	_ = d.ReportFailure(ctx, fail) // 同一轮里马上又失败：次数够了但持续时间不够
	if got := testRecorder.take(); len(got) != 0 {
		t.Fatalf("notified too early: %+v", got)
	}

	backdate(t, repo, 3, FailureCosts, 15*time.Minute)
	_ = d.ReportFailure(ctx, fail)
	got := testRecorder.take()
	if len(got) != 1 {
		t.Fatalf("want 1 notification after 15 minutes, got %+v", got)
	}
	if got[0].Event != storage.EventMonitorFailed || got[0].Subject != "mdkj 消费采集失败" ||
		!strings.Contains(got[0].Body, "连续失败 3 次") || !strings.Contains(got[0].Body, "status 404") {
		t.Fatalf("unexpected message: %+v", got[0])
	}

	_ = d.ReportFailure(ctx, fail)
	if got := testRecorder.take(); len(got) != 0 {
		t.Fatalf("must not repeat before the reminder interval: %+v", got)
	}
	backdate(t, repo, 3, FailureCosts, failureRemindInterval)
	_ = d.ReportFailure(ctx, fail)
	if got := testRecorder.take(); len(got) != 1 || !strings.Contains(got[0].Body, "仍未恢复") {
		t.Fatalf("want a reminder after %s, got %+v", failureRemindInterval, got)
	}

	_ = d.ReportSuccess(ctx, 3, "mdkj", FailureBalance, FailureCosts)
	got = testRecorder.take()
	if len(got) != 1 || got[0].Event != storage.EventRecovered || got[0].Subject != "mdkj 消费采集已恢复" {
		t.Fatalf("want a recovery notification, got %+v", got)
	}
	_ = d.ReportSuccess(ctx, 3, "mdkj", FailureCosts)
	if got := testRecorder.take(); len(got) != 0 {
		t.Fatalf("recovery must be sent once: %+v", got)
	}
}

func TestReportFailureImmediateAndSilentRecovery(t *testing.T) {
	d, _ := newTestDispatcher(t, "[]")
	ctx := context.Background()

	_ = d.ReportFailure(ctx, Failure{ChannelID: 5, ChannelName: "windapi", Kind: FailureLogin, Err: errors.New("bad password"), Immediate: true})
	if got := testRecorder.take(); len(got) != 1 || got[0].Event != storage.EventLoginFailed || got[0].Body != "bad password" {
		t.Fatalf("permanent failure must notify at once: %+v", got)
	}

	// 没通知过的失败，恢复时不发恢复通知。
	_ = d.ReportFailure(ctx, Failure{ChannelID: 5, ChannelName: "windapi", Kind: FailureRates, Err: errors.New("timeout")})
	_ = d.ReportSuccess(ctx, 5, "windapi", FailureRates)
	if got := testRecorder.take(); len(got) != 0 {
		t.Fatalf("silent failure must recover silently: %+v", got)
	}
}

func TestReportFailureHonorsSubscriptions(t *testing.T) {
	d, _ := newTestDispatcher(t, `[{"channel_ids":[1],"all_channels":true,"mode":"all","events":["captcha_failed"]}]`)
	ctx := context.Background()

	_ = d.ReportFailure(ctx, Failure{ChannelID: 9, ChannelName: "new", Kind: FailureLogin, Err: errors.New("x"), Immediate: true})
	if got := testRecorder.take(); len(got) != 0 {
		t.Fatalf("login_failed is not subscribed: %+v", got)
	}
	_ = d.ReportFailure(ctx, Failure{ChannelID: 9, ChannelName: "new", Kind: FailureCaptcha, Err: errors.New("ERROR_ZERO_BALANCE"), Immediate: true})
	if got := testRecorder.take(); len(got) != 1 || got[0].Subject != "new 打码失败" {
		t.Fatalf("captcha_failed for a later upstream must reach all_channels subscription: %+v", got)
	}
}

func TestFormatFailureDuration(t *testing.T) {
	cases := map[time.Duration]string{
		30 * time.Second:            "不到 1 分钟",
		45 * time.Minute:            "45 分钟",
		2 * time.Hour:               "2 小时",
		2*time.Hour + 5*time.Minute: "2 小时 5 分钟",
		50 * time.Hour:              "2 天 2 小时",
		72 * time.Hour:              "3 天",
	}
	for in, want := range cases {
		if got := formatFailureDuration(in); got != want {
			t.Errorf("formatFailureDuration(%s) = %q, want %q", in, got, want)
		}
	}
}
