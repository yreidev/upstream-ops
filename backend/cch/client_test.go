package cch

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientListAndPatch(t *testing.T) {
	var patched string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer admin-token" {
			w.Header().Set("Content-Type", "application/problem+json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"status":401,"errorCode":"auth.invalid","detail":"Authentication is invalid or expired."}`))
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/providers":
			_, _ = w.Write([]byte(`{"items":[{"id":18,"name":"demo-独享","url":"https://demo.example","maskedKey":"sk-x••••••T0k2","isEnabled":true,"costMultiplier":0.28,"priority":3}]}`))
		case r.Method == http.MethodPatch && r.URL.Path == "/api/v1/providers/18":
			if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Errorf("content-type = %q", ct)
			}
			body, _ := io.ReadAll(r.Body)
			patched = string(body)
			_, _ = w.Write([]byte(`{"id":18}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "admin-token", 5*time.Second, "upstream-ops-test")
	providers, err := c.ListProviders(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(providers) != 1 || providers[0].ID != 18 || providers[0].MaskedKey != "sk-x••••••T0k2" ||
		providers[0].CostMultiplier != 0.28 || !providers[0].IsEnabled {
		t.Fatalf("providers = %+v", providers)
	}
	if err := c.SetCostMultiplier(context.Background(), 18, 0.33); err != nil {
		t.Fatalf("patch: %v", err)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(patched), &body); err != nil || len(body) != 1 || body["cost_multiplier"] != 0.33 {
		t.Fatalf("patch body = %s", patched)
	}

	_, err = NewClient(srv.URL, "wrong", 5*time.Second, "").ListProviders(context.Background())
	if !IsUnauthorized(err) || !strings.Contains(err.Error(), "CCH 返回 401 auth.invalid：Authentication is invalid or expired.") {
		t.Fatalf("unauthorized error = %v", err)
	}
}

func TestNormalizeBaseURL(t *testing.T) {
	for raw, want := range map[string]string{
		" https://cch.example.com/ ":         "https://cch.example.com",
		"https://cch.example.com/api/v1/":    "https://cch.example.com",
		"http://claude-code-hub:3000/api/v1": "http://claude-code-hub:3000",
		"https://example.com/cch":            "https://example.com/cch",
	} {
		got, err := NormalizeBaseURL(raw)
		if err != nil || got != want {
			t.Errorf("NormalizeBaseURL(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"", "cch.example.com", "ftp://cch.example.com"} {
		if _, err := NormalizeBaseURL(raw); err == nil {
			t.Errorf("NormalizeBaseURL(%q) must fail", raw)
		}
	}
}
