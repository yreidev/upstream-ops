package channel

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/storage"
)

func TestEnsureSessionTransientCheckKeepsSession(t *testing.T) {
	var refreshCalls, loginCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/user/self", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "<html><title>502 Bad Gateway</title></html>", http.StatusBadGateway)
	})
	mux.HandleFunc("/api/user/auth/refresh", func(w http.ResponseWriter, r *http.Request) { refreshCalls.Add(1) })
	mux.HandleFunc("/api/user/login", func(w http.ResponseWriter, r *http.Request) { loginCalls.Add(1) })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	svc, ch, resolved, conn := newStoredNewAPIChannel(t, srv.URL)
	// 会话还有很久才过期，走"校验已有会话"分支。
	if err := svc.persistSession(ch.ID, &connector.AuthSession{
		UserID: "9", AccessToken: "old-access", RefreshToken: "old-refresh", ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("persist session: %v", err)
	}

	_, err := svc.EnsureSession(context.Background(), ch, resolved, conn)
	if err == nil || !strings.HasPrefix(err.Error(), "校验会话：") || !connector.IsTransient(err) {
		t.Fatalf("err = %v, want transient session check error", err)
	}
	if IsLoginError(err) {
		t.Fatal("a 502 while checking the session must not be reported as a login failure")
	}
	if refreshCalls.Load() != 0 || loginCalls.Load() != 0 {
		t.Fatalf("refresh = %d, login = %d; want neither", refreshCalls.Load(), loginCalls.Load())
	}
	if saved, _ := svc.AuthSessions.FindByChannel(ch.ID); saved == nil {
		t.Fatal("session must be kept on transient errors")
	}
	logs, _ := svc.MonitorLogs.List(ch.ID, 10)
	if len(logs) != 1 || logs[0].Job != storage.MonitorJobSession || logs[0].Success {
		t.Fatalf("monitor logs = %+v, want one failed session entry", logs)
	}
}

func TestEnsureTokenSessionTransientIsNotInvalidToken(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusServiceUnavailable)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unavailable", int(status.Load()))
	}))
	defer srv.Close()

	svc, cipher := testService(t)
	cred, _ := cipher.Encrypt(`{"access_token":"tok","user_id":"9"}`)
	ch := &storage.Channel{Name: "token", Type: storage.ChannelTypeNewAPI, SiteURL: srv.URL, PasswordCipher: cred, CredentialMode: storage.CredentialModeToken}
	if err := svc.Channels.Create(ch); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	resolved, _ := svc.Resolve(context.Background(), ch)
	conn, _ := connector.For(connector.TypeNewAPI)

	_, err := svc.EnsureSession(context.Background(), ch, resolved, conn)
	if err == nil || strings.Contains(err.Error(), "token 已失效") || IsLoginError(err) {
		t.Fatalf("503 err = %v, must not claim the token is invalid", err)
	}

	status.Store(http.StatusUnauthorized)
	_, err = svc.EnsureSession(context.Background(), ch, resolved, conn)
	if err == nil || !strings.Contains(err.Error(), "token 已失效") || !IsLoginError(err) {
		t.Fatalf("401 err = %v, want invalid token login error", err)
	}
}

func newPasswordChannel(t *testing.T, siteURL string) (*Service, *storage.Channel, *connector.Channel, connector.Connector) {
	t.Helper()
	svc, cipher := testService(t)
	enc, _ := cipher.Encrypt("password")
	ch := &storage.Channel{Name: "pw", Type: storage.ChannelTypeNewAPI, SiteURL: siteURL, Username: "u", PasswordCipher: enc, CredentialMode: storage.CredentialModePassword}
	if err := svc.Channels.Create(ch); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	resolved, err := svc.Resolve(context.Background(), ch)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	conn, _ := connector.For(connector.TypeNewAPI)
	return svc, ch, resolved, conn
}

func TestScheduledLoginPausesOnPermanentError(t *testing.T) {
	var loginCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		loginCalls.Add(1)
		_, _ = w.Write([]byte(`{"success":false,"message":"Username or password is incorrect, or user has been banned"}`))
	}))
	defer srv.Close()
	svc, ch, resolved, conn := newPasswordChannel(t, srv.URL)
	scheduled := WithScheduled(context.Background())

	_, err := svc.EnsureSession(scheduled, ch, resolved, conn)
	if !connector.IsPermanent(err) || !IsLoginError(err) || !strings.HasSuffix(err.Error(), autoLoginPausedNote) {
		t.Fatalf("first err = %v", err)
	}
	if got, _ := svc.Channels.FindByID(ch.ID); !strings.HasSuffix(got.LastError, autoLoginPausedNote) {
		t.Fatalf("last_error = %q, want pause note", got.LastError)
	}

	_, err = svc.EnsureSession(scheduled, ch, resolved, conn)
	var backoffErr *BackoffError
	if !errors.As(err, &backoffErr) || !backoffErr.Paused || loginCalls.Load() != 1 {
		t.Fatalf("second scheduled attempt: err = %v, login calls = %d", err, loginCalls.Load())
	}

	// 重启后暂停状态还在：从库里读回，定时任务仍然不登录。
	restarted := NewService(svc.Channels, svc.AuthSessions, svc.Captchas, svc.Rates, svc.MonitorLogs, svc.Cipher)
	restarted.PersistLoginBackoffs(svc.loginBackoffs.store)
	if _, err := restarted.EnsureSession(scheduled, ch, resolved, conn); !IsBackoff(err) || loginCalls.Load() != 1 {
		t.Fatalf("after restart: err = %v, login calls = %d", err, loginCalls.Load())
	}

	// 手动刷新不受限制。
	if _, err := svc.EnsureSession(context.Background(), ch, resolved, conn); err == nil || loginCalls.Load() != 2 {
		t.Fatalf("manual attempt: err = %v, login calls = %d", err, loginCalls.Load())
	}

	// 修改渠道配置后恢复自动登录。
	name := "pw2"
	if _, err := svc.Update(ch.ID, UpdateInput{Name: &name}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if _, err := svc.EnsureSession(scheduled, ch, resolved, conn); IsBackoff(err) || loginCalls.Load() != 3 {
		t.Fatalf("after update: err = %v, login calls = %d", err, loginCalls.Load())
	}

	// 解除后库里也清掉了；这次登录又失败，库里是新记的一次，失败次数从 1 开始。
	rows, err := svc.loginBackoffs.store.List()
	if err != nil || len(rows) != 1 || rows[0].ChannelID != ch.ID || rows[0].Failures != 1 || !rows[0].Paused {
		t.Fatalf("stored states = %+v, %v", rows, err)
	}
	if err := svc.Delete(ch.ID); err != nil {
		t.Fatalf("delete channel: %v", err)
	}
	if rows, _ := svc.loginBackoffs.store.List(); len(rows) != 0 {
		t.Fatalf("states left after deleting channel: %+v", rows)
	}
}

