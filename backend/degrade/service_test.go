package degrade

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/crypto"
	"github.com/yreidev/upstream-ops/backend/notify"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// 测试里的密钥都是编的。
const (
	testFullKey = "sk-test-0000000000000000T0k1"
	testMasked  = "sk-tes**********T0k1"
)

type fakeKeys struct {
	keys      map[uint][]connector.APIKey
	revealErr error
}

func (f *fakeKeys) ListAllAPIKeys(_ context.Context, channelID uint) ([]connector.APIKey, error) {
	return f.keys[channelID], nil
}

func (f *fakeKeys) RevealAPIKey(context.Context, uint, int64) (string, error) {
	if f.revealErr != nil {
		return "", f.revealErr
	}
	return testFullKey, nil
}

type fakeNotifier struct {
	mu   sync.Mutex
	msgs []notify.Message
}

func (f *fakeNotifier) Dispatch(_ context.Context, msg notify.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs = append(f.msgs, msg)
	return nil
}

// script 按顺序给出每次提问的结果："ok" 答对、"bad" 答错、"err" 请求失败。
type script struct {
	mu      sync.Mutex
	answers []string
	calls   []string // 每次提问用的模型和推理强度
	keys    []string
}

func (s *script) ask(_ context.Context, _, apiKey, _, model, effort string) (Answer, time.Duration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, model+"/"+effort)
	s.keys = append(s.keys, apiKey)
	if len(s.answers) == 0 {
		return Answer{}, 0, errors.New("script exhausted")
	}
	next := s.answers[0]
	s.answers = s.answers[1:]
	switch next {
	case "ok":
		return Answer{Text: "最少要取 21 个。", InputTokens: 100, OutputTokens: 10}, time.Second, nil
	case "bad":
		return Answer{Text: "最少要取 29 个。"}, time.Second, nil
	default:
		return Answer{}, 0, errors.New("中转站返回 503")
	}
}

type env struct {
	svc      *Service
	repo     *storage.DegradeKeys
	keys     *fakeKeys
	notifier *fakeNotifier
	script   *script
	channel  *storage.Channel
	waited   bool
}

func newEnv(t *testing.T) *env {
	t.Helper()
	db, err := storage.Open(storage.DBConfig{Path: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := storage.AutoMigrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })

	channels := storage.NewChannels(db)
	ch := &storage.Channel{Name: "演示站", Type: storage.ChannelType("sub2api"), SiteURL: "https://relay.example.com", Username: "u", PasswordCipher: "x"}
	if err := channels.Create(ch); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	cipher, err := crypto.NewCipher("test-secret-test-secret-test-secret")
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	e := &env{
		repo:     storage.NewDegradeKeys(db),
		keys:     &fakeKeys{keys: map[uint][]connector.APIKey{ch.ID: {{ID: 7, Name: "演示密钥", Key: testMasked, GroupName: "演示分组"}}}},
		notifier: &fakeNotifier{},
		script:   &script{},
		channel:  ch,
	}
	e.svc = NewService(e.repo, channels, e.keys, e.notifier, cipher, slog.New(slog.NewTextHandler(io.Discard, nil)))
	e.svc.Ask = e.script.ask
	e.svc.RecoveryWait = 0
	return e
}

// addKey 加入演示密钥并把状态设成 state。
func (e *env) addKey(t *testing.T, state storage.DegradeState) *storage.DegradeKey {
	t.Helper()
	k, err := e.svc.Add(context.Background(), AddInput{ChannelID: e.channel.ID, UpstreamKeyID: 7})
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if state != storage.DegradeUnknown {
		if err := e.repo.RecordRound(k.ID, time.Now(), storage.DegradeCorrect, "", state); err != nil {
			t.Fatalf("set state: %v", err)
		}
	}
	return k
}

func (e *env) run(t *testing.T, id uint, answers ...string) (*Round, error) {
	t.Helper()
	e.script.answers = answers
	_, result, err := e.svc.CheckOne(id)(context.Background())
	round, _ := result.(*Round)
	return round, err
}

