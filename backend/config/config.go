// Package config 定义应用配置结构体与默认值。
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
	"github.com/yreidev/upstream-ops/backend/storage"
	"go.yaml.in/yaml/v3"
)

type Config struct {
	App           AppConfig           `mapstructure:"app" yaml:"app" json:"app"`
	Server        ServerConfig        `mapstructure:"server" yaml:"server" json:"server"`
	Database      DatabaseConfig      `mapstructure:"database" yaml:"database" json:"database"`
	Security      SecurityConfig      `mapstructure:"security" yaml:"security" json:"security"`
	Auth          AuthConfig          `mapstructure:"auth" yaml:"auth" json:"auth"`
	Scheduler     SchedulerConfig     `mapstructure:"scheduler" yaml:"scheduler" json:"scheduler"`
	Notifications NotificationsConfig `mapstructure:"notifications" yaml:"notifications" json:"notifications"`
	Upstream      UpstreamConfig      `mapstructure:"upstream" yaml:"upstream" json:"upstream"`
	Degrade       DegradeConfig       `mapstructure:"degrade" yaml:"degrade" json:"degrade"`
	Log           LogConfig           `mapstructure:"log" yaml:"log" json:"log"`
}

type AppConfig struct {
	Title              string `mapstructure:"title" yaml:"title" json:"title"`
	NotificationPrefix string `mapstructure:"notificationPrefix" yaml:"notificationPrefix" json:"notificationPrefix"`
}

type ServerConfig struct {
	Port           int      `mapstructure:"port" yaml:"port" json:"port"`
	Mode           string   `mapstructure:"mode" yaml:"mode" json:"mode"`
	TrustedProxies []string `mapstructure:"trustedProxies" yaml:"trustedProxies" json:"trustedProxies"`
	BaseURL        string   `mapstructure:"baseURL" yaml:"baseURL" json:"baseURL"`
}

// DatabaseConfig SQLite 数据库配置。
type DatabaseConfig struct {
	Path string `mapstructure:"path" yaml:"path" json:"path"`
}

func (d DatabaseConfig) ToStorageConfig() storage.DBConfig {
	return storage.DBConfig{Path: d.Path}
}

type SecurityConfig struct {
	// AppSecret 主密钥，用于 AES-GCM。优先从 APP_SECRET 环境变量读取。
	AppSecret string `mapstructure:"appSecret" yaml:"appSecret" json:"appSecret"`
}

// AuthConfig 后台单用户登录配置。
//
// Enabled = false（默认）时整套鉴权被关掉：/api/* 全部免 token，前端检测后跳过登录页。
// 适合纯内网 / 反代后面的部署。需要公网暴露时必须显式 Enabled=true 并设强密码。
//
// Enabled=true 时 Username/Password 是写死的管理员凭据，TokenSecret 用于签发 HMAC token。
// 如果 TokenSecret 为空，会回退使用 Security.AppSecret，保证有合理默认。
type AuthConfig struct {
	Enabled         bool   `mapstructure:"enabled" yaml:"enabled" json:"enabled"`
	Username        string `mapstructure:"username" yaml:"username" json:"username"`
	Password        string `mapstructure:"password" yaml:"password" json:"password"`
	TokenSecret     string `mapstructure:"tokenSecret" yaml:"tokenSecret" json:"tokenSecret"`
	SessionTTLHours int    `mapstructure:"sessionTTLHours" yaml:"sessionTTLHours" json:"sessionTTLHours"`
}

type SchedulerConfig struct {
	BalanceCron string `mapstructure:"balanceCron" yaml:"balanceCron" json:"balanceCron"`
	RateCron    string `mapstructure:"rateCron" yaml:"rateCron" json:"rateCron"`
	// DegradeCron GPT 降智检测的巡检周期，留空不巡检。
	DegradeCron string          `mapstructure:"degradeCron" yaml:"degradeCron" json:"degradeCron"`
	Retention   RetentionConfig `mapstructure:"retention" yaml:"retention" json:"retention"`
}

// RetentionConfig 历史数据保留策略。
//
// 字段为 0 表示该表不清理，永久保留（默认 rate_change_logs 永远保留，是核心业务数据）。
// Cron 为空时不启动清理任务。
type RetentionConfig struct {
	Cron                 string `mapstructure:"cron" yaml:"cron" json:"cron"`
	MonitorLogsDays      int    `mapstructure:"monitorLogsDays" yaml:"monitorLogsDays" json:"monitorLogsDays"`
	BalanceSnapshotsDays int    `mapstructure:"balanceSnapshotsDays" yaml:"balanceSnapshotsDays" json:"balanceSnapshotsDays"`
	NotificationLogsDays int    `mapstructure:"notificationLogsDays" yaml:"notificationLogsDays" json:"notificationLogsDays"`
	AnnouncementsDays    int    `mapstructure:"announcementsDays" yaml:"announcementsDays" json:"announcementsDays"`
}