func TestScheduledLoginBacksOffOnTransientError(t *testing.T) {
	var loginCalls atomic.Int32
	var ok atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/api/user/login", func(w http.ResponseWriter, r *http.Request) {
		loginCalls.Add(1)
		if !ok.Load() {
			http.Error(w, `{"success":false,"message":"Conflict"}`, http.StatusConflict)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "new_api_refresh", Value: "r"})
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":{"access_token":"a","access_expires_at":1900000000,"user":{"id":9}}}`))
	})
	mux.HandleFunc("/api/user/self", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":{"id":9}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	svc, ch, resolved, conn := newPasswordChannel(t, srv.URL)
	scheduled := WithScheduled(context.Background())

	if _, err := svc.EnsureSession(scheduled, ch, resolved, conn); err == nil || connector.IsPermanent(err) || strings.Contains(err.Error(), autoLoginPausedNote) {
		t.Fatalf("first err = %v, want plain transient login error", err)
	}
	_, err := svc.EnsureSession(scheduled, ch, resolved, conn)
	var backoffErr *BackoffError
	if !errors.As(err, &backoffErr) || backoffErr.Paused || loginCalls.Load() != 1 {
		t.Fatalf("second attempt: err = %v, calls = %d", err, loginCalls.Load())
	}
	if d := time.Until(backoffErr.NextAt); d < 14*time.Minute || d > 15*time.Minute {
		t.Fatalf("next attempt in %s, want ~15m", d)
	}

	// 退避到期后（这里直接把时间拨过去）再次失败，间隔翻倍。
	svc.loginBackoffs.mu.Lock()
	svc.loginBackoffs.states[ch.ID].nextAt = time.Now()
	svc.loginBackoffs.mu.Unlock()
	_, _ = svc.EnsureSession(scheduled, ch, resolved, conn)
	st, _ := svc.loginBackoffs.get(ch.ID)
	if st.failures != 2 || time.Until(st.nextAt) < 29*time.Minute {
		t.Fatalf("state after second failure = %+v", st)
	}

	// 手动登录成功后清掉退避。
	ok.Store(true)
	if err := svc.TestLogin(context.Background(), ch.ID); err != nil {
		t.Fatalf("manual login: %v", err)
	}
	if _, found := svc.loginBackoffs.get(ch.ID); found {
		t.Fatal("successful login must clear the backoff state")
	}
}

func TestCaptchaPauseResumesWhenBalanceRecovers(t *testing.T) {
	svc, _ := testService(t)
	cfg := &storage.CaptchaConfig{Name: "yes", Type: storage.CaptchaYesCaptcha, Enabled: true}
	if err := svc.Captchas.Create(cfg); err != nil {
		t.Fatalf("create captcha: %v", err)
	}
	ch := &storage.Channel{ID: 42, CaptchaConfigID: &cfg.ID}
	failedAt := time.Now().Add(-time.Hour)
	captchaErr := &CaptchaError{Err: connector.Permanent(errors.New("solve captcha: yescaptcha createTask: ERROR_ZERO_BALANCE"))}
	if !svc.loginBackoffs.recordFailure(ch, captchaErr, failedAt) {
		t.Fatal("zero balance must pause")
	}
	if err := svc.checkLoginBackoff(ch); !IsBackoff(err) {
		t.Fatalf("err = %v, want paused", err)
	}

	zero := 0.0
	_ = svc.Captchas.UpdateBalance(cfg.ID, &zero, "", "", time.Now())
	if err := svc.checkLoginBackoff(ch); !IsBackoff(err) {
		t.Fatalf("still zero balance: err = %v, want paused", err)
	}
	topped := 5.0
	_ = svc.Captchas.UpdateBalance(cfg.ID, &topped, "", "", time.Now())
	if err := svc.checkLoginBackoff(ch); err != nil {
		t.Fatalf("after top-up: err = %v, want resumed", err)
	}

	svc.loginBackoffs.recordFailure(ch, captchaErr, time.Now())
	svc.ResumeAutoLoginForCaptcha(cfg.ID + 1)
	if err := svc.checkLoginBackoff(ch); !IsBackoff(err) {
		t.Fatal("editing another captcha config must not resume")
	}
	svc.ResumeAutoLoginForCaptcha(cfg.ID)
	if err := svc.checkLoginBackoff(ch); err != nil {
		t.Fatalf("editing the captcha config must resume, err = %v", err)
	}
}