func TestRoundRules(t *testing.T) {
	cases := []struct {
		name     string
		before   storage.DegradeState
		answers  []string
		after    storage.DegradeState
		asks     int
		notified bool
		failed   bool
	}{
		{"新密钥三次答对，定为正常、不通知", storage.DegradeUnknown, []string{"ok", "ok", "ok"}, storage.DegradeNormal, 3, false, false},
		{"新密钥三次答错，确认降智并通知", storage.DegradeUnknown, []string{"bad", "bad", "bad"}, storage.DegradeDegraded, 3, true, false},
		{"新密钥结果不一致，保持未确认", storage.DegradeUnknown, []string{"ok", "bad", "ok"}, storage.DegradeUnknown, 3, false, false},
		{"正常首测答对，不复测", storage.DegradeNormal, []string{"ok"}, storage.DegradeNormal, 1, false, false},
		{"正常首测答错、复测都错，确认降智", storage.DegradeNormal, []string{"bad", "bad", "bad"}, storage.DegradeDegraded, 3, true, false},
		{"正常首测答错、复测有对，保持正常", storage.DegradeNormal, []string{"bad", "ok", "bad"}, storage.DegradeNormal, 3, false, false},
		{"降智首测答错，不复测", storage.DegradeDegraded, []string{"bad"}, storage.DegradeDegraded, 1, false, false},
		{"降智三次答对，确认恢复并通知", storage.DegradeDegraded, []string{"ok", "ok", "ok"}, storage.DegradeNormal, 3, true, false},
		{"降智首测答对、复测有错，保持降智", storage.DegradeDegraded, []string{"ok", "bad", "ok"}, storage.DegradeDegraded, 3, false, false},
		{"首测请求失败，状态不变", storage.DegradeNormal, []string{"err"}, storage.DegradeNormal, 1, false, true},
		{"复测请求失败，状态不变", storage.DegradeNormal, []string{"bad", "bad", "err"}, storage.DegradeNormal, 3, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			k := e.addKey(t, tc.before)
			round, err := e.run(t, k.ID, tc.answers...)
			if (err != nil) != tc.failed {
				t.Fatalf("err = %v, want failed=%v", err, tc.failed)
			}
			if round == nil || round.State != tc.after || len(round.Results) != tc.asks {
				t.Fatalf("round = %+v", round)
			}
			got, _ := e.repo.Get(k.ID)
			if got.State != tc.after || got.LastCheckedAt == nil || got.LastMessage != round.Message {
				t.Fatalf("stored key = %+v", got)
			}
			if (len(e.notifier.msgs) == 1) != tc.notified || len(e.notifier.msgs) > 1 {
				t.Fatalf("notifications = %+v", e.notifier.msgs)
			}
			checks, _ := e.repo.ListChecks(k.ID, 10)
			if len(checks) != tc.asks {
				t.Fatalf("checks = %d, want %d", len(checks), tc.asks)
			}
		})
	}
}

func TestNotificationNamesKeyAndVerdict(t *testing.T) {
	e := newEnv(t)
	k := e.addKey(t, storage.DegradeNormal)
	if _, err := e.run(t, k.ID, "bad", "bad", "bad"); err != nil {
		t.Fatalf("run: %v", err)
	}
	msg := e.notifier.msgs[0]
	if msg.Event != storage.EventDegrade || msg.ChannelID != e.channel.ID ||
		!strings.Contains(msg.Subject, "演示站 · 演示密钥") || !strings.Contains(msg.Subject, "确认降智") ||
		!strings.Contains(msg.Body, "演示分组") || !strings.Contains(msg.Body, "gpt-6.1-sol · low") {
		t.Fatalf("message = %+v", msg)
	}
	if strings.Contains(msg.Body, testFullKey) {
		t.Fatal("notification must not contain the full key")
	}
}

func TestRecoveryWaitsBeforeRetest(t *testing.T) {
	e := newEnv(t)
	k := e.addKey(t, storage.DegradeDegraded)
	e.svc.RecoveryWait = time.Hour
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	e.script.answers = []string{"ok", "ok", "ok"}
	_, _, err := e.svc.CheckOne(k.ID)(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the wait to be cut by the job timeout", err)
	}
	if len(e.script.calls) != 1 {
		t.Fatalf("must not retest before the wait ends, asked %d times", len(e.script.calls))
	}
	got, _ := e.repo.Get(k.ID)
	if got.State != storage.DegradeDegraded {
		t.Fatalf("state = %s", got.State)
	}
}

func TestModelAndEffortOverrides(t *testing.T) {
	e := newEnv(t)
	k := e.addKey(t, storage.DegradeNormal)
	e.svc.UpdateDefaults(config.DegradeConfig{Model: "gpt-default", Effort: "medium"})
	if _, err := e.run(t, k.ID, "ok"); err != nil {
		t.Fatalf("run: %v", err)
	}
	if _, err := e.svc.UpdateModel(k.ID, "gpt-own", "none"); err != nil {
		t.Fatalf("update model: %v", err)
	}
	if _, err := e.run(t, k.ID, "ok"); err != nil {
		t.Fatalf("run: %v", err)
	}
	// none 表示不带推理强度
	if strings.Join(e.script.calls, ",") != "gpt-default/medium,gpt-own/" {
		t.Fatalf("calls = %v", e.script.calls)
	}
	if e.script.keys[0] != testFullKey {
		t.Fatal("check must use the decrypted full key")
	}
	if _, err := e.svc.UpdateModel(k.ID, "", "extreme"); err == nil {
		t.Fatal("unknown effort must be rejected")
	}
}

