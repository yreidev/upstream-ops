package notify

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/yreidev/upstream-ops/backend/storage"
)

func TestTelegramHTML(t *testing.T) {
	body := "# 渠道分组变动\n\n> 扫描时间：2026-10-13 09:00\n\n## 倍率变化（1）\n\n### a<b>&c\n- **claude_code_max**：倍率：`1x` 上涨 `1.5x`\n普通 *文本* _x_"
	want := "<b>渠道分组变动</b>\n\n<blockquote>扫描时间：2026-10-13 09:00</blockquote>\n\n<b>倍率变化（1）</b>\n\n<b>a&lt;b&gt;&amp;c</b>\n• <b>claude_code_max</b>：倍率：<code>1x</code> 上涨 <code>1.5x</code>\n普通 *文本* _x_"
	if got := telegramHTML(body); got != want {
		t.Fatalf("telegramHTML\n got %q\nwant %q", got, want)
	}
}

func newTestTelegram(t *testing.T, handler http.HandlerFunc) *telegram {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	tg, err := newTelegram(`{"bot_token":"123:SECRET","chat_id":"42"}`)
	if err != nil {
		t.Fatal(err)
	}
	tg.base = srv.URL
	return tg
}

func TestTelegramSendUsesHTMLAndTruncates(t *testing.T) {
	var payload map[string]any
	tg := newTestTelegram(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bot123:SECRET/sendMessage" {
			t.Errorf("path = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		_, _ = w.Write([]byte(`{"ok":true,"result":{}}`))
	})
	long := strings.Repeat("长", 5000)
	if err := tg.Send(context.Background(), Message{Subject: "a<b", Body: long}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if payload["parse_mode"] != "HTML" || payload["chat_id"] != "42" {
		t.Fatalf("payload = %v", payload)
	}
	text := payload["text"].(string)
	if !strings.HasPrefix(text, "<b>a&lt;b</b>\n") || !strings.HasSuffix(text, "已截断）") {
		t.Fatalf("text head/tail wrong: %q…%q", text[:20], text[len(text)-30:])
	}
	if n := utf8.RuneCountInString(text); n > 4096 {
		t.Fatalf("text has %d runes, over the 4096 limit", n)
	}
}

func TestTelegramErrors(t *testing.T) {
	t.Run("retry_after", func(t *testing.T) {
		tg := newTestTelegram(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}`))
		})
		err := tg.Send(context.Background(), Message{Subject: "s", Body: "b"})
		var sendErr *SendError
		if !errors.As(err, &sendErr) || sendErr.RetryAfter != 7*time.Second || sendErr.Permanent {
			t.Fatalf("err = %#v", err)
		}
		if err.Error() != "telegram 429: Too Many Requests: retry after 7" {
			t.Fatalf("message = %q", err.Error())
		}
	})
	t.Run("permanent", func(t *testing.T) {
		tg := newTestTelegram(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}`))
		})
		err := tg.Send(context.Background(), Message{Subject: "s", Body: "b"})
		var sendErr *SendError
		if !errors.As(err, &sendErr) || !sendErr.Permanent || !strings.Contains(err.Error(), "chat not found") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("falls back to plain text", func(t *testing.T) {
		var calls int32
		var lastPayload map[string]any
		tg := newTestTelegram(t, func(w http.ResponseWriter, r *http.Request) {
			lastPayload = nil
			_ = json.NewDecoder(r.Body).Decode(&lastPayload)
			if atomic.AddInt32(&calls, 1) == 1 {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"ok":false,"error_code":400,"description":"Bad Request: can't parse entities: unexpected end tag"}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		})
		if err := tg.Send(context.Background(), Message{Subject: "s", Body: "`a **b` c**"}); err != nil {
			t.Fatalf("send: %v", err)
		}
		if calls != 2 || lastPayload["parse_mode"] != nil || lastPayload["text"] != "s\n`a **b` c**" {
			t.Fatalf("calls = %d, payload = %v", calls, lastPayload)
		}
	})
	t.Run("transport error hides token", func(t *testing.T) {
		tg, _ := newTelegram(`{"bot_token":"123:SECRET","chat_id":"42"}`)
		tg.base = "http://127.0.0.1:1"
		err := tg.Send(context.Background(), Message{Subject: "s", Body: "b"})
		if err == nil || strings.Contains(err.Error(), "SECRET") || !strings.HasPrefix(err.Error(), "telegram request: ") {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestWecomSend(t *testing.T) {
	var gotContent string
	responses := []string{
		`{"errcode":0,"errmsg":"ok"}`,
		`{"errcode":93000,"errmsg":"invalid webhook url"}`,
		`{"errcode":45009,"errmsg":"api freq out of limit"}`,
	}
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Markdown struct {
				Content string `json:"content"`
			} `json:"markdown"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		gotContent = payload.Markdown.Content
		_, _ = w.Write([]byte(responses[atomic.AddInt32(&calls, 1)-1]))
	}))
	defer srv.Close()

	w, err := newWecom(`{"webhook_url":"` + srv.URL + `/cgi-bin/webhook/send?key=SECRET"}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Send(context.Background(), Message{Subject: "标题", Body: strings.Repeat("长", 3000)}); err != nil {
		t.Fatalf("send ok: %v", err)
	}
	if len(gotContent) > wecomMaxContentBytes || !utf8.ValidString(gotContent) || !strings.HasSuffix(gotContent, "已截断）") {
		t.Fatalf("content: %d bytes, valid=%v", len(gotContent), utf8.ValidString(gotContent))
	}

	err = w.Send(context.Background(), Message{Subject: "s", Body: "b"})
	var sendErr *SendError
	if !errors.As(err, &sendErr) || !sendErr.Permanent || err.Error() != "wecom errcode 93000: invalid webhook url" {
		t.Fatalf("93000 err = %v", err)
	}
	err = w.Send(context.Background(), Message{Subject: "s", Body: "b"})
	if !errors.As(err, &sendErr) || sendErr.Permanent || sendErr.RetryAfter != wecomRateLimitWait {
		t.Fatalf("45009 err = %v", err)
	}

	w.cfg.WebhookURL = "http://127.0.0.1:1/cgi-bin/webhook/send?key=SECRET"
	if err := w.Send(context.Background(), Message{Subject: "s", Body: "b"}); err == nil || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("transport err = %v", err)
	}
}

type scriptedNotifier struct {
	errs  []error
	calls int
}

func (s *scriptedNotifier) Send(context.Context, Message) error {
	err := s.errs[s.calls]
	s.calls++
	return err
}

func (s *scriptedNotifier) Type() storage.NotificationChannelType { return recorderType }

func TestSendWithRetryHonorsSendError(t *testing.T) {
	d := &Dispatcher{policy: Policy{SendMaxAttempts: 3}}

	permanent := &scriptedNotifier{errs: []error{&SendError{Err: errors.New("bad token"), Permanent: true}, nil}}
	if err := d.sendWithRetry(context.Background(), "x", permanent, Message{}); err == nil || permanent.calls != 1 {
		t.Fatalf("permanent: err=%v calls=%d", err, permanent.calls)
	}

	tooLong := &scriptedNotifier{errs: []error{&SendError{Err: errors.New("slow down"), RetryAfter: 2 * maxRetryAfter}, nil}}
	if err := d.sendWithRetry(context.Background(), "x", tooLong, Message{}); err == nil || tooLong.calls != 1 {
		t.Fatalf("retry_after over cap: err=%v calls=%d", err, tooLong.calls)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	waits := &scriptedNotifier{errs: []error{&SendError{Err: errors.New("slow down"), RetryAfter: 30 * time.Second}, nil}}
	start := time.Now()
	if err := d.sendWithRetry(ctx, "x", waits, Message{}); !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("retry_after must wait (and respect ctx): err=%v", err)
	}
}
