package storage

import (
	"time"

	"gorm.io/gorm"
)

// JobKind 后台任务类型。
type JobKind string

const (
	JobChannelSync      JobKind = "channel_sync"       // 同步单个渠道：余额、消费、倍率
	JobChannelTestLogin JobKind = "channel_test_login" // 测试单个渠道的登录
	JobChannelSyncAll   JobKind = "channel_sync_all"   // 同步全部渠道的余额和消费
	JobBalanceScan      JobKind = "balance_scan"       // 定时余额采集（含打码平台余额）
	JobRateScan         JobKind = "rate_scan"          // 定时倍率采集
	JobCCHSync          JobKind = "cch_sync"           // 把分组倍率同步到 CCH
	JobRetention        JobKind = "retention"          // 定时清理过期历史
)

// JobSource 任务是怎么触发的。
type JobSource string

const (
	JobManual    JobSource = "manual"
	JobScheduled JobSource = "scheduled"
)

// JobStatus 任务状态。
type JobStatus string

const (
	JobRunning     JobStatus = "running"
	JobSucceeded   JobStatus = "succeeded"
	JobFailed      JobStatus = "failed"
	JobInterrupted JobStatus = "interrupted" // 服务停止或重启时还没跑完
)

// BackgroundJob 一次后台任务的记录。Events 是进度事件的 JSON 数组，Result 是任务结果的 JSON，
// 都由 jobs 包写入，接口原样返回。
type BackgroundJob struct {
	ID         uint       `gorm:"primaryKey" json:"id"`
	Kind       JobKind    `gorm:"size:32;not null;index" json:"kind"`
	Source     JobSource  `gorm:"size:16;not null;index" json:"source"`
	ChannelID  uint       `gorm:"not null" json:"channel_id,omitempty"`
	Title      string     `gorm:"size:255;not null" json:"title"`
	Status     JobStatus  `gorm:"size:16;not null;index" json:"status"`
	Message    string     `gorm:"type:text" json:"message,omitempty"`
	Events     string     `gorm:"type:text" json:"-"`
	Result     string     `gorm:"type:text" json:"-"`
	StartedAt  time.Time  `gorm:"not null;index" json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

func (BackgroundJob) TableName() string { return "background_jobs" }

type BackgroundJobs struct{ db *gorm.DB }

func NewBackgroundJobs(db *gorm.DB) *BackgroundJobs { return &BackgroundJobs{db: db} }

func (r *BackgroundJobs) Create(j *BackgroundJob) error {
	return r.db.Create(j).Error
}

// SaveEvents 运行中更新进度事件。
func (r *BackgroundJobs) SaveEvents(id uint, events string) error {
	return r.db.Model(&BackgroundJob{}).Where("id = ?", id).Update("events", events).Error
}

// Finish 写入最终状态、结果和整理过的进度事件。
func (r *BackgroundJobs) Finish(id uint, status JobStatus, message, events, result string, finishedAt time.Time) error {
	return r.db.Model(&BackgroundJob{}).Where("id = ?", id).Updates(map[string]any{
		"status":      status,
		"message":     message,
		"events":      events,
		"result":      result,
		"finished_at": finishedAt,
	}).Error
}

func (r *BackgroundJobs) Get(id uint) (*BackgroundJob, error) {
	var j BackgroundJob
	if err := r.db.First(&j, id).Error; err != nil {
		return nil, err
	}
	return &j, nil
}

// JobFilter 列表筛选，零值表示不过滤。
type JobFilter struct {
	Kind   JobKind
	Source JobSource
	Status JobStatus
}

// List 按开始时间倒序分页，不带进度事件和结果。
func (r *BackgroundJobs) List(f JobFilter, page, pageSize int) ([]BackgroundJob, int64, error) {
	q := r.db.Model(&BackgroundJob{})
	if f.Kind != "" {
		q = q.Where("kind = ?", f.Kind)
	}
	if f.Source != "" {
		q = q.Where("source = ?", f.Source)
	}
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var list []BackgroundJob
	err := q.Omit("events", "result").
		Order("started_at DESC").Order("id DESC").
		Offset((page - 1) * pageSize).Limit(pageSize).
		Find(&list).Error
	return list, total, err
}

// ListRunning 返回所有还在跑的任务（带进度事件），页面打开时用它接上进度。
func (r *BackgroundJobs) ListRunning() ([]BackgroundJob, error) {
	var list []BackgroundJob
	err := r.db.Where("status = ?", JobRunning).Order("id").Find(&list).Error
	return list, err
}

// MarkRunningInterrupted 把上次进程退出时没跑完的任务标成被中断，启动时调用。
func (r *BackgroundJobs) MarkRunningInterrupted(message string, at time.Time) (int64, error) {
	res := r.db.Model(&BackgroundJob{}).Where("status = ?", JobRunning).Updates(map[string]any{
		"status":      JobInterrupted,
		"message":     message,
		"finished_at": at,
	})
	return res.RowsAffected, res.Error
}

// DeleteBefore 删除 started_at < cutoff 且已经结束的任务，返回删除行数。
func (r *BackgroundJobs) DeleteBefore(cutoff time.Time) (int64, error) {
	res := r.db.Where("started_at < ? AND status <> ?", cutoff, JobRunning).Delete(&BackgroundJob{})
	return res.RowsAffected, res.Error
}
