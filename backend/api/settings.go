package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/config"
)

type settingsConfigView struct {
	App           config.AppConfig           `json:"app"`
	Auth          config.AuthConfig          `json:"auth"`
	Scheduler     config.SchedulerConfig     `json:"scheduler"`
	Notifications config.NotificationsConfig `json:"notifications"`
	Upstream      config.UpstreamConfig      `json:"upstream"`
}

type settingsConfigInput struct {
	App           config.AppConfig           `json:"app" binding:"required"`
	Auth          config.AuthConfig          `json:"auth" binding:"required"`
	Scheduler     config.SchedulerConfig     `json:"scheduler" binding:"required"`
	Notifications config.NotificationsConfig `json:"notifications" binding:"required"`
	Upstream      config.UpstreamConfig      `json:"upstream"`
}

func registerSettings(g *gin.RouterGroup, d *Deps) {
	gs := g.Group("/settings")
	gs.GET("/config", func(c *gin.Context) { getSettingsConfig(c, d) })
	gs.PUT("/config", func(c *gin.Context) { saveSettingsConfig(c, d) })
}

// settingsKeys 设置页能改的配置项路径。
var settingsKeys = func() []string {
	var out []string
	for _, key := range config.KeyPaths() {
		for _, prefix := range []string{"app.", "auth.", "scheduler.", "notifications.", "upstream."} {
			if strings.HasPrefix(key, prefix) {
				out = append(out, key)
				break
			}
		}
	}
	return out
}()

// getSettingsConfig 返回实际生效的配置（环境变量盖过配置文件，和启动、保存时一致），
// 并标出哪些项由环境变量决定，页面上锁住不让改。
func getSettingsConfig(c *gin.Context, d *Deps) {
	path := d.Runtime.ConfigPath()
	cfg, err := config.Load(path)
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	overrides := config.EnvOverrides(settingsKeys)
	// 环境变量里的密钥不回显到页面
	if overrides["auth.password"] != "" {
		cfg.Auth.Password = ""
	}
	if overrides["auth.tokenSecret"] != "" {
		cfg.Auth.TokenSecret = ""
	}
	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"config_path": path,
			"config": settingsConfigView{
				App:           cfg.App,
				Auth:          cfg.Auth,
				Scheduler:     cfg.Scheduler,
				Notifications: cfg.Notifications,
				Upstream:      cfg.Upstream.WithDefaults(),
			},
			"env_overrides": overrides,
		},
	})
}

// saveSettingsConfig 检查后写入配置文件并立即生效。由环境变量决定的项保留文件里原来的值，
// 不把环境变量（尤其是密码）抄进文件；生效时这些项仍以环境变量为准，和启动时一致。
func saveSettingsConfig(c *gin.Context, d *Deps) {
	var in settingsConfigInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}

	path := d.Runtime.ConfigPath()
	cfg, err := config.LoadFile(path)
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	withEnv, err := config.Load(path)
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	original := *cfg

	cfg.App.Title = in.App.Title
	cfg.App.NotificationPrefix = in.App.NotificationPrefix
	cfg.Auth = in.Auth
	cfg.Scheduler = in.Scheduler
	cfg.Notifications = in.Notifications
	cfg.Upstream = in.Upstream.WithDefaults()

	var locked []string
	for key := range config.EnvOverrides(settingsKeys) {
		locked = append(locked, key)
	}
	config.CopyKeys(cfg, &original, locked)
	effective := *cfg
	config.CopyKeys(&effective, withEnv, locked)

	if err := d.Runtime.Validate(&effective); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if err := config.Save(path, cfg); err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	if err := d.Runtime.Apply(&effective); err != nil {
		fail(c, http.StatusInternalServerError, fmt.Errorf("已写入配置文件，但没能生效：%w", err))
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"config_path": path,
			"message":     "已保存，立即生效",
		},
	})
}
