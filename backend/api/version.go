package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/global"
)

const (
	githubRepoURL            = "https://github.com/yreidev/upstream-ops"
	defaultGitHubReleaseList = "https://api.github.com/repos/yreidev/upstream-ops/releases?per_page=30"
)

var (
	githubReleasesURL   = defaultGitHubReleaseList
	githubReleaseClient = &http.Client{Timeout: 2 * time.Second}
)

type versionResponse struct {
	Name            string `json:"name"`
	Title           string `json:"title"`
	Version         string `json:"version"`
	LatestVersion   string `json:"latest_version"`
	UpdateAvailable bool   `json:"update_available"`
	RepoURL         string `json:"repo_url"`
	ReleaseURL      string `json:"release_url"`
	UpdateError     string `json:"update_error"`
	// ReleaseNotes 是比当前版本新的各个正式发布的说明，新版本在前；没有更新时为空。
	ReleaseNotes []releaseNote `json:"release_notes,omitempty"`
}

type releaseNote struct {
	Version     string `json:"version"`
	URL         string `json:"url"`
	PublishedAt string `json:"published_at"`
	Notes       string `json:"notes"`
}

type githubReleaseResponse struct {
	TagName     string `json:"tag_name"`
	HTMLURL     string `json:"html_url"`
	Body        string `json:"body"`
	PublishedAt string `json:"published_at"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
}

func registerVersion(api *gin.RouterGroup, d *Deps) {
	api.GET("/version", func(c *gin.Context) {
		c.JSON(http.StatusOK, buildVersionResponse(c.Request.Context(), d))
	})
}

func buildVersionResponse(ctx context.Context, d *Deps) versionResponse {
	// 用正在生效的标题：直接读配置文件会漏掉环境变量 APP_TITLE
	app := config.AppConfig{Title: "UpstreamOps"}
	if d != nil && d.Runtime != nil {
		app = d.Runtime.CurrentApp()
	}

	resp := versionResponse{
		Name:    "upstream-ops",
		Title:   app.Title,
		Version: global.VERSION,
		RepoURL: githubRepoURL,
	}

	releases, err := fetchGitHubReleases(ctx, githubReleaseClient)
	if err != nil {
		resp.UpdateError = err.Error()
		return resp
	}
	latest, ok := latestGitHubRelease(releases)
	if !ok {
		resp.UpdateError = "github has no published release"
		return resp
	}
	resp.LatestVersion = latest.TagName
	resp.ReleaseURL = latest.HTMLURL
	resp.UpdateAvailable = isVersionNewer(latest.TagName, global.VERSION)
	if resp.UpdateAvailable {
		resp.ReleaseNotes = newerReleaseNotes(releases, global.VERSION)
	}
	return resp
}

// fetchGitHubReleases 读取最近的发布列表（不含草稿，未登录时 GitHub 不返回草稿）。
// 只请求一次，最新版本和更新说明都从这份列表里取。
func fetchGitHubReleases(ctx context.Context, client *http.Client) ([]githubReleaseResponse, error) {
	if client == nil {
		client = githubReleaseClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubReleasesURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "upstream-ops")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("github releases status %d", resp.StatusCode)
	}

	var releases []githubReleaseResponse
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, err
	}
	return releases, nil
}

// publishedReleases 只留正式发布：去掉草稿、预发布和版本号解析不了的。
func publishedReleases(releases []githubReleaseResponse) []githubReleaseResponse {
	out := make([]githubReleaseResponse, 0, len(releases))
	for _, r := range releases {
		if r.Draft || r.Prerelease {
			continue
		}
		if _, ok := parseVersion(r.TagName); !ok {
			continue
		}
		if strings.TrimSpace(r.HTMLURL) == "" {
			r.HTMLURL = githubRepoURL
		}
		out = append(out, r)
	}
	return out
}

// latestGitHubRelease 按版本号取最大的正式发布，不依赖 GitHub 列表的排序。
func latestGitHubRelease(releases []githubReleaseResponse) (githubReleaseResponse, bool) {
	var latest githubReleaseResponse
	found := false
	for _, r := range publishedReleases(releases) {
		if !found || isVersionNewer(r.TagName, latest.TagName) {
			latest = r
			found = true
		}
	}
	return latest, found
}

func newerReleaseNotes(releases []githubReleaseResponse, current string) []releaseNote {
	newer := make([]githubReleaseResponse, 0)
	for _, r := range publishedReleases(releases) {
		if isVersionNewer(r.TagName, current) {
			newer = append(newer, r)
		}
	}
	sort.SliceStable(newer, func(i, j int) bool {
		return isVersionNewer(newer[i].TagName, newer[j].TagName)
	})
	notes := make([]releaseNote, 0, len(newer))
	for _, r := range newer {
		notes = append(notes, releaseNote{
			Version:     r.TagName,
			URL:         r.HTMLURL,
			PublishedAt: r.PublishedAt,
			Notes:       strings.TrimSpace(r.Body),
		})
	}
	return notes
}

func isVersionNewer(latest, current string) bool {
	lv, ok := parseVersion(latest)
	if !ok {
		return false
	}
	cv, ok := parseVersion(current)
	if !ok {
		return false
	}
	for i := range lv {
		if lv[i] > cv[i] {
			return true
		}
		if lv[i] < cv[i] {
			return false
		}
	}
	return false
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimSpace(strings.TrimPrefix(v, "v"))
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
