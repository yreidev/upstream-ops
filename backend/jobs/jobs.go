// Package jobs 在后台执行耗时任务，把进度和结果记进 background_jobs 表。
//
// 手动触发的任务用 Start 在独立 goroutine 里跑，context 来自 Runner 自己，
// 不跟浏览器那次 HTTP 请求绑定：关页面、刷新、断网都不会中断任务，页面只轮询任务记录。
// 定时任务用 Run 在调度器的 goroutine 里执行，同样记一条。
package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/yreidev/upstream-ops/backend/progress"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// InterruptedMessage 是服务停止或重启时没跑完的任务的结果说明。
const InterruptedMessage = "服务停止时还没跑完，任务已中断"

// Spec 描述一个任务。
type Spec struct {
	Kind      storage.JobKind
	Source    storage.JobSource
	ChannelID uint
	Title     string
	// Key 非空时，同一个 Key 同时只跑一个任务。
	Key string
	// Timeout 大于 0 时，超时后取消任务的 context。
	Timeout time.Duration
}

// Func 是任务本体。message 是一句话结果，result 会序列化成 JSON 存库（可为 nil）；
// 返回 error 时任务记为失败，message 为空则用 error 的内容。
type Func func(ctx context.Context) (message string, result any, err error)

type Runner struct {
	repo *storage.BackgroundJobs
	log  *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu     sync.Mutex
	active map[string]uint
}

// NewRunner 构造执行器，并把上次进程退出时没跑完的任务标成被中断。
func NewRunner(repo *storage.BackgroundJobs, log *slog.Logger) *Runner {
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runner{repo: repo, log: log, ctx: ctx, cancel: cancel, active: map[string]uint{}}
	if n, err := repo.MarkRunningInterrupted(InterruptedMessage, time.Now()); err != nil {
		log.Warn("mark interrupted jobs", "err", err)
	} else if n > 0 {
		log.Info("marked unfinished jobs as interrupted", "count", n)
	}
	return r
}

// Start 新建任务记录，在后台 goroutine 里执行 fn，立即返回。
// 同一个 Key 的任务还在跑时不新建，返回正在跑的那个，started 为 false。
func (r *Runner) Start(spec Spec, fn Func) (job *storage.BackgroundJob, started bool, err error) {
	job, started, err = r.begin(spec)
	if err != nil || !started {
		return job, false, err
	}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		r.execute(spec, job.ID, fn)
	}()
	return job, true, nil
}

// Run 在当前 goroutine 里执行 fn 并记录，定时任务用。
// 同一个 Key 的任务还在跑时直接跳过，返回 false。r 为 nil 时只执行不记录（测试用）。
func (r *Runner) Run(spec Spec, fn Func) bool {
	if r == nil {
		ctx, cancel := withTimeout(context.Background(), spec.Timeout)
		defer cancel()
		_, _, _ = fn(ctx)
		return true
	}
	job, started, err := r.begin(spec)
	if err != nil {
		r.log.Warn("create job", "kind", spec.Kind, "err", err)
		return false
	}
	if !started {
		r.log.Info("job skipped: previous run still in progress", "kind", spec.Kind, "running_job", job.ID)
		return false
	}
	r.wg.Add(1)
	defer r.wg.Done()
	r.execute(spec, job.ID, fn)
	return true
}

// Shutdown 取消所有在跑的任务，最多等 timeout 让它们记下“被中断”。
func (r *Runner) Shutdown(timeout time.Duration) {
	r.cancel()
	done := make(chan struct{})
	go func() {
		r.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		r.log.Warn("jobs still running at shutdown")
	}
}

