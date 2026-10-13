package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/crypto"
	"github.com/yreidev/upstream-ops/backend/storage"
)

func TestNotifyChannelRejectsRemovedTypes(t *testing.T) {
	gin.SetMode(gin.TestMode)

	db := openTestDB(t)
	notifies := storage.NewNotifications(db)
	cipher, err := crypto.NewCipher("test-secret")
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	r := gin.New()
	registerNotifications(r.Group("/api"), &Deps{Notifies: notifies, Cipher: cipher})

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/notifications/channels", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	if rec := post(`{"name":"mail","type":"email","config":"{}","enabled":true}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("email status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	if rec := post(`{"name":"wecom","type":"wecom","config":"{\"webhook_url\":\"https://example.com\"}","enabled":true}`); rec.Code != http.StatusOK {
		t.Fatalf("wecom status = %d, body = %s", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodPut, "/api/notifications/channels/1", strings.NewReader(`{"name":"wecom","type":"feishu","enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("update to feishu status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	ch, err := notifies.FindChannel(1)
	if err != nil {
		t.Fatalf("find channel: %v", err)
	}
	if ch.Type != storage.NotifyWecom {
		t.Fatalf("type = %q, want wecom", ch.Type)
	}
}

func TestCaptchaConfigRejectsRemovedProviders(t *testing.T) {
	gin.SetMode(gin.TestMode)

	db := openTestDB(t)
	captchas := storage.NewCaptchas(db)
	cipher, err := crypto.NewCipher("test-secret")
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	r := gin.New()
	registerCaptchas(r.Group("/api"), &Deps{Captchas: captchas, Cipher: cipher})

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/captcha-configs", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	if rec := post(`{"name":"cs","type":"capsolver","api_key":"k","enabled":true}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("capsolver status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	if rec := post(`{"name":"yes","type":"yescaptcha","api_key":"k","enabled":true}`); rec.Code != http.StatusOK {
		t.Fatalf("yescaptcha status = %d, body = %s", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodPut, "/api/captcha-configs/1", strings.NewReader(`{"name":"yes","type":"2captcha","enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("update to 2captcha status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
	cfg, err := captchas.FindByID(1)
	if err != nil {
		t.Fatalf("find captcha: %v", err)
	}
	if cfg.Type != storage.CaptchaYesCaptcha {
		t.Fatalf("type = %q, want yescaptcha", cfg.Type)
	}
}
