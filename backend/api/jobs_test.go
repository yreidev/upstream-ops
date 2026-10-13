package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/jobs"
	"github.com/yreidev/upstream-ops/backend/monitor"
	"github.com/yreidev/upstream-ops/backend/progress"
	"github.com/yreidev/upstream-ops/backend/storage"
	"gorm.io/gorm"
)

// stubMonitor 的 RefreshBalance 在 gate 非空时会等它关闭，用来模拟还在跑的任务。
type stubMonitor struct {
	gate    chan struct{}
	syncAll *monitor.ScanSummary
	syncErr error
}

func (s *stubMonitor) RefreshBalance(ctx context.Context, c *storage.Channel) error {
	if s.gate != nil {
		select {
		case <-s.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	progress.OK(ctx, progress.StageBalance, "ok")
	return nil
}

func (s *stubMonitor) RefreshRates(ctx context.Context, c *storage.Channel) error {
	return nil
}

func (s *stubMonitor) SyncAllBalances(ctx context.Context) (*monitor.ScanSummary, error) {
	return s.syncAll, s.syncErr
}

type jobTestEnv struct {
	r        *gin.Engine
	db       *gorm.DB
	deps     *Deps
	repo     *storage.BackgroundJobs
	channels *storage.Channels
}

func newJobTestEnv(t *testing.T) *jobTestEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db := openTestDB(t)
	repo := storage.NewBackgroundJobs(db)
	runner := jobs.NewRunner(repo, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { runner.Shutdown(5 * time.Second) })
	env := &jobTestEnv{r: gin.New(), db: db, repo: repo, channels: storage.NewChannels(db)}
	env.deps = &Deps{Channels: env.channels, Jobs: runner, JobRepo: repo, Monitor: &stubMonitor{}}
	api := env.r.Group("/api")
	registerChannels(api, env.deps)
	registerJobs(api, env.deps)
	return env
}

func (e *jobTestEnv) get(t *testing.T, path string) (int, json.RawMessage) {
	t.Helper()
	rec := httptest.NewRecorder()
	e.r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var body struct {
		Data json.RawMessage `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body.Data
}

type startedJob struct {
	Job     jobView `json:"job"`
	Started bool    `json:"started"`
}

func (e *jobTestEnv) start(t *testing.T, ctx context.Context, path string) (int, startedJob) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	e.r.ServeHTTP(rec, req)
	var body struct {
		Data startedJob `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v (%s)", path, err, rec.Body.String())
	}
	return rec.Code, body.Data
}

// wait 等任务跑完，返回 GET /api/jobs/:id 的结果。
func (e *jobTestEnv) wait(t *testing.T, id uint) jobView {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		req := httptest.NewRequest(http.MethodGet, "/api/jobs/"+strconv.Itoa(int(id)), nil)
		rec := httptest.NewRecorder()
		e.r.ServeHTTP(rec, req)
		var body struct {
			Data jobView `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode job: %v (%s)", err, rec.Body.String())
		}
		if body.Data.Status != storage.JobRunning {
			return body.Data
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %d still running", id)
	return jobView{}
}

func TestSyncChannelRunsAsBackgroundJob(t *testing.T) {
	env := newJobTestEnv(t)
	if err := env.channels.Create(&storage.Channel{
		Name: "a", Type: storage.ChannelTypeNewAPI, SiteURL: "https://a.example.com",
		Username: "u1", PasswordCipher: "x", MonitorEnabled: true,
	}); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	stub := &stubMonitor{gate: make(chan struct{})}
	env.deps.Monitor = stub

	// 浏览器那次请求一结束（关页面、刷新）就取消它的 context，任务不能跟着停
	reqCtx, cancel := context.WithCancel(context.Background())
	code, first := env.start(t, reqCtx, "/api/channels/1/sync")
	cancel()
	if code != http.StatusAccepted || !first.Started || first.Job.Status != storage.JobRunning || first.Job.Title != "同步 a" {
		t.Fatalf("start = %d %+v", code, first)
	}

	// 同一渠道还在跑时，同步和登录测试都返回正在跑的那个任务
	for _, path := range []string{"/api/channels/1/sync", "/api/channels/1/test-login"} {
		code, again := env.start(t, context.Background(), path)
		if code != http.StatusOK || again.Started || again.Job.ID != first.Job.ID {
			t.Fatalf("%s while running = %d %+v", path, code, again)
		}
	}
	// 页面刷新后靠它接上进度
	code, data := env.get(t, "/api/jobs/running")
	var running []jobView
	if err := json.Unmarshal(data, &running); code != http.StatusOK || err != nil || len(running) != 1 || running[0].ID != first.Job.ID {
		t.Fatalf("running = %d %s", code, data)
	}

	close(stub.gate)
	done := env.wait(t, first.Job.ID)
	if done.Status != storage.JobSucceeded || done.Message != "同步完成" || done.FinishedAt == nil {
		t.Fatalf("job = %+v", done)
	}
	var events []progress.Event
	if err := json.Unmarshal(done.Events, &events); err != nil || len(events) == 0 {
		t.Fatalf("events = %s, %v", done.Events, err)
	}
	if ev := events[0]; ev.Stage != progress.StageBalance || ev.ChannelID != 1 || ev.ChannelName != "a" || ev.Index != 1 || ev.Total != 1 {
		t.Fatalf("event = %+v", ev)
	}
}

func TestSyncAllChannelsJobRecordsSummary(t *testing.T) {
	env := newJobTestEnv(t)
	env.deps.Monitor = &stubMonitor{syncAll: &monitor.ScanSummary{Total: 2, Success: 2}}
	code, started := env.start(t, context.Background(), "/api/channels/sync-all")
	if code != http.StatusAccepted || started.Job.Kind != storage.JobChannelSyncAll || started.Job.Source != storage.JobManual {
		t.Fatalf("start = %d %+v", code, started)
	}
	done := env.wait(t, started.Job.ID)
	if done.Status != storage.JobSucceeded || done.Message != "2 个渠道：成功 2" || string(done.Result) == "" {
		t.Fatalf("job = %+v result=%s", done, done.Result)
	}

	env.deps.Monitor = &stubMonitor{syncErr: errors.New("读取渠道列表：disk I/O error")}
	_, started = env.start(t, context.Background(), "/api/channels/sync-all")
	if done := env.wait(t, started.Job.ID); done.Status != storage.JobFailed || done.Message != "读取渠道列表：disk I/O error" {
		t.Fatalf("failed job = %+v", done)
	}
}

func TestListJobsFilters(t *testing.T) {
	env := newJobTestEnv(t)
	now := time.Now()
	for _, j := range []storage.BackgroundJob{
		{Kind: storage.JobBalanceScan, Source: storage.JobScheduled, Title: "余额采集", Status: storage.JobSucceeded, StartedAt: now.Add(-2 * time.Minute)},
		{Kind: storage.JobChannelSync, Source: storage.JobManual, ChannelID: 3, Title: "同步 c", Status: storage.JobFailed, StartedAt: now.Add(-time.Minute)},
	} {
		if err := env.repo.Create(&j); err != nil {
			t.Fatalf("create job: %v", err)
		}
	}

	list := func(path string) (int, []jobView) {
		code, data := env.get(t, path)
		var page struct {
			Items []jobView `json:"items"`
		}
		_ = json.Unmarshal(data, &page)
		return code, page.Items
	}
	code, items := list("/api/jobs?source=manual")
	if code != http.StatusOK || len(items) != 1 || items[0].Title != "同步 c" || items[0].Events != nil {
		t.Fatalf("manual jobs = %d %+v", code, items)
	}
	code, items = list("/api/jobs")
	if code != http.StatusOK || len(items) != 2 || items[0].Title != "同步 c" {
		t.Fatalf("all jobs should be newest first: %+v", items)
	}
	if code, _ := env.get(t, "/api/jobs?kind=nope"); code != http.StatusBadRequest {
		t.Fatalf("unknown kind = %d", code)
	}
	if code, _ := env.get(t, "/api/jobs/999"); code != http.StatusNotFound {
		t.Fatalf("missing job = %d", code)
	}
}
