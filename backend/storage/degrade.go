package storage

import (
	"time"

	"gorm.io/gorm"
)

// DegradeState 一把密钥在降智检测里确认过的状态。
type DegradeState string

const (
	DegradeUnknown  DegradeState = "unknown"  // 新加入，还没有三次一致的结果
	DegradeNormal   DegradeState = "normal"   // 确认正常
	DegradeDegraded DegradeState = "degraded" // 确认降智
)

// DegradeResult 一次检测的结果。
type DegradeResult string

const (
	DegradeCorrect DegradeResult = "correct" // 答对
	DegradeWrong   DegradeResult = "wrong"   // 答错
	DegradeFailed  DegradeResult = "failed"  // 请求失败，或模型没给出回答
)

// DegradeKeySource 完整密钥是怎么拿到的。
type DegradeKeySource string

const (
	DegradeKeyRevealed DegradeKeySource = "revealed" // 加入时从渠道接口取的
	DegradeKeyPasted   DegradeKeySource = "pasted"   // 站点不让接口取，手动粘贴的
)

// DegradeKey 参与降智检测的一把上游密钥。完整密钥加密存在 KeyCipher，不经接口返回。
// Model / Effort 为空表示用设置页的默认值；Effort 为 "none" 表示不指定推理强度，由上游决定。
type DegradeKey struct {
	ID            uint             `gorm:"primaryKey" json:"id"`
	ChannelID     uint             `gorm:"not null;uniqueIndex:idx_degrade_keys_upstream" json:"channel_id"`
	UpstreamKeyID int64            `gorm:"not null;uniqueIndex:idx_degrade_keys_upstream" json:"upstream_key_id"`
	Name          string           `gorm:"size:255;not null;default:''" json:"name"`
	GroupName     string           `gorm:"size:255;not null;default:''" json:"group_name"`
	KeyCipher     string           `gorm:"size:4096;not null" json:"-"`
	KeyTail       string           `gorm:"size:8;not null;default:''" json:"key_tail"`
	KeySource     DegradeKeySource `gorm:"size:16;not null;default:'revealed'" json:"key_source"`
	Model         string           `gorm:"size:128;not null;default:''" json:"model"`
	Effort        string           `gorm:"size:16;not null;default:''" json:"effort"`
	State         DegradeState     `gorm:"size:16;not null;default:'unknown'" json:"state"`
	// StateChangedAt 最近一次确认状态的时间；还没确认过时为空。
	StateChangedAt *time.Time `json:"state_changed_at,omitempty"`
	// 最近一轮检测：时间、首测结果和一句话说明。
	LastCheckedAt *time.Time    `json:"last_checked_at,omitempty"`
	LastResult    DegradeResult `gorm:"size:16;not null;default:''" json:"last_result,omitempty"`
	LastMessage   string        `gorm:"type:text" json:"last_message,omitempty"`
	CreatedAt     time.Time     `json:"created_at"`
	UpdatedAt     time.Time     `json:"updated_at"`
}

func (DegradeKey) TableName() string { return "degrade_keys" }

// DegradeCheck 一次检测（一道糖果题）的记录。Attempt 是这一轮里的第几次：1 是首测，2、3 是复测。
type DegradeCheck struct {
	ID              uint          `gorm:"primaryKey" json:"id"`
	KeyID           uint          `gorm:"not null;index" json:"key_id"`
	ChannelID       uint          `gorm:"not null;index" json:"channel_id"`
	Attempt         int           `gorm:"not null" json:"attempt"`
	Model           string        `gorm:"size:128;not null" json:"model"`
	Effort          string        `gorm:"size:16;not null;default:''" json:"effort"`
	Result          DegradeResult `gorm:"size:16;not null" json:"result"`
	Answer          string        `gorm:"type:text" json:"answer,omitempty"`
	Error           string        `gorm:"type:text" json:"error,omitempty"`
	InputTokens     int64         `json:"input_tokens"`
	OutputTokens    int64         `json:"output_tokens"`
	ReasoningTokens int64         `json:"reasoning_tokens"`
	DurationMs      int64         `json:"duration_ms"`
	CheckedAt       time.Time     `gorm:"not null;index" json:"checked_at"`
}

