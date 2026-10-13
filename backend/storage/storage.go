// Package storage 提供 GORM 仓储与领域模型持久化。
package storage

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	sqliteDriver "github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// DBConfig 是 SQLite 数据库配置。
type DBConfig struct {
	Path string
}

func (c DBConfig) SQLitePath() string {
	if strings.TrimSpace(c.Path) != "" {
		return c.Path
	}
	return "./data/upstream-ops.db"
}

// newGormLogger 关掉 GORM 默认 logger 对 ErrRecordNotFound 的告警噪音。
//
// 业务代码（如 Rates.Upsert）显式处理了"找不到就插入"，这种情况下 GORM 默认仍会
// 把 record not found 当 Warn 打出来，造成日志看起来满是错误其实没问题。
// IgnoreRecordNotFoundError = true 可以静默这类预期内的"未找到"。
func newGormLogger() logger.Interface {
	return logger.New(
		log.New(os.Stdout, "\r\n", log.LstdFlags),
		logger.Config{
			SlowThreshold:             200 * time.Millisecond,
			LogLevel:                  logger.Warn,
			IgnoreRecordNotFoundError: true,
			Colorful:                  true,
		},
	)
}

// restoreFalse 把刚新建的一行里带 default:true 的布尔列改回调用方给的 false。
//
// GORM 新建时会把零值字段换成标签里的默认值并回写到结构体（false 变 true），
// Select("*") 也绕不过，只能建完再改一次。want 为 true 时什么都不做。
func restoreFalse(tx *gorm.DB, model any, column string, want bool, field *bool) error {
	if want {
		return nil
	}
	if err := tx.Model(model).UpdateColumn(column, false).Error; err != nil {
		return err
	}
	*field = false
	return nil
}

