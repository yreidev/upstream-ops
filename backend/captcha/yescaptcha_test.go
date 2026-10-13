package captcha

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestYesCaptcha(t *testing.T, mux *http.ServeMux) *yesCaptcha {
	t.Helper()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	p := newYesCaptcha(Config{APIKey: "key", Endpoint: srv.URL})
	p.pollInterval = 10 * time.Millisecond
	return p
}

func TestYesCaptchaZeroBalanceIsPermanent(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/createTask", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorId":1,"errorCode":"ERROR_ZERO_BALANCE","errorDescription":"帐户余额不足"}`))
	})
	_, err := newTestYesCaptcha(t, mux).SolveTurnstile(context.Background(), "site", "https://x.example")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || !apiErr.Permanent() {
		t.Fatalf("err = %#v, want permanent APIError", err)
	}
	if err.Error() != "yescaptcha createTask: ERROR_ZERO_BALANCE 帐户余额不足" {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestYesCaptchaKeepsPollingThroughGatewayErrors(t *testing.T) {
	var polls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/createTask", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorId":0,"taskId":"t1"}`))
	})
	mux.HandleFunc("/getTaskResult", func(w http.ResponseWriter, r *http.Request) {
		switch atomic.AddInt32(&polls, 1) {
		case 1:
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`<html><title>502 Bad Gateway</title></html>`))
		case 2:
			_, _ = w.Write([]byte(`{"errorId":0,"status":"processing"}`))
		default:
			_, _ = w.Write([]byte(`{"errorId":0,"status":"ready","solution":{"token":"tok"}}`))
		}
	})
	token, err := newTestYesCaptcha(t, mux).SolveTurnstile(context.Background(), "site", "https://x.example")
	if err != nil || token != "tok" {
		t.Fatalf("token = %q, err = %v", token, err)
	}
}

func TestYesCaptchaStopsOnTaskError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/createTask", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorId":0,"taskId":123}`))
	})
	mux.HandleFunc("/getTaskResult", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errorId":1,"errorCode":"ERROR_CAPTCHA_UNSOLVABLE","errorDescription":"unsolvable"}`))
	})
	_, err := newTestYesCaptcha(t, mux).SolveTurnstile(context.Background(), "site", "https://x.example")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Permanent() || apiErr.Op != "getTaskResult" {
		t.Fatalf("err = %#v", err)
	}
}