// NotificationsConfig 通知去抖策略。所有字段都是"少烦我"取向，默认不丢消息只合并。
//
//   - MinChangePct：涨跌幅 < X% 的 rate_changed 跳过推送（仍会写入 rate_change_logs）。
//     0 = 全发，对应原始行为。
//   - BalanceLowCooldownMinutes：同一渠道的 balance_low 在 X 分钟内不重复推送。
//     0 = 不冷却（每次扫描发现仍 < 阈值都发）。冷却状态持久化在数据库的
//     notification_cooldowns 表，跨重启生效。
//   - SendMaxAttempts：单条通知发送失败时最多尝试次数（含首次）。
//     1 = 不重试。重试采用指数退避：1s / 2s / 4s …，上限 30s。
type NotificationsConfig struct {
	MinChangePct              float64 `mapstructure:"minChangePct" yaml:"minChangePct" json:"minChangePct"`
	BalanceLowCooldownMinutes int     `mapstructure:"balanceLowCooldownMinutes" yaml:"balanceLowCooldownMinutes" json:"balanceLowCooldownMinutes"`
	SendMaxAttempts           int     `mapstructure:"sendMaxAttempts" yaml:"sendMaxAttempts" json:"sendMaxAttempts"`
}

const (
	DefaultUpstreamTimeoutSeconds = 30
	DefaultUpstreamUserAgent      = "upstream-ops/0.1"
)

type UpstreamConfig struct {
	TimeoutSeconds int    `mapstructure:"timeoutSeconds" yaml:"timeoutSeconds" json:"timeoutSeconds"`
	UserAgent      string `mapstructure:"userAgent" yaml:"userAgent" json:"userAgent"`
}

func (u UpstreamConfig) WithDefaults() UpstreamConfig {
	if u.TimeoutSeconds <= 0 {
		u.TimeoutSeconds = DefaultUpstreamTimeoutSeconds
	}
	if strings.TrimSpace(u.UserAgent) == "" {
		u.UserAgent = DefaultUpstreamUserAgent
	}
	return u
}

const (
	DefaultDegradeModel  = "gpt-6.1-sol"
	DefaultDegradeEffort = "low"
)

// DegradeEfforts 降智检测可选的推理强度，和 Codex 客户端的选项一致；none 表示不指定、由上游决定。
var DegradeEfforts = []string{"none", "low", "medium", "high", "xhigh", "max"}

// DegradeConfig GPT 降智检测默认用的模型和推理强度，单把密钥可以另设。
// Effort 为 "none" 时不指定推理强度，由上游决定。
type DegradeConfig struct {
	Model  string `mapstructure:"model" yaml:"model" json:"model"`
	Effort string `mapstructure:"effort" yaml:"effort" json:"effort"`
}

func (d DegradeConfig) WithDefaults() DegradeConfig {
	d.Model = strings.TrimSpace(d.Model)
	if d.Model == "" {
		d.Model = DefaultDegradeModel
	}
	d.Effort = strings.TrimSpace(d.Effort)
	if d.Effort == "" {
		d.Effort = DefaultDegradeEffort
	}
	return d
}

type LogConfig struct {
	Level  string `mapstructure:"level" yaml:"level" json:"level"`
	Format string `mapstructure:"format" yaml:"format" json:"format"`
}

// Load 读取 config.yaml（可选）+ APP_SECRET / * 环境变量覆盖。
//
// 关键映射：
//
//	APP_SECRET                       -> security.appSecret
//	DATABASE_PATH        -> database.path
//	SERVER_PORT          -> server.port
//	SCHEDULER_BALANCECRON-> scheduler.balanceCron
func Load(path string) (*Config, error) {
	cfg, _, err := load(path, true)
	return cfg, err
}

func LoadWithPath(path string) (*Config, string, error) {
	return load(path, true)
}

func LoadFile(path string) (*Config, error) {
	cfg, _, err := load(path, false)
	return cfg, err
}

