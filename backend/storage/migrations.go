package storage

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/yreidev/upstream-ops/backend/redact"
)

// dataMigrations 是一次性数据迁移，按顺序执行；执行成功后写入 applied_migrations，以后启动不再执行。
// 名字一旦发布就不要改，否则会被当成新迁移再跑一遍。
var dataMigrations = []struct {
	name string
	run  func(*gorm.DB) error
}{
	{name: "20261013_notification_subscriptions", run: migrateNotificationSubscriptions},
	{name: "20261013_redact_notification_log_secrets", run: redactNotificationLogSecrets},
}

func runDataMigrations(db *gorm.DB) error {
	for _, m := range dataMigrations {
		var count int64
		if err := db.Model(&AppliedMigration{}).Where("name = ?", m.name).Count(&count).Error; err != nil {
			return fmt.Errorf("check data migration %s: %w", m.name, err)
		}
		if count > 0 {
			continue
		}
		if err := db.Transaction(func(tx *gorm.DB) error {
			if err := m.run(tx); err != nil {
				return err
			}
			return tx.Create(&AppliedMigration{Name: m.name, AppliedAt: time.Now()}).Error
		}); err != nil {
			return fmt.Errorf("data migration %s: %w", m.name, err)
		}
	}
	return nil
}

// subscriptionEventsAdded 是迁移时补进"已勾选事件"列表的事件：
// 失败通知改成连续失败才发、恢复时补发通知后，噪音已经降下来，之前因刷屏取消的可以重新勾上。
var subscriptionEventsAdded = []NotificationEvent{EventLoginFailed, EventMonitorFailed, EventRecovered}

// removedSubscriptionEventPrefix 是已移除的订阅管理功能留下的事件（subscription_expiring 等）。
const removedSubscriptionEventPrefix = "subscription_"

// migrateNotificationSubscriptions 升级通知渠道的订阅规则：
//   - 规则选中的上游覆盖了"该通知渠道最后一次保存时已有的全部上游"，说明当时是全选，
//     改为 all_channels（含以后新增的上游）。channel_ids 原样保留，回滚到旧版本仍然可用。
//     按分组过滤（mode=groups）的规则和分组绑定，不改。
//   - 去掉已移除功能的 subscription_* 事件。
//   - 事件列表非空（不是"全部事件"）时补上 subscriptionEventsAdded。
//
// 解析不了的订阅 JSON 原样保留。用 UpdateColumn 写回，不改通知渠道的 updated_at。
func migrateNotificationSubscriptions(db *gorm.DB) error {
	var notifyChannels []NotificationChannel
	if err := db.Find(&notifyChannels).Error; err != nil {
		return err
	}
	if len(notifyChannels) == 0 {
		return nil
	}
	var upstreams []struct {
		ID        uint
		CreatedAt time.Time
	}
	if err := db.Model(&Channel{}).Select("id", "created_at").Find(&upstreams).Error; err != nil {
		return err
	}
	for _, nc := range notifyChannels {
		raw := strings.TrimSpace(nc.Subscriptions)
		if raw == "" || raw == "null" || raw == "[]" {
			continue
		}
		var subs []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &subs); err != nil {
			continue
		}
		var existing []uint
		for _, u := range upstreams {
			if !u.CreatedAt.After(nc.UpdatedAt) {
				existing = append(existing, u.ID)
			}
		}
		changed := false
		for _, sub := range subs {
			if upgradeSubscription(sub, existing) {
				changed = true
			}
		}
		if !changed {
			continue
		}
		out, err := json.Marshal(subs)
		if err != nil {
			return err
		}
		if err := db.Model(&NotificationChannel{}).Where("id = ?", nc.ID).
			UpdateColumn("subscriptions", string(out)).Error; err != nil {
			return err
		}
	}
	return nil
}

func upgradeSubscription(sub map[string]json.RawMessage, existingUpstreams []uint) bool {
	changed := false

	var allChannels bool
	_ = json.Unmarshal(sub["all_channels"], &allChannels)
	var mode string
	_ = json.Unmarshal(sub["mode"], &mode)
	if !allChannels && mode != "groups" && len(existingUpstreams) > 0 {
		var ids []uint
		_ = json.Unmarshal(sub["channel_ids"], &ids)
		covered := true
		for _, id := range existingUpstreams {
			if !slices.Contains(ids, id) {
				covered = false
				break
			}
		}
		if covered {
			sub["all_channels"] = json.RawMessage("true")
			changed = true
		}
	}

	var events []NotificationEvent
	if err := json.Unmarshal(sub["events"], &events); err == nil && len(events) > 0 {
		kept := make([]NotificationEvent, 0, len(events)+len(subscriptionEventsAdded))
		for _, e := range events {
			if !strings.HasPrefix(string(e), removedSubscriptionEventPrefix) {
				kept = append(kept, e)
			}
		}
		for _, e := range subscriptionEventsAdded {
			if !slices.Contains(kept, e) {
				kept = append(kept, e)
			}
		}
		if !slices.Equal(kept, events) {
			encoded, err := json.Marshal(kept)
			if err == nil {
				sub["events"] = encoded
				changed = true
			}
		}
	}
	return changed
}

// redactNotificationLogSecrets 抹掉旧版本写进通知发送记录的密钥：
// 发送失败时错误信息里带着完整请求 URL，里面有 Telegram bot token 或企业微信 key。
func redactNotificationLogSecrets(db *gorm.DB) error {
	var rows []struct {
		ID           uint
		ErrorMessage string
	}
	if err := db.Model(&NotificationLog{}).Select("id", "error_message").
		Where("error_message LIKE ? OR error_message LIKE ?", "%telegram.org/%bot%", "%key=%").
		Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		cleaned := redact.Secrets(row.ErrorMessage)
		if cleaned == row.ErrorMessage {
			continue
		}
		if err := db.Model(&NotificationLog{}).Where("id = ?", row.ID).
			UpdateColumn("error_message", cleaned).Error; err != nil {
			return err
		}
	}
	return nil
}