func (DegradeCheck) TableName() string { return "degrade_checks" }

type DegradeKeys struct{ db *gorm.DB }

func NewDegradeKeys(db *gorm.DB) *DegradeKeys { return &DegradeKeys{db: db} }

// List 按渠道、加入顺序列出全部密钥。
func (r *DegradeKeys) List() ([]DegradeKey, error) {
	var list []DegradeKey
	err := r.db.Order("channel_id, id").Find(&list).Error
	return list, err
}

func (r *DegradeKeys) Get(id uint) (*DegradeKey, error) {
	var k DegradeKey
	if err := r.db.First(&k, id).Error; err != nil {
		return nil, err
	}
	return &k, nil
}

// FindByUpstream 按渠道和上游密钥 ID 找已加入的密钥，没有时返回 gorm.ErrRecordNotFound。
func (r *DegradeKeys) FindByUpstream(channelID uint, upstreamKeyID int64) (*DegradeKey, error) {
	var k DegradeKey
	if err := r.db.Where("channel_id = ? AND upstream_key_id = ?", channelID, upstreamKeyID).First(&k).Error; err != nil {
		return nil, err
	}
	return &k, nil
}

func (r *DegradeKeys) Create(k *DegradeKey) error {
	if k.State == "" {
		k.State = DegradeUnknown
	}
	return r.db.Create(k).Error
}

// UpdateKey 换掉存着的完整密钥。
func (r *DegradeKeys) UpdateKey(id uint, cipher, tail string, source DegradeKeySource) error {
	return r.db.Model(&DegradeKey{}).Where("id = ?", id).Updates(map[string]any{
		"key_cipher": cipher,
		"key_tail":   tail,
		"key_source": source,
	}).Error
}

// UpdateModel 改这把密钥单独用的模型和推理强度，空字符串表示用默认值。
func (r *DegradeKeys) UpdateModel(id uint, model, effort string) error {
	return r.db.Model(&DegradeKey{}).Where("id = ?", id).Updates(map[string]any{
		"model":  model,
		"effort": effort,
	}).Error
}

// RecordRound 记下一轮检测的结论；state 非空时同时改确认状态。
func (r *DegradeKeys) RecordRound(id uint, at time.Time, result DegradeResult, message string, state DegradeState) error {
	updates := map[string]any{
		"last_checked_at": at,
		"last_result":     result,
		"last_message":    message,
	}
	if state != "" {
		updates["state"] = state
		updates["state_changed_at"] = at
	}
	return r.db.Model(&DegradeKey{}).Where("id = ?", id).Updates(updates).Error
}

// Delete 删掉密钥和它的检测记录。
func (r *DegradeKeys) Delete(id uint) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("key_id = ?", id).Delete(&DegradeCheck{}).Error; err != nil {
			return err
		}
		return tx.Delete(&DegradeKey{}, id).Error
	})
}

func (r *DegradeKeys) AppendCheck(c *DegradeCheck) error {
	return r.db.Create(c).Error
}

// ListChecks 按时间倒序列出一把密钥最近的检测记录。
func (r *DegradeKeys) ListChecks(keyID uint, limit int) ([]DegradeCheck, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var list []DegradeCheck
	err := r.db.Where("key_id = ?", keyID).Order("checked_at DESC, id DESC").Limit(limit).Find(&list).Error
	return list, err
}

// DeleteChecksBefore 删掉 cutoff 之前的检测记录，确认状态不受影响。
func (r *DegradeKeys) DeleteChecksBefore(cutoff time.Time) (int64, error) {
	res := r.db.Where("checked_at < ?", cutoff).Delete(&DegradeCheck{})
	return res.RowsAffected, res.Error
}
