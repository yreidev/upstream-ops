package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/cch"
	"github.com/yreidev/upstream-ops/backend/storage"
)

type cchSyncService interface {
	Settings() (*cch.SettingsView, error)
	SaveSettings(in cch.SettingsInput) (*cch.SettingsView, error)
	Preview(ctx context.Context) (*cch.Result, error)
	RunNow(ctx context.Context) (string, any, error)
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
	// 预览只读不写，中途断开没有副作用，仍按普通请求返回；立即同步会改 CCH，放到后台任务里跑。
	gs.POST("/run", func(c *gin.Context) {
		startJob(c, d, cch.JobSpec(storage.JobManual), d.CCHSync.RunNow)
	})
}

// cchSyncErrorStatus 没配置是请求问题，其余多为连不上 CCH 或 CCH 报错。
func cchSyncErrorStatus(err error) int {
	if errors.Is(err, cch.ErrNotConfigured) {
		return http.StatusBadRequest
	}
	return http.StatusBadGateway
}
