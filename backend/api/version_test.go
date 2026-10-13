package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/global"
)

func TestIsVersionNewer(t *testing.T) {
	tests := []struct {
		latest  string
		current string
		want    bool
	}{
		{latest: "0.2.1", current: "0.2.0", want: true},
		{latest: "v0.2.1", current: "0.2.0", want: true},
		{latest: "0.2.0", current: "v0.2.0", want: false},
		{latest: "0.1.9", current: "0.2.0", want: false},
	}
	for _, tt := range tests {
		if got := isVersionNewer(tt.latest, tt.current); got != tt.want {
			t.Fatalf("isVersionNewer(%q, %q) = %v, want %v", tt.latest, tt.current, got, tt.want)
		}
	}
}

func TestVersionEndpointReportsUpdate(t *testing.T) {
	gin.SetMode(gin.TestMode)

	withGitHubReleaseServer(t, http.StatusOK, `[{"tag_name":"v999.0.0","html_url":"https://github.com/yreidev/upstream-ops/releases/tag/v999.0.0","body":"### 修复\n\n- 修了一个问题"}]`)
	resp := requestVersion(t)

	if !resp.UpdateAvailable {
		t.Fatalf("update_available = false, want true")
	}
	if resp.LatestVersion != "v999.0.0" {
		t.Fatalf("latest_version = %q, want v999.0.0", resp.LatestVersion)
	}
	if resp.ReleaseURL == "" {
		t.Fatalf("release_url is empty")
	}
	if len(resp.ReleaseNotes) != 1 || resp.ReleaseNotes[0].Notes != "### 修复\n\n- 修了一个问题" {
		t.Fatalf("release_notes = %+v, want the v999.0.0 body", resp.ReleaseNotes)
	}
}

func TestVersionEndpointCollectsNewerReleaseNotes(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// 列表顺序故意打乱；预发布、草稿、比当前旧的版本都不该出现。
	withGitHubReleaseServer(t, http.StatusOK, `[
		{"tag_name":"v998.0.0","html_url":"https://example.test/v998","body":"  998 notes\n","published_at":"2026-10-01T00:00:00Z"},
		{"tag_name":"v999.1.0","html_url":"https://example.test/v999.1","body":"pre","prerelease":true},
		{"tag_name":"v999.0.0","html_url":"https://example.test/v999","body":"999 notes","published_at":"2026-10-02T00:00:00Z"},
		{"tag_name":"v1000.0.0","html_url":"https://example.test/v1000","body":"draft","draft":true},
		{"tag_name":"nightly","html_url":"https://example.test/nightly","body":"nightly"},
		{"tag_name":"v0.0.1","html_url":"https://example.test/v0.0.1","body":"old"}
	]`)
	resp := requestVersion(t)

	if !resp.UpdateAvailable || resp.LatestVersion != "v999.0.0" || resp.ReleaseURL != "https://example.test/v999" {
		t.Fatalf("latest = %q (%s), update_available = %v, want v999.0.0", resp.LatestVersion, resp.ReleaseURL, resp.UpdateAvailable)
	}
	want := []releaseNote{
		{Version: "v999.0.0", URL: "https://example.test/v999", PublishedAt: "2026-10-02T00:00:00Z", Notes: "999 notes"},
		{Version: "v998.0.0", URL: "https://example.test/v998", PublishedAt: "2026-10-01T00:00:00Z", Notes: "998 notes"},
	}
	if !reflect.DeepEqual(resp.ReleaseNotes, want) {
		t.Fatalf("release_notes = %+v, want %+v", resp.ReleaseNotes, want)
	}
}

func TestVersionEndpointReportsNoUpdate(t *testing.T) {
	gin.SetMode(gin.TestMode)

	withGitHubReleaseServer(t, http.StatusOK, `[{"tag_name":"`+global.VERSION+`","html_url":"https://github.com/yreidev/upstream-ops/releases/tag/v`+global.VERSION+`","body":"notes"}]`)
	resp := requestVersion(t)

	if resp.UpdateAvailable {
		t.Fatalf("update_available = true, want false")
	}
	if resp.LatestVersion != global.VERSION {
		t.Fatalf("latest_version = %q, want %s", resp.LatestVersion, global.VERSION)
	}
	if len(resp.ReleaseNotes) != 0 {
		t.Fatalf("release_notes = %+v, want empty", resp.ReleaseNotes)
	}
}

func TestVersionEndpointReportsNoPublishedRelease(t *testing.T) {
	gin.SetMode(gin.TestMode)

	withGitHubReleaseServer(t, http.StatusOK, `[{"tag_name":"v999.0.0","prerelease":true}]`)
	resp := requestVersion(t)

	if resp.UpdateAvailable || resp.LatestVersion != "" || strings.TrimSpace(resp.UpdateError) == "" {
		t.Fatalf("resp = %+v, want update_error without latest_version", resp)
	}
}

func TestVersionEndpointKeepsResponseOnGitHubError(t *testing.T) {
	gin.SetMode(gin.TestMode)

	withGitHubReleaseServer(t, http.StatusInternalServerError, `{"message":"error"}`)
	resp := requestVersion(t)

	if resp.UpdateAvailable {
		t.Fatalf("update_available = true, want false")
	}
	if strings.TrimSpace(resp.UpdateError) == "" {
		t.Fatalf("update_error is empty")
	}
	if resp.Version != global.VERSION {
		t.Fatalf("version = %q, want %s", resp.Version, global.VERSION)
	}
}

func withGitHubReleaseServer(t *testing.T, status int, body string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	oldURL := githubReleasesURL
	oldClient := githubReleaseClient
	githubReleasesURL = srv.URL
	githubReleaseClient = srv.Client()
	t.Cleanup(func() {
		githubReleasesURL = oldURL
		githubReleaseClient = oldClient
	})
}

func requestVersion(t *testing.T) versionResponse {
	t.Helper()
	r := gin.New()
	registerVersion(r.Group("/api"), &Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp versionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}
