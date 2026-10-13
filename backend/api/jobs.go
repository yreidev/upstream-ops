package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/jobs"
	"github.com/yreidev/upstream-ops/backend/storage"
	"gorm.io/gorm"
)

// jobStarter 在后台建任务并立即返回，生产实现是 *jobs.Runner。
type jobStarter interface {
	Start(spec jobs.Spec, fn jobs.Func) (*storage.BackgroundJob, bool, error)
}

// jobView 是接口返回的任务：进度事件和结果按 JSON 原样带出。
type jobView struct {
	storage.BackgroundJob
	Events json.RawMessage `json:"events,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

func newJobView(j *storage.BackgroundJob) jobView {
	v := jobView{BackgroundJob: *j}
	if j.Events != "" {
		v.Events = json.RawMessage(j.Events)
	}
	if j.Result != "" {
		v.Result = json.RawMessage(j.Result)
	}
	return v
}

// startJob 建任务并返回 {job, started}。同一对象已有任务在跑时返回那个任务，started 为 false，状态码 200；
// 新建的返回 202。任务在后台跑，和这次请求无关，关页面不影响。
func startJob(c *gin.Context, d *Deps, spec jobs.Spec, fn jobs.Func) {
	job, started, err := d.Jobs.Start(spec, fn)
	if err != nil {
		fail(c, http.StatusServiceUnavailable, err)
		return
	}
	status := http.StatusAccepted
	if !started {
		status = http.StatusOK
	}
	c.JSON(status, gin.H{"data": gin.H{"job": newJobView(job), "started": started}})
}

func registerJobs(g *gin.RouterGroup, d *Deps) {
	gj := g.Group("/jobs")
	gj.GET("", func(c *gin.Context) { listJobs(c, d) })
	gj.GET("/running", func(c *gin.Context) {
		list, err := d.JobRepo.ListRunning()
		if err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		views := make([]jobView, 0, len(list))
		for i := range list {
			views = append(views, newJobView(&list[i]))
		}
		c.JSON(http.StatusOK, gin.H{"data": views})
	})
	gj.GET("/:id", func(c *gin.Context) {
		id, err := uintParam(c, "id")
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		job, err := d.JobRepo.Get(id)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			fail(c, http.StatusNotFound, errors.New("任务不存在，可能已被清理"))
			return
		}
		if err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": newJobView(job)})
	})
}

var (
	jobKinds = map[storage.JobKind]bool{
		storage.JobChannelSync: true, storage.JobChannelTestLogin: true, storage.JobChannelSyncAll: true,
		storage.JobBalanceScan: true, storage.JobRateScan: true, storage.JobCCHSync: true, storage.JobRetention: true,
		storage.JobDegradeCheck: true, storage.JobDegradeCheckAll: true,
	}
	jobSources  = map[storage.JobSource]bool{storage.JobManual: true, storage.JobScheduled: true}
	jobStatuses = map[storage.JobStatus]bool{
		storage.JobRunning: true, storage.JobSucceeded: true, storage.JobFailed: true, storage.JobInterrupted: true,
	}
)

// listJobs 分页列出任务，可按 kind / source / status 筛选，不带进度事件和结果。
func listJobs(c *gin.Context, d *Deps) {
	page, pageSize, err := parsePageQuery(c)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	f := storage.JobFilter{
		Kind:   storage.JobKind(c.Query("kind")),
		Source: storage.JobSource(c.Query("source")),
		Status: storage.JobStatus(c.Query("status")),
	}
	if (f.Kind != "" && !jobKinds[f.Kind]) || (f.Source != "" && !jobSources[f.Source]) || (f.Status != "" && !jobStatuses[f.Status]) {
		fail(c, http.StatusBadRequest, errors.New("kind / source / status 取值不对"))
		return
	}
	list, total, err := d.JobRepo.List(f, page, pageSize)
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	pages := 1
	if total > 0 {
		pages = int((total + int64(pageSize) - 1) / int64(pageSize))
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"items":     list,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
		"pages":     pages,
	}})
}
