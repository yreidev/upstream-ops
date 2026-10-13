package storage

import "gorm.io/gorm"

type LoginBackoffs struct{ db *gorm.DB }

func NewLoginBackoffs(db *gorm.DB) *LoginBackoffs { return &LoginBackoffs{db: db} }

func (r *LoginBackoffs) List() ([]LoginBackoffState, error) {
	var out []LoginBackoffState
	err := r.db.Find(&out).Error
	return out, err
}

// Save 按渠道写入或覆盖一行。
func (r *LoginBackoffs) Save(st *LoginBackoffState) error {
	return r.db.Save(st).Error
}

func (r *LoginBackoffs) Delete(channelIDs ...uint) error {
	if len(channelIDs) == 0 {
		return nil
	}
	return r.db.Where("channel_id IN ?", channelIDs).Delete(&LoginBackoffState{}).Error
}
