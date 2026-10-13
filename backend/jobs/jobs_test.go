package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yreidev/upstream-ops/backend/progress"
	"github.com/yreidev/upstream-ops/backend/storage"
)

func newTestRepo(t *testing.T) *storage.BackgroundJobs {
	t.Helper()
	db, err := storage.Open(storage.DBConfig{Path: filepath.Join(t.TempDir(), "jobs-test.db")})
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := storage.AutoMigrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	return storage.NewBackgroundJobs(db)
}

func newTestRunner(t *testing.T, repo *storage.BackgroundJobs) *Runner {
	t.Helper()
	r := NewRunner(repo, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { r.Shutdown(5 * time.Second) })
	return r
}

func waitDone(t *testing.T, repo *storage.BackgroundJobs, id uint) *storage.BackgroundJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		job, err := repo.Get(id)
		if err != nil {
			t.Fatalf("get job: %v", err)
		}
		if job.Status != storage.JobRunning {
			return job
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("job %d still running", id)
	return nil
}

func spec(key string) Spec {
	return Spec{Kind: storage.JobChannelSync, Source: storage.JobManual, Title: "同步 a", Key: key}
}

func TestStartRecordsProgressAndResult(t *testing.T) {
	repo := newTestRepo(t)
	r := newTestRunner(t, repo)

	job, started, err := r.Start(spec("a"), func(ctx context.Context) (string, any, error) {
		progress.Start(ctx, progress.StageLogin, "登录…")
		progress.OK(ctx, progress.StageLogin, "登录成功")
		progress.Start(ctx, progress.StageBalance, "拉取余额…")
		progress.Fail(ctx, progress.StageBalance, "超时")
		progress.Start(ctx, progress.StageRates, "拉取倍率…") // 没有结论的“进行中”事件要留着
		return "部分完成", map[string]int{"n": 2}, nil
	})
	if err != nil || !started || job.Status != storage.JobRunning {
		t.Fatalf("start = %+v %v %v", job, started, err)
	}
	done := waitDone(t, repo, job.ID)
	if done.Status != storage.JobSucceeded || done.Message != "部分完成" || done.Result != `{"n":2}` || done.FinishedAt == nil {
		t.Fatalf("job = %+v", done)
	}
	var events []progress.Event
	if err := json.Unmarshal([]byte(done.Events), &events); err != nil {
		t.Fatalf("events: %v", err)
	}
	var msgs []string
	for _, ev := range events {
		msgs = append(msgs, ev.Message)
	}
	if got := strings.Join(msgs, "|"); got != "登录成功|超时|拉取倍率…" {
		t.Fatalf("compacted events = %s", got)
	}
}

func TestStartReturnsRunningJobForSameKey(t *testing.T) {
	repo := newTestRepo(t)
	r := newTestRunner(t, repo)
	gate := make(chan struct{})
	block := func(ctx context.Context) (string, any, error) {
		<-gate
		return "", nil, nil
	}

	first, _, _ := r.Start(spec("channel:1"), block)
	again, started, err := r.Start(spec("channel:1"), block)
	if err != nil || started || again.ID != first.ID {
		t.Fatalf("same key = %+v %v %v", again, started, err)
	}
	other, started, _ := r.Start(spec("channel:2"), block)
	if !started || other.ID == first.ID {
		t.Fatalf("other key should start a new job: %+v", other)
	}
	close(gate)
	waitDone(t, repo, first.ID)
	waitDone(t, repo, other.ID)

	// 跑完后同一个 Key 可以再开
	next, started, _ := r.Start(spec("channel:1"), block)
	if !started || next.ID == first.ID {
		t.Fatalf("key should be released after the job ends: %+v", next)
	}
	waitDone(t, repo, next.ID)
}