func load(path string, withEnv bool) (*Config, string, error) {
	v := viper.New()
	v.SetConfigType("yaml")

	if path != "" {
		v.SetConfigFile(path)
	} else {
		v.SetConfigName("config")
		for _, p := range configSearchPaths() {
			v.AddConfigPath(p)
		}
		v.AddConfigPath("/etc/upstream-ops")
	}

	setDefaults(v)

	if withEnv {
		v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
		v.AutomaticEnv()
		// Viper 坑：AutomaticEnv 只对已通过 SetDefault / BindEnv / 配置文件注册过的 key 生效，
		// 因此显式 BindEnv 以确保从环境变量读取。
		for key, name := range envBindings {
			_ = v.BindEnv(key, name)
		}
	}

	if err := v.ReadInConfig(); err != nil {
		if path != "" {
			if !os.IsNotExist(err) {
				return nil, "", fmt.Errorf("read config: %w", err)
			}
		} else {
			if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
				return nil, "", fmt.Errorf("read config: %w", err)
			}
		}
	}

	cfg := &Config{}
	if err := v.Unmarshal(cfg); err != nil {
		return nil, "", fmt.Errorf("unmarshal config: %w", err)
	}
	cfg.Upstream = cfg.Upstream.WithDefaults()
	cfg.Degrade = cfg.Degrade.WithDefaults()
	return cfg, v.ConfigFileUsed(), nil
}

func Save(path string, cfg *Config) error {
	if path == "" {
		return fmt.Errorf("config path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir config dir: %w", err)
	}
	body, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

func ResolvePath(requested, used string) string {
	if requested != "" {
		return requested
	}
	if used != "" {
		return used
	}
	for _, candidate := range configSearchPaths() {
		candidate = filepath.Join(candidate, "config.yaml")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	if wd, err := os.Getwd(); err == nil && filepath.Base(wd) == "backend" {
		return "../config.yaml"
	}
	return "config.yaml"
}

func configSearchPaths() []string {
	if wd, err := os.Getwd(); err == nil && filepath.Base(wd) == "backend" {
		return []string{"..", "."}
	}
	return []string{"."}
}

func setDefaults(v *viper.Viper) {
	v.SetDefault("app.title", "UpstreamOps")
	v.SetDefault("app.notificationPrefix", "[AI 聚合监控] ")

	v.SetDefault("server.port", 8418)
	v.SetDefault("server.mode", "debug")
	v.SetDefault("server.baseURL", "http://localhost:8418")

	v.SetDefault("database.path", "./data/upstream-ops.db")

	// CLAUDE.md 默认建议：余额 15 分钟，倍率 30 分钟。
	v.SetDefault("scheduler.balanceCron", "37 */15 * * * *")
	v.SetDefault("scheduler.rateCron", "13 */30 * * * *")
	// 降智检测每次都要花钱，默认不巡检；登记空默认值，SCHEDULER_DEGRADECRON 才能生效
	v.SetDefault("scheduler.degradeCron", "")

	// 历史清理：每天凌晨 3:17 跑一次（6 字段 cron 含秒），
	// monitor 30 天 / balance 90 天 / notify 90 天。rate_change_logs 不清理（业务核心数据）。
	v.SetDefault("scheduler.retention.cron", "0 17 3 * * *")
	v.SetDefault("scheduler.retention.monitorLogsDays", 30)
	v.SetDefault("scheduler.retention.balanceSnapshotsDays", 90)
	v.SetDefault("scheduler.retention.notificationLogsDays", 90)
	v.SetDefault("scheduler.retention.announcementsDays", 90)

	v.SetDefault("auth.enabled", false)
	v.SetDefault("auth.username", "admin")
	v.SetDefault("auth.sessionTTLHours", 168) // 7 天

	// 通知去抖：不过滤涨跌幅、balance_low 1h 内不重复、失败重试 3 次。
	// 全渠道倍率变化始终在一次扫描结束后合并发送。
	v.SetDefault("notifications.minChangePct", 0)
	v.SetDefault("notifications.balanceLowCooldownMinutes", 60)
	v.SetDefault("notifications.sendMaxAttempts", 3)

	v.SetDefault("upstream.timeoutSeconds", DefaultUpstreamTimeoutSeconds)
	v.SetDefault("upstream.userAgent", DefaultUpstreamUserAgent)

	v.SetDefault("degrade.model", DefaultDegradeModel)
	v.SetDefault("degrade.effort", DefaultDegradeEffort)

	v.SetDefault("log.level", "info")
	v.SetDefault("log.format", "text")
}
