package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/cch"
)

type cchSyncService interface {
	Settings() (*cch.SettingsView, error)
	SaveSettings(in cch.SettingsInput) (*cch.SettingsView, error)
	Preview(ctx context.Context) (*cch.Result, error)
	RunNow(ctx context.Context) (*cch.Result, error)
}

func registerCCHSync(g *gin.RouterGroup, d *Deps) {
	gs := g.Group("/cch-sync")
	gs.GET("", func(c *gin.Context) {
		view, err := d.CCHSync.Settings()
		if err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": view})
	})
	gs.PUT("", func(c *gin.Context) {
		var in cch.SettingsInput
		if err := c.ShouldBindJSON(&in); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		view, err := d.CCHSync.SaveSettings(in)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": view})
	})
	gs.POST("/preview", func(c *gin.Context) {
		result, err := d.CCHSync.Preview(c.Request.Context())
		if err != nil {
			fail(c, cchSyncErrorStatus(err), err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": result})
	})
	gs.POST("/run", func(c *gin.Context) {
		result, err := d.CCHSync.RunNow(c.Request.Context())
		if err != nil {
			fail(c, cchSyncErrorStatus(err), err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": result})
	})
}

// cchSyncErrorStatus 没配置是请求问题，同步正在跑是冲突，其余多为连不上 CCH 或 CCH 报错。
func cchSyncErrorStatus(err error) int {
	switch {
	case errors.Is(err, cch.ErrNotConfigured):
		return http.StatusBadRequest
	case errors.Is(err, cch.ErrBusy):
		return http.StatusConflict
	default:
		return http.StatusBadGateway
	}
}
