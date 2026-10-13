package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/degrade"
	"github.com/yreidev/upstream-ops/backend/jobs"
	"github.com/yreidev/upstream-ops/backend/storage"
	"gorm.io/gorm"
)

type degradeService interface {
	Defaults() config.DegradeConfig
	List() ([]degrade.KeyView, error)
	Candidates(ctx context.Context, channelID uint) ([]degrade.Candidate, error)
	Add(ctx context.Context, in degrade.AddInput) (*storage.DegradeKey, error)
	ReplaceKey(ctx context.Context, id uint, pasted string) (*storage.DegradeKey, error)
	UpdateModel(id uint, model, effort string) (*storage.DegradeKey, error)
	Remove(id uint) error
	Checks(id uint, limit int) ([]storage.DegradeCheck, error)
	Models(ctx context.Context, id uint) ([]string, error)
	CheckJob(id uint) (jobs.Spec, jobs.Func, error)
	CheckAll(ctx context.Context) (string, any, error)
}

// registerDegrade 注册 GPT 降智检测的接口。检测都在后台任务里跑；加入密钥、列模型这类一次请求就完的操作直接返回。
func registerDegrade(g *gin.RouterGroup, d *Deps) {
	gd := g.Group("/degrade")
	gd.GET("/keys", func(c *gin.Context) { listDegradeKeys(c, d) })
	gd.POST("/keys", func(c *gin.Context) {
		var in degrade.AddInput
		if err := c.ShouldBindJSON(&in); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		k, err := d.Degrade.Add(c.Request.Context(), in)
		if err != nil {
			failDegradeKey(c, err)
			return
		}
		c.JSON(http.StatusCreated, gin.H{"data": k})
	})
	gd.GET("/candidates", func(c *gin.Context) {
		channelID, err := strconv.ParseUint(c.Query("channel_id"), 10, 64)
		if err != nil || channelID == 0 {
			fail(c, http.StatusBadRequest, errors.New("channel_id 必须是正整数"))
			return
		}
		list, err := d.Degrade.Candidates(c.Request.Context(), uint(channelID))
		if err != nil {
			fail(c, http.StatusBadGateway, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": list})
	})
	gd.POST("/check-all", func(c *gin.Context) {
		startJob(c, d, degrade.CheckAllJobSpec(storage.JobManual), d.Degrade.CheckAll)
	})

	gk := gd.Group("/keys/:id")
	gk.PATCH("", func(c *gin.Context) {
		id, ok := degradeKeyID(c)
		if !ok {
			return
		}
		var in struct {
			Model  string `json:"model"`
			Effort string `json:"effort"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		k, err := d.Degrade.UpdateModel(id, in.Model, in.Effort)
		if err != nil {
			failDegradeKey(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": k})
	})
	gk.PUT("/key", func(c *gin.Context) {
		id, ok := degradeKeyID(c)
		if !ok {
			return
		}
		var in struct {
			Key string `json:"key"`
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		k, err := d.Degrade.ReplaceKey(c.Request.Context(), id, in.Key)
		if err != nil {
			failDegradeKey(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": k})
	})
	gk.DELETE("", func(c *gin.Context) {
		id, ok := degradeKeyID(c)
		if !ok {
			return
		}
		if err := d.Degrade.Remove(id); err != nil {
			failDegradeKey(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	gk.GET("/checks", func(c *gin.Context) {
		id, ok := degradeKeyID(c)
		if !ok {
			return
		}
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
		list, err := d.Degrade.Checks(id, limit)
		if err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": list})
	})
	gk.GET("/models", func(c *gin.Context) {
		id, ok := degradeKeyID(c)
		if !ok {
			return
		}
		list, err := d.Degrade.Models(c.Request.Context(), id)
		if err != nil {
			failDegradeKey(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": list})
	})
	gk.POST("/check", func(c *gin.Context) {
		id, ok := degradeKeyID(c)
		if !ok {
			return
		}
		spec, fn, err := d.Degrade.CheckJob(id)
		if err != nil {
			failDegradeKey(c, err)
			return
		}
		startJob(c, d, spec, fn)
	})
}

// listDegradeKeys 返回参与检测的密钥，以及页面要显示的默认模型和巡检 Cron。
func listDegradeKeys(c *gin.Context, d *Deps) {
	list, err := d.Degrade.List()
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	cron := ""
	if d.Runtime != nil {
		if cfg, err := config.Load(d.Runtime.ConfigPath()); err == nil {
			cron = cfg.Scheduler.DegradeCron
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"items":    list,
		"defaults": d.Degrade.Defaults(),
		"cron":     cron,
	}})
}

func degradeKeyID(c *gin.Context) (uint, bool) {
	id, err := uintParam(c, "id")
	if err != nil || id == 0 {
		fail(c, http.StatusBadRequest, errors.New("密钥 ID 无效"))
		return 0, false
	}
	return id, true
}

// failDegradeKey 按错误类型给状态码：站点不让取完整密钥时带 code，页面据此让用户粘贴。
func failDegradeKey(c *gin.Context, err error) {
	var reveal *degrade.RevealError
	switch {
	case errors.As(err, &reveal):
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": err.Error(), "code": "reveal_failed"})
	case errors.Is(err, gorm.ErrRecordNotFound):
		fail(c, http.StatusNotFound, errors.New("这把密钥已不在检测列表里"))
	case errors.Is(err, degrade.ErrBusy):
		fail(c, http.StatusConflict, err)
	default:
		fail(c, http.StatusBadRequest, err)
	}
}