func TestFailuresAreRecorded(t *testing.T) {
	repo := newTestRepo(t)
	r := newTestRunner(t, repo)

	cases := []struct {
		name string
		spec Spec
		fn   Func
		want string
	}{
		{"error", spec(""), func(context.Context) (string, any, error) {
			return "", nil, errors.New("登录失败")
		}, "登录失败"},
		{"error with message", spec(""), func(context.Context) (string, any, error) {
			return "3 个渠道：成功 2，失败 1（b）", nil, errors.New("b：超时")
		}, "3 个渠道：成功 2，失败 1（b）"},
		{"panic", spec(""), func(context.Context) (string, any, error) {
			panic("boom")
		}, "任务异常退出：boom"},
		{"timeout", Spec{Kind: storage.JobChannelSync, Source: storage.JobManual, Title: "t", Timeout: 20 * time.Millisecond},
			func(ctx context.Context) (string, any, error) {
				<-ctx.Done()
				return "", nil, ctx.Err()
			}, "超过 20ms 还没跑完，已停止：context deadline exceeded"},
	}
	for _, tc := range cases {
		job, _, err := r.Start(tc.spec, tc.fn)
		if err != nil {
			t.Fatalf("%s: start: %v", tc.name, err)
		}
		done := waitDone(t, repo, job.ID)
		if done.Status != storage.JobFailed || done.Message != tc.want {
			t.Fatalf("%s: job = %+v", tc.name, done)
		}
	}
}

func TestRunRecordsScheduledJobAndSkipsOverlap(t *testing.T) {
	repo := newTestRepo(t)
	r := newTestRunner(t, repo)
	gate := make(chan struct{})
	first, _, _ := r.Start(Spec{Kind: storage.JobBalanceScan, Source: storage.JobManual, Key: "balance_scan"},
		func(context.Context) (string, any, error) { <-gate; return "", nil, nil })

	ran := false
	scheduled := Spec{Kind: storage.JobBalanceScan, Source: storage.JobScheduled, Title: "余额采集", Key: "balance_scan"}
	if r.Run(scheduled, func(context.Context) (string, any, error) { ran = true; return "", nil, nil }) || ran {
		t.Fatal("Run must skip while the same key is running")
	}
	close(gate)
	waitDone(t, repo, first.ID)

	if !r.Run(scheduled, func(context.Context) (string, any, error) { return "7 个渠道：成功 7", nil, nil }) {
		t.Fatal("Run should run once the key is free")
	}
	list, total, err := repo.List(storage.JobFilter{Source: storage.JobScheduled}, 1, 10)
	if err != nil || total != 1 || list[0].Status != storage.JobSucceeded || list[0].Message != "7 个渠道：成功 7" {
		t.Fatalf("scheduled jobs = %+v %d %v", list, total, err)
	}
}

func TestShutdownMarksRunningJobsInterrupted(t *testing.T) {
	repo := newTestRepo(t)
	r := NewRunner(repo, slog.New(slog.NewTextHandler(io.Discard, nil)))
	job, _, _ := r.Start(spec("a"), func(ctx context.Context) (string, any, error) {
		<-ctx.Done()
		return "", nil, ctx.Err()
	})
	r.Shutdown(5 * time.Second)
	if done, _ := repo.Get(job.ID); done.Status != storage.JobInterrupted || done.Message != InterruptedMessage {
		t.Fatalf("job = %+v", done)
	}
	if _, _, err := r.Start(spec("b"), func(context.Context) (string, any, error) { return "", nil, nil }); err == nil {
		t.Fatal("a stopped runner must not accept new jobs")
	}
}

func TestNewRunnerMarksLeftoverJobsInterrupted(t *testing.T) {
	repo := newTestRepo(t)
	left := &storage.BackgroundJob{Kind: storage.JobRateScan, Source: storage.JobScheduled, Title: "倍率采集", Status: storage.JobRunning, StartedAt: time.Now()}
	if err := repo.Create(left); err != nil {
		t.Fatalf("create: %v", err)
	}
	newTestRunner(t, repo)
	if got, _ := repo.Get(left.ID); got.Status != storage.JobInterrupted || got.FinishedAt == nil {
		t.Fatalf("leftover job = %+v", got)
	}
}
