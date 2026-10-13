package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/cch"
)

type fakeCCHSync struct {
	saved   cch.SettingsInput
	runErr  error
	runCall int
}

func (f *fakeCCHSync) Settings() (*cch.SettingsView, error) {
	return &cch.SettingsView{BaseURL: f.saved.BaseURL, TokenSet: f.saved.Token != ""}, nil
}

func (f *fakeCCHSync) SaveSettings(in cch.SettingsInput) (*cch.SettingsView, error) {
	f.saved = in
	return f.Settings()
}

func (f *fakeCCHSync) Preview(context.Context) (*cch.Result, error) {
	return nil, cch.ErrNotConfigured
}

func (f *fakeCCHSync) RunNow(context.Context) (*cch.Result, error) {
	f.runCall++
	if f.runErr != nil {
		return nil, f.runErr
	}
	return &cch.Result{Applied: true, Updated: 1}, nil
}

func TestCCHSyncRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	fake := &fakeCCHSync{}
	r := gin.New()
	registerCCHSync(r.Group("/api"), &Deps{CCHSync: fake})

	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}

	rec := do(http.MethodPut, "/api/cch-sync", `{"enabled":true,"base_url":"https://cch.example","token":"t"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"token_set":true`) || strings.Contains(rec.Body.String(), `"t"`) {
		t.Fatalf("put = %d %s", rec.Code, rec.Body.String())
	}
	if !fake.saved.Enabled || fake.saved.Token != "t" {
		t.Fatalf("saved = %+v", fake.saved)
	}
	if rec := do(http.MethodPost, "/api/cch-sync/preview", ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("preview without config = %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodPost, "/api/cch-sync/run", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"updated":1`) {
		t.Fatalf("run = %d %s", rec.Code, rec.Body.String())
	}
	fake.runErr = cch.ErrBusy
	if rec := do(http.MethodPost, "/api/cch-sync/run", ""); rec.Code != http.StatusConflict {
		t.Fatalf("busy run = %d %s", rec.Code, rec.Body.String())
	}
	fake.runErr = &cch.APIError{Status: 401}
	if rec := do(http.MethodPost, "/api/cch-sync/run", ""); rec.Code != http.StatusBadGateway {
		t.Fatalf("cch error run = %d %s", rec.Code, rec.Body.String())
	}
}
