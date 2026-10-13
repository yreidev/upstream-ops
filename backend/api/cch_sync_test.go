package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yreidev/upstream-ops/backend/cch"
	"github.com/yreidev/upstream-ops/backend/storage"
)

type fakeCCHSync struct {
	saved  cch.SettingsInput
	runErr error
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

func (f *fakeCCHSync) RunNow(context.Context) (string, any, error) {
	if f.runErr != nil {
		return "", nil, f.runErr
	}
	r := &cch.Result{Applied: true, Updated: 1}
	return r.Summary(), r, nil
}

func TestCCHSyncRoutes(t *testing.T) {
	env := newJobTestEnv(t)
	fake := &fakeCCHSync{}
	env.deps.CCHSync = fake
	r := env.r
	registerCCHSync(r.Group("/api"), env.deps)

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
	// 立即同步在后台跑，结果记在任务里
	code, started := env.start(t, context.Background(), "/api/cch-sync/run")
	if code != http.StatusAccepted || started.Job.Kind != storage.JobCCHSync {
		t.Fatalf("run = %d %+v", code, started)
	}
	done := env.wait(t, started.Job.ID)
	if done.Status != storage.JobSucceeded || done.Message != "改了 1 个，已一致 0 个" || !strings.Contains(string(done.Result), `"updated":1`) {
		t.Fatalf("run job = %+v result=%s", done, done.Result)
	}
	fake.runErr = &cch.APIError{Status: 401}
	_, started = env.start(t, context.Background(), "/api/cch-sync/run")
	if done := env.wait(t, started.Job.ID); done.Status != storage.JobFailed || !strings.Contains(done.Message, "CCH 返回 401") {
		t.Fatalf("cch error job = %+v", done)
	}
}
