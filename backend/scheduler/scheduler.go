// Package scheduler 用 robfig/cron 触发周期性扫描。
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/yreidev/upstream-ops/backend/captcha"
	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/crypto"
	"github.com/yreidev/upstream-ops/backend/jobs"
	"github.com/yreidev/upstream-ops/backend/monitor"
	"github.com/yreidev/upstream-ops/backend/progress"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// scanTimeout 一轮定时任务最长跑多久。
const scanTimeout = 5 * time.Minute

// specParser 和 cron.WithSeconds() 的规则相同：带秒，共 6 段，也认 @every 这类写法。
var specParser = cron.NewParser(cron.Second | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

// ParseSpec 按调度器的规则检查 cron 表达式，保存配置前用它拦住写错的表达式。
func ParseSpec(spec string) error {
	_, err := specParser.Parse(spec)
	return err
}

// Scheduler 周期性任务调度器。
type Scheduler struct {
	cfg           config.SchedulerConfig
	log           *slog.Logger
	cron          *cron.Cron
	monitor       *monitor.Service
	monLogs       *storage.MonitorLogs
	rates         *storage.Rates
	notifies      *storage.Notifications
	announcements *storage.UpstreamAnnouncements
	captchas      *storage.Captchas
	cipher        *crypto.Cipher
	jobs          *jobs.Runner
	afterRates    func()
	degradeRun    func()
	degradeChecks *storage.DegradeKeys
}

// New 构造调度器。
func New(
	cfg config.SchedulerConfig,
	m *monitor.Service,
	monLogs *storage.MonitorLogs,
	rates *storage.Rates,
	notifies *storage.Notifications,
	announcements *storage.UpstreamAnnouncements,
	captchas *storage.Captchas,
	cipher *crypto.Cipher,
	log *slog.Logger,
) *Scheduler {
	return &Scheduler{
		cfg:           cfg,
		log:           log,
		cron:          cron.New(cron.WithParser(specParser)),
		monitor:       m,
		monLogs:       monLogs,
		rates:         rates,
		notifies:      notifies,
		announcements: announcements,
		captchas:      captchas,
		cipher:        cipher,
	}
}

// WithJobs 让每轮定时任务都记进后台任务表，在 Start 之前调用。不设置时只执行不记录。
func (s *Scheduler) WithJobs(r *jobs.Runner) *Scheduler {
	s.jobs = r
	return s
}

// OnRatesScanned 注册每轮定时倍率采集结束后要跑的任务（把分组倍率同步到 CCH），在 Start 之前调用。
func (s *Scheduler) OnRatesScanned(fn func()) *Scheduler {
	s.afterRates = fn
	return s
}

// WithDegrade 接上 GPT 降智检测：按 DegradeCron 跑 run（巡检全部密钥），清理历史时按监控日志的天数删检测记录。
// 在 Start 之前调用。
func (s *Scheduler) WithDegrade(checks *storage.DegradeKeys, run func()) *Scheduler {
	s.degradeChecks = checks
	s.degradeRun = run
	return s
}

// Start 注册 cron 任务并启动。
func (s *Scheduler) Start() error {
	if s.cfg.BalanceCron != "" {
		if _, err := s.cron.AddFunc(s.cfg.BalanceCron, s.runBalance); err != nil {
			return err
		}
	}
	if s.cfg.RateCron != "" {
		if _, err := s.cron.AddFunc(s.cfg.RateCron, s.runRates); err != nil {
			return err
		}
	}
	if s.cfg.DegradeCron != "" && s.degradeRun != nil {
		if _, err := s.cron.AddFunc(s.cfg.DegradeCron, s.degradeRun); err != nil {
			return err
		}
	}
	if s.cfg.Retention.Cron != "" && s.hasRetention() {
		if _, err := s.cron.AddFunc(s.cfg.Retention.Cron, s.runRetention); err != nil {
			return err
		}
	}
	s.cron.Start()
	s.log.Info("scheduler started",
		"balanceCron", s.cfg.BalanceCron,
		"rateCron", s.cfg.RateCron,
		"retentionCron", s.cfg.Retention.Cron,
		"degradeCron", s.cfg.DegradeCron,
	)
	return nil
}

// Stop 停止调度器。
func (s *Scheduler) Stop() {
	if s.cron != nil {
		<-s.cron.Stop().Done()
	}
}

func (s *Scheduler) runBalance() {
	s.jobs.Run(jobs.Spec{
		Kind:    storage.JobBalanceScan,
		Source:  storage.JobScheduled,
		Title:   "余额采集",
		Key:     string(storage.JobBalanceScan),
		Timeout: scanTimeout,
	}, func(ctx context.Context) (string, any, error) {
		sum, err := s.monitor.ScanAllBalances(ctx)
		if err != nil {
			return "", nil, err
		}
		msg := sum.Message()
		if failed := s.refreshCaptchaBalances(ctx); failed > 0 {
			msg += fmt.Sprintf("；打码平台余额查询失败 %d 个", failed)
		}
		return msg, sum, sum.Err()
	})
}

// refreshCaptchaBalances 顺带刷新打码平台余额，失败只记进度事件和日志，不算这轮采集失败。
func (s *Scheduler) refreshCaptchaBalances(ctx context.Context) int {
	if s.captchas == nil || s.cipher == nil {
		return 0
	}
	results, err := captcha.RefreshAllBalances(ctx, s.captchas, s.cipher, s.log)
	if err != nil {
		s.log.Warn("refresh captcha balances failed", "err", err)
		progress.Fail(ctx, progress.StageCaptcha, "打码平台余额查询失败："+err.Error())
		return 1
	}
	failed := 0
	for _, r := range results {
		if r.Error != nil {
			failed++
			progress.Fail(ctx, progress.StageCaptcha, "打码平台余额查询失败："+r.Error.Error())
		}
	}
	return failed
}

func (s *Scheduler) runRates() {
	if s.monitor != nil {
		s.jobs.Run(jobs.Spec{
			Kind:    storage.JobRateScan,
			Source:  storage.JobScheduled,
			Title:   "倍率采集",
			Key:     string(storage.JobRateScan),
			Timeout: scanTimeout,
		}, func(ctx context.Context) (string, any, error) {
			sum, err := s.monitor.ScanAllRates(ctx)
			if err != nil {
				return "", nil, err
			}
			return sum.Message(), sum, sum.Err()
		})
	}
	if s.afterRates != nil {
		s.afterRates()
	}
}

func (s *Scheduler) hasRetention() bool {
	r := s.cfg.Retention
	return r.MonitorLogsDays > 0 ||
		r.BalanceSnapshotsDays > 0 ||
		r.NotificationLogsDays > 0 ||
		r.AnnouncementsDays > 0
}

// runRetention 按配置删除过期历史。任一表失败不影响其它，有失败时这轮记为失败。
func (s *Scheduler) runRetention() {
	s.jobs.Run(jobs.Spec{
		Kind:    storage.JobRetention,
		Source:  storage.JobScheduled,
		Title:   "清理过期历史",
		Key:     string(storage.JobRetention),
		Timeout: scanTimeout,
	}, func(ctx context.Context) (string, any, error) {
		return s.retention(ctx)
	})
}

func (s *Scheduler) retention(ctx context.Context) (string, any, error) {
	r := s.cfg.Retention
	now := time.Now()
	deleted := map[string]int64{}
	var done, failed []string

	clean := func(label string, days int, del func(time.Time) (int64, error)) {
		if days <= 0 {
			return
		}
		cutoff := now.AddDate(0, 0, -days)
		n, err := del(cutoff)
		if err != nil {
			s.log.Warn("retention failed", "table", label, "err", err)
			failed = append(failed, label+"："+err.Error())
			progress.Fail(ctx, progress.StageDone, fmt.Sprintf("清理%s失败：%v", label, err))
			return
		}
		deleted[label] = n
		if n > 0 {
			s.log.Info("retention deleted", "table", label, "rows", n, "before", cutoff)
			done = append(done, fmt.Sprintf("%s %d 条", label, n))
		}
		progress.OK(ctx, progress.StageDone, fmt.Sprintf("%s：删除 %d 条 %d 天前的记录", label, n, days))
	}

	if s.monLogs != nil {
		clean("监控日志", r.MonitorLogsDays, s.monLogs.DeleteBefore)
	}
	if s.jobs != nil {
		clean("后台任务", r.MonitorLogsDays, s.jobs.DeleteBefore)
	}
	if s.degradeChecks != nil {
		clean("降智检测记录", r.MonitorLogsDays, s.degradeChecks.DeleteChecksBefore)
	}
	if s.rates != nil {
		clean("余额快照", r.BalanceSnapshotsDays, s.rates.DeleteBalanceSnapshotsBefore)
		clean("消费快照", r.BalanceSnapshotsDays, s.rates.DeleteCostSnapshotsBefore)
	}
	if s.notifies != nil {
		clean("通知记录", r.NotificationLogsDays, s.notifies.DeleteLogsBefore)
	}
	if s.announcements != nil {
		clean("上游公告", r.AnnouncementsDays, s.announcements.DeleteBefore)
	}

	msg := "没有过期记录"
	if len(done) > 0 {
		msg = "删除了" + strings.Join(done, "、")
	}
	if len(failed) > 0 {
		return msg + "；失败：" + strings.Join(failed, "；"), deleted, errors.New(strings.Join(failed, "；"))
	}
	return msg, deleted, nil
}
