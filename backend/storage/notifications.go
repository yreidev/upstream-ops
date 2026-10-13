package storage

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Notifications struct{ db *gorm.DB }

func NewNotifications(db *gorm.DB) *Notifications { return &Notifications{db: db} }

func (r *Notifications) ListChannels() ([]NotificationChannel, error) {
	var list []NotificationChannel
	if err := r.db.Order("id ASC").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (r *Notifications) ListEnabledChannels() ([]NotificationChannel, error) {
	var list []NotificationChannel
	if err := r.db.Where("enabled = ?", true).Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (r *Notifications) FindChannel(id uint) (*NotificationChannel, error) {
	var c NotificationChannel
	if err := r.db.First(&c, id).Error; err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *Notifications) CreateChannel(c *NotificationChannel) error { return r.db.Create(c).Error }
func (r *Notifications) UpdateChannel(c *NotificationChannel) error { return r.db.Save(c).Error }
func (r *Notifications) DeleteChannel(id uint) error {
	return r.db.Delete(&NotificationChannel{}, id).Error
}

func (r *Notifications) AppendLog(l *NotificationLog) error {
	if l.SentAt.IsZero() {
		l.SentAt = time.Now()
	}
	return r.db.Create(l).Error
}

func (r *Notifications) ListLogs(limit int) ([]NotificationLog, error) {
	if limit <= 0 {
		limit = 100
	}
	var list []NotificationLog
	if err := r.db.Order("sent_at DESC").Limit(limit).Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (r *Notifications) ListLogsPage(page, pageSize int) ([]NotificationLog, int64, error) {
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	var total int64
	if err := r.db.Model(&NotificationLog{}).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var list []NotificationLog
	if err := r.db.Order("sent_at DESC").
		Offset((page - 1) * pageSize).
		Limit(pageSize).
		Find(&list).Error; err != nil {
		return nil, 0, err
	}
	return list, total, nil
}

// DeleteLogsBefore 删除 sent_at < cutoff 的通知日志，返回删除行数。
func (r *Notifications) DeleteLogsBefore(cutoff time.Time) (int64, error) {
	res := r.db.Where("sent_at < ?", cutoff).Delete(&NotificationLog{})
	return res.RowsAffected, res.Error
}

// TryClaimCooldown 原子地尝试占用 (channelID, event) 的发送名额。
//
// 语义：
//   - 不存在该记录 → 插入 (last_sent_at=now)，返回 true（应该发送）
//   - 存在但 last_sent_at < now - cooldown → 更新成 now，返回 true
//   - 存在且仍在冷却窗口 → 不动，返回 false（跳过发送）
//
// 通过"先更新过期记录，再插入新记录"完成原子占用，避免并发扫描下重复发送。
//
// cooldown <= 0 时直接返回 true 不写表。
func (r *Notifications) TryClaimCooldown(channelID uint, event NotificationEvent, cooldown time.Duration) (bool, error) {
	if cooldown <= 0 {
		return true, nil
	}
	now := time.Now()
	threshold := now.Add(-cooldown)

	res := r.db.Model(&NotificationCooldown{}).
		Where("channel_id = ? AND event = ? AND last_sent_at < ?", channelID, event, threshold).
		Updates(map[string]any{
			"last_sent_at": now,
			"updated_at":   now,
		})
	if res.Error != nil {
		return false, res.Error
	}
	if res.RowsAffected > 0 {
		return true, nil
	}

	res = r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&NotificationCooldown{
		ChannelID:  channelID,
		Event:      event,
		LastSentAt: now,
		UpdatedAt:  now,
	})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// ResetCooldown 删除某个 (channelID, event) 的冷却记录。
// 主要给测试 / 调试用，业务路径不需要主动调用。
func (r *Notifications) ResetCooldown(channelID uint, event NotificationEvent) error {
	return r.db.Where("channel_id = ? AND event = ?", channelID, event).
		Delete(&NotificationCooldown{}).Error
}

// RecordFailure 给 (channelID, kind) 的连续失败次数加一并返回最新状态；没有记录时新建。
// 调用方负责并发互斥（notify.Dispatcher 用一把锁串行化）。
func (r *Notifications) RecordFailure(channelID uint, kind string, errText string, at time.Time) (*NotificationFailureState, error) {
	var state NotificationFailureState
	err := r.db.Where("channel_id = ? AND kind = ?", channelID, kind).Take(&state).Error
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		state = NotificationFailureState{
			ChannelID:     channelID,
			Kind:          kind,
			Failures:      1,
			FirstFailedAt: at,
			LastFailedAt:  at,
			LastError:     errText,
		}
		if err := r.db.Create(&state).Error; err != nil {
			return nil, err
		}
		return &state, nil
	case err != nil:
		return nil, err
	}
	state.Failures++
	state.LastFailedAt = at
	state.LastError = errText
	if err := r.db.Model(&NotificationFailureState{}).
		Where("channel_id = ? AND kind = ?", channelID, kind).
		Updates(map[string]any{
			"failures":       state.Failures,
			"last_failed_at": at,
			"last_error":     errText,
		}).Error; err != nil {
		return nil, err
	}
	return &state, nil
}

// MarkFailureNotified 记下 (channelID, kind) 最近一次发失败通知的时间。
func (r *Notifications) MarkFailureNotified(channelID uint, kind string, at time.Time) error {
	return r.db.Model(&NotificationFailureState{}).
		Where("channel_id = ? AND kind = ?", channelID, kind).
		Update("notified_at", at).Error
}

// ClearFailures 删除 channelID 下这些类别的失败状态，返回删除前的记录（调用方据此决定是否发恢复通知）。
func (r *Notifications) ClearFailures(channelID uint, kinds []string) ([]NotificationFailureState, error) {
	if len(kinds) == 0 {
		return nil, nil
	}
	var states []NotificationFailureState
	if err := r.db.Where("channel_id = ? AND kind IN ?", channelID, kinds).Find(&states).Error; err != nil {
		return nil, err
	}
	if len(states) == 0 {
		return nil, nil
	}
	if err := r.db.Where("channel_id = ? AND kind IN ?", channelID, kinds).
		Delete(&NotificationFailureState{}).Error; err != nil {
		return nil, err
	}
	return states, nil
}