func TestAddKey(t *testing.T) {
	e := newEnv(t)
	k := e.addKey(t, storage.DegradeUnknown)
	if k.KeySource != storage.DegradeKeyRevealed || k.KeyTail != "T0k1" || k.Name != "演示密钥" || k.GroupName != "演示分组" ||
		k.KeyCipher == "" || strings.Contains(k.KeyCipher, testFullKey) {
		t.Fatalf("key = %+v", k)
	}
	if _, err := e.svc.Add(context.Background(), AddInput{ChannelID: e.channel.ID, UpstreamKeyID: 7}); err == nil {
		t.Fatal("adding the same key twice must fail")
	}
	if _, err := e.svc.Add(context.Background(), AddInput{ChannelID: e.channel.ID, UpstreamKeyID: 8}); err == nil {
		t.Fatal("unknown upstream key must be rejected")
	}
}

func TestAddKeyFallsBackToPasted(t *testing.T) {
	e := newEnv(t)
	e.keys.revealErr = errors.New("status 403: browser origin required")
	_, err := e.svc.Add(context.Background(), AddInput{ChannelID: e.channel.ID, UpstreamKeyID: 7})
	var reveal *RevealError
	if !errors.As(err, &reveal) {
		t.Fatalf("err = %v, want RevealError", err)
	}
	if _, err := e.svc.Add(context.Background(), AddInput{ChannelID: e.channel.ID, UpstreamKeyID: 7, Key: "sk-test-0000000000000000Xxxx"}); err == nil ||
		!strings.Contains(err.Error(), "对不上") {
		t.Fatalf("mismatched tail: err = %v", err)
	}
	k, err := e.svc.Add(context.Background(), AddInput{ChannelID: e.channel.ID, UpstreamKeyID: 7, Key: "  " + testFullKey + " "})
	if err != nil || k.KeySource != storage.DegradeKeyPasted {
		t.Fatalf("pasted: %+v, %v", k, err)
	}
	if _, err := e.run(t, k.ID, "ok", "ok", "ok"); err != nil || e.script.keys[0] != testFullKey {
		t.Fatalf("run with pasted key: %v, %v", err, e.script.keys)
	}
}

func TestCheckAllSummary(t *testing.T) {
	e := newEnv(t)
	k := e.addKey(t, storage.DegradeNormal)
	e.keys.keys[e.channel.ID] = append(e.keys.keys[e.channel.ID], connector.APIKey{ID: 8, Name: "第二把", Key: "sk-tes**********T0k1"})
	second, err := e.svc.Add(context.Background(), AddInput{ChannelID: e.channel.ID, UpstreamKeyID: 8})
	if err != nil {
		t.Fatalf("add second: %v", err)
	}
	// 第二把正在单独检测，这次跳过
	if !e.svc.lock(second.ID) {
		t.Fatal("lock")
	}
	e.script.answers = []string{"bad", "bad", "bad"}
	msg, result, err := e.svc.CheckAll(context.Background())
	e.svc.unlock(second.ID)
	if err != nil {
		t.Fatalf("check all: %v", err)
	}
	sum := result.(*Summary)
	if sum.Total != 2 || sum.Degraded != 1 || sum.Busy != 1 || len(sum.Changes) != 1 {
		t.Fatalf("summary = %+v", sum)
	}
	if !strings.Contains(msg, "2 把密钥") || !strings.Contains(msg, "跳过 1") || !strings.Contains(msg, "确认降智") {
		t.Fatalf("message = %s", msg)
	}
	if got, _ := e.repo.Get(k.ID); got.State != storage.DegradeDegraded {
		t.Fatalf("state = %s", got.State)
	}
}

func TestRemoveDeletesChecks(t *testing.T) {
	e := newEnv(t)
	k := e.addKey(t, storage.DegradeNormal)
	if _, err := e.run(t, k.ID, "ok"); err != nil {
		t.Fatalf("run: %v", err)
	}
	if err := e.svc.Remove(k.ID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if checks, _ := e.repo.ListChecks(k.ID, 10); len(checks) != 0 {
		t.Fatalf("checks left: %d", len(checks))
	}
}
