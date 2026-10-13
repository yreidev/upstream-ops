package storage

import (
	"errors"
	"time"

	"gorm.io/gorm"
)

// cchSyncConfigID 是 cch_sync_configs 唯一一行的主键。
const cchSyncConfigID = 1

type CCHSync struct{ db *gorm.DB }

func NewCCHSync(db *gorm.DB) *CCHSync { return &CCHSync{db: db} }

// Get 读取同步配置；还没保存过时返回未启用的空配置。
func (r *CCHSync) Get() (*CCHSyncConfig, error) {
	var cfg CCHSyncConfig
	err := r.db.Take(&cfg, cchSyncConfigID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &CCHSyncConfig{ID: cchSyncConfigID}, nil
	}
	if err != nil {
		return nil, err
	}
	return &cfg, nil
}

// SaveSettings 保存开关和地址；tokenCipher 为 nil 时保留原令牌。只改这几列，不覆盖同步状态。
func (r *CCHSync) SaveSettings(enabled bool, baseURL string, tokenCipher *string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var existing CCHSyncConfig
		err := tx.Take(&existing, cchSyncConfigID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			cfg := CCHSyncConfig{ID: cchSyncConfigID, Enabled: enabled, BaseURL: baseURL}
			if tokenCipher != nil {
				cfg.TokenCipher = *tokenCipher
			}
			return tx.Create(&cfg).Error
		}
		if err != nil {
			return err
		}
		updates := map[string]any{"enabled": enabled, "base_url": baseURL, "updated_at": time.Now()}
		if tokenCipher != nil {
			updates["token_cipher"] = *tokenCipher
		}
		return tx.Model(&CCHSyncConfig{}).Where("id = ?", cchSyncConfigID).Updates(updates).Error
	})
}

// RecordRun 记下最近一次同步的时间、结果摘要和错误（成功时 errText 为空）。
func (r *CCHSync) RecordRun(at time.Time, summary, errText string) error {
	return r.db.Model(&CCHSyncConfig{}).Where("id = ?", cchSyncConfigID).Updates(map[string]any{
		"last_run_at":  at,
		"last_summary": summary,
		"last_error":   errText,
	}).Error
}