func (r *Runner) begin(spec Spec) (*storage.BackgroundJob, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if spec.Key != "" {
		if id, ok := r.active[spec.Key]; ok {
			job, err := r.repo.Get(id)
			return job, false, err
		}
	}
	if r.ctx.Err() != nil {
		return nil, false, errors.New("服务正在停止，不再接新任务")
	}
	job := &storage.BackgroundJob{
		Kind:      spec.Kind,
		Source:    spec.Source,
		ChannelID: spec.ChannelID,
		Title:     spec.Title,
		Status:    storage.JobRunning,
		Events:    "[]",
		StartedAt: time.Now(),
	}
	if err := r.repo.Create(job); err != nil {
		return nil, false, err
	}
	if spec.Key != "" {
		r.active[spec.Key] = job.ID
	}
	return job, true, nil
}

func (r *Runner) execute(spec Spec, id uint, fn Func) {
	defer func() {
		if spec.Key != "" {
			r.mu.Lock()
			delete(r.active, spec.Key)
			r.mu.Unlock()
		}
	}()

	rec := &recorder{save: func(events string) {
		if err := r.repo.SaveEvents(id, events); err != nil {
			r.log.Warn("save job events", "job", id, "err", err)
		}
	}}
	ctx, cancel := withTimeout(r.ctx, spec.Timeout)
	defer cancel()

	message, result, err := r.call(progress.WithObserver(ctx, rec), fn)

	status := storage.JobSucceeded
	switch {
	case err != nil && r.ctx.Err() != nil:
		status, message = storage.JobInterrupted, InterruptedMessage
	case err != nil:
		status = storage.JobFailed
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			message = fmt.Sprintf("超过 %s 还没跑完，已停止：%v", spec.Timeout, err)
		} else if message == "" {
			message = err.Error()
		}
	case message == "":
		message = "完成"
	}

	resultJSON := ""
	if result != nil {
		if b, mErr := json.Marshal(result); mErr == nil {
			resultJSON = string(b)
		} else {
			r.log.Warn("encode job result", "job", id, "err", mErr)
		}
	}
	if fErr := r.repo.Finish(id, status, message, rec.compacted(), resultJSON, time.Now()); fErr != nil {
		r.log.Warn("finish job", "job", id, "err", fErr)
	}
}

// call 执行任务本体，panic 时记成失败，不让整个进程退出。
func (r *Runner) call(ctx context.Context, fn Func) (message string, result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			r.log.Error("job panicked", "panic", p, "stack", string(debug.Stack()))
			message, result, err = "", nil, fmt.Errorf("任务异常退出：%v", p)
		}
	}()
	return fn(ctx)
}

func withTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d > 0 {
		return context.WithTimeout(ctx, d)
	}
	return context.WithCancel(ctx)
}

// recorder 收集进度事件，每来一条就整体写回任务记录，页面轮询时能看到最新进度。
type recorder struct {
	mu     sync.Mutex
	events []progress.Event
	save   func(string)
}

func (o *recorder) Emit(ev progress.Event) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.events = append(o.events, ev)
	o.save(encodeEvents(o.events))
}

// compacted 去掉已经有结果的“进行中”事件，只留每步的结论，存库时用。
func (o *recorder) compacted() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return encodeEvents(compactEvents(o.events))
}

func compactEvents(events []progress.Event) []progress.Event {
	type step struct {
		stage     progress.Stage
		channelID uint
	}
	done := map[step]bool{}
	keep := make([]bool, len(events))
	for i := len(events) - 1; i >= 0; i-- {
		ev := events[i]
		k := step{ev.Stage, ev.ChannelID}
		if ev.OK != nil {
			done[k] = true
			keep[i] = true
			continue
		}
		keep[i] = !done[k]
	}
	out := make([]progress.Event, 0, len(events))
	for i, ev := range events {
		if keep[i] {
			out = append(out, ev)
		}
	}
	return out
}

func encodeEvents(events []progress.Event) string {
	if len(events) == 0 {
		return "[]"
	}
	b, err := json.Marshal(events)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// DeleteBefore 删除 cutoff 之前开始、已经结束的任务记录，定时清理用。
func (r *Runner) DeleteBefore(cutoff time.Time) (int64, error) {
	return r.repo.DeleteBefore(cutoff)
}