func Open(cfg DBConfig) (*gorm.DB, error) {
	path := cfg.SQLitePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create sqlite dir: %w", err)
	}

	db, err := gorm.Open(sqliteDriver.Open(path), &gorm.Config{
		Logger: newGormLogger(),
	})
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get sql.DB: %w", err)
	}

	if err := db.Exec("PRAGMA journal_mode=WAL").Error; err != nil {
		return nil, fmt.Errorf("set sqlite journal mode: %w", err)
	}
	if err := db.Exec("PRAGMA busy_timeout=5000").Error; err != nil {
		return nil, fmt.Errorf("set sqlite busy timeout: %w", err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	return db, nil
}

// AutoMigrate 启动时自动同步表结构。
func AutoMigrate(db *gorm.DB) error {
	if err := dropDeletedAtColumns(db); err != nil {
		return err
	}
	if err := dropObsoleteRateSiteColumns(db); err != nil {
		return err
	}
	if err := dropRemovedFeatureTables(db); err != nil {
		return err
	}
	if err := dropRemovedFeatureColumns(db); err != nil {
		return err
	}
	if err := deleteRemovedNotificationChannels(db); err != nil {
		return err
	}
	if err := deleteRemovedCaptchaConfigs(db); err != nil {
		return err
	}
	if err := db.AutoMigrate(
		&Channel{},
		&AuthSession{},
		&CaptchaConfig{},
		&RateSnapshot{},
		&RateChangeLog{},
		&UpstreamAnnouncement{},
		&BalanceSnapshot{},
		&CostSnapshot{},
		&NotificationChannel{},
		&NotificationLog{},
		&NotificationCooldown{},
		&NotificationFailureState{},
		&LoginBackoffState{},
		&MonitorLog{},
		&CCHSyncConfig{},
		&AppliedMigration{},
	); err != nil {
		return err
	}
	if err := backfillChannelTodayCostAt(db); err != nil {
		return err
	}
	return runDataMigrations(db)
}

// backfillChannelTodayCostAt 给升级前写入的 today_cost 补上采集时间 today_cost_at。
//
// 旧版本只写 today_cost 不记时间。不能在读取时拿 last_balance_at 代替：余额单独刷新
// （兑换码充值、消费采集失败等）会把它更新到今天，已经过期的 today_cost 又会被当成今日数据。
// 所以在迁移时一次性回填：优先取该渠道最近一条消费快照的 sampled_at（与 today_cost
// 同一轮采集写入）；快照已被清理的，退回当时的 last_balance_at。两者都没有的保持 NULL，
// EffectiveTodayCost 原样返回。
//
// 只处理 today_cost_at IS NULL 的行，重复执行无副作用。
func backfillChannelTodayCostAt(db *gorm.DB) error {
	const pending = "today_cost_at IS NULL AND today_cost IS NOT NULL"
	if err := db.Exec("UPDATE channels SET today_cost_at = (" +
		"SELECT MAX(cost_snapshots.sampled_at) FROM cost_snapshots WHERE cost_snapshots.channel_id = channels.id" +
		") WHERE " + pending +
		" AND EXISTS (SELECT 1 FROM cost_snapshots WHERE cost_snapshots.channel_id = channels.id)").Error; err != nil {
		return fmt.Errorf("backfill channels.today_cost_at from cost_snapshots: %w", err)
	}
	if err := db.Exec("UPDATE channels SET today_cost_at = last_balance_at WHERE " + pending +
		" AND last_balance_at IS NOT NULL").Error; err != nil {
		return fmt.Errorf("backfill channels.today_cost_at from last_balance_at: %w", err)
	}
	return nil
}

func dropObsoleteRateSiteColumns(db *gorm.DB) error {
	targets := []struct {
		table string
		model any
	}{
		{table: "rate_snapshots", model: &RateSnapshot{}},
		{table: "rate_change_logs", model: &RateChangeLog{}},
	}
	for _, target := range targets {
		if !db.Migrator().HasTable(target.model) {
			continue
		}
		hasColumn, err := tableHasColumn(db, target.table, "site_id")
		if err != nil {
			return fmt.Errorf("inspect obsolete %s.site_id: %w", target.table, err)
		}
		if !hasColumn {
			continue
		}
		if err := db.Migrator().DropColumn(target.model, "site_id"); err != nil {
			return fmt.Errorf("drop obsolete %s.site_id: %w", target.table, err)
		}
		hasColumn, err = tableHasColumn(db, target.table, "site_id")
		if err != nil {
			return fmt.Errorf("inspect obsolete %s.site_id after drop: %w", target.table, err)
		}
		if hasColumn {
			if err := db.Exec("ALTER TABLE " + target.table + " DROP COLUMN site_id").Error; err != nil {
				return fmt.Errorf("drop obsolete %s.site_id via raw sql: %w", target.table, err)
			}
		}
	}
	return nil
}

// removedFeatureTables 是已移除的请求网关留下的表，启动时直接删除。
var removedFeatureTables = []string{
	"gateway_usage_logs",
	"gateway_routes",
	"gateway_keys",
	"gateway_groups",
	"gateway_providers",
	"model_price_overrides",
}

func dropRemovedFeatureTables(db *gorm.DB) error {
	for _, table := range removedFeatureTables {
		if !db.Migrator().HasTable(table) {
			continue
		}
		if err := db.Migrator().DropTable(table); err != nil {
			return fmt.Errorf("drop removed table %s: %w", table, err)
		}
	}
	return nil
}

// dropRemovedFeatureColumns 删除已移除功能（订阅管理、全局代理）留下的列。
func dropRemovedFeatureColumns(db *gorm.DB) error {
	targets := []struct {
		table  string
		column string
	}{
		{table: "channels", column: "subscription_enabled"},
		{table: "channels", column: "proxy_enabled"},
		{table: "captcha_configs", column: "proxy_enabled"},
		{table: "notification_channels", column: "proxy_enabled"},
	}
	for _, target := range targets {
		if !db.Migrator().HasTable(target.table) {
			continue
		}
		hasColumn, err := tableHasColumn(db, target.table, target.column)
		if err != nil {
			return fmt.Errorf("inspect removed %s.%s: %w", target.table, target.column, err)
		}
		if !hasColumn {
			continue
		}
		if err := db.Exec("ALTER TABLE " + target.table + " DROP COLUMN " + target.column).Error; err != nil {
			return fmt.Errorf("drop removed %s.%s: %w", target.table, target.column, err)
		}
	}
	return nil
}

// deleteRemovedNotificationChannels 删除已不再支持的通知渠道类型。
// 与手动删除通知渠道一致，发送记录保留，按保留天数自然清理。
func deleteRemovedNotificationChannels(db *gorm.DB) error {
	if !db.Migrator().HasTable(&NotificationChannel{}) {
		return nil
	}
	supported := []NotificationChannelType{NotifyTelegram, NotifyWecom}
	if err := db.Exec("DELETE FROM notification_channels WHERE type NOT IN ?", supported).Error; err != nil {
		return fmt.Errorf("delete removed notification channels: %w", err)
	}
	return nil
}

// deleteRemovedCaptchaConfigs 删除已不再支持的打码平台配置，引用它们的渠道改为不使用打码。
func deleteRemovedCaptchaConfigs(db *gorm.DB) error {
	if !db.Migrator().HasTable(&CaptchaConfig{}) {
		return nil
	}
	supported := []CaptchaProviderType{CaptchaYesCaptcha}
	if db.Migrator().HasTable(&Channel{}) {
		if err := db.Exec("UPDATE channels SET captcha_config_id = NULL WHERE captcha_config_id IN (SELECT id FROM captcha_configs WHERE type NOT IN ?)", supported).Error; err != nil {
			return fmt.Errorf("unbind removed captcha configs: %w", err)
		}
	}
	if err := db.Exec("DELETE FROM captcha_configs WHERE type NOT IN ?", supported).Error; err != nil {
		return fmt.Errorf("delete removed captcha configs: %w", err)
	}
	return nil
}

func dropDeletedAtColumns(db *gorm.DB) error {
	targets := []struct {
		table string
		model any
	}{
		{table: "channels", model: &Channel{}},
		{table: "captcha_configs", model: &CaptchaConfig{}},
		{table: "notification_channels", model: &NotificationChannel{}},
	}

	for _, target := range targets {
		if !db.Migrator().HasTable(target.model) {
			continue
		}
		hasColumn, err := tableHasColumn(db, target.table, "deleted_at")
		if err != nil {
			return fmt.Errorf("inspect %s.deleted_at: %w", target.table, err)
		}
		if !hasColumn {
			continue
		}
		if err := db.Exec("DELETE FROM " + target.table + " WHERE deleted_at IS NOT NULL").Error; err != nil {
			return fmt.Errorf("delete soft-deleted rows from %s: %w", target.table, err)
		}
		if db.Migrator().HasIndex(target.model, "idx_"+target.table+"_deleted_at") {
			if err := db.Migrator().DropIndex(target.model, "idx_"+target.table+"_deleted_at"); err != nil {
				return fmt.Errorf("drop %s deleted_at index: %w", target.table, err)
			}
		}
		if err := db.Migrator().DropColumn(target.model, "deleted_at"); err != nil {
			return fmt.Errorf("drop %s.deleted_at: %w", target.table, err)
		}
		hasColumn, err = tableHasColumn(db, target.table, "deleted_at")
		if err != nil {
			return fmt.Errorf("inspect %s.deleted_at after drop: %w", target.table, err)
		}
		if hasColumn {
			if err := db.Exec("ALTER TABLE " + target.table + " DROP COLUMN deleted_at").Error; err != nil {
				return fmt.Errorf("drop %s.deleted_at via raw sql: %w", target.table, err)
			}
		}
	}
	return nil
}

func tableHasColumn(db *gorm.DB, table, column string) (bool, error) {
	columns, err := db.Migrator().ColumnTypes(table)
	if err != nil {
		return false, err
	}
	for _, c := range columns {
		if strings.EqualFold(c.Name(), column) {
			return true, nil
		}
	}
	return false, nil
}
