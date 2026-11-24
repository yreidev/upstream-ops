package scheduler

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/jobs"
	"github.com/yreidev/upstream-ops/backend/monitor"
	"github.com/yreidev/upstream-ops/backend/storage"
	"gorm.io/gorm"
)

func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := storage.Open(storage.DBConfig{
		Path: filepath.Join(t.TempDir(), "scheduler-test.db"),
	})
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	if err := storage.AutoMigrate(db); err != nil {
		t.Fatalf("auto migrate: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("db handle: %v", err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	return db
}

func TestRunRetentionDeletesAnnouncements(t *testing.T) {
	db := openTestDB(t)
	announcements := storage.NewUpstreamAnnouncements(db)
	notifies := storage.NewNotifications(db)
	monLogs := storage.NewMonitorLogs(db)
	rates := storage.NewRates(db)

	oldTime := time.Now().AddDate(0, 0, -10)
	if _, err := announcements.Sync(1, []storage.UpstreamAnnouncement{{
		ChannelID:   1,
		SourceKey:   "old",
		Content:     "old",
		FirstSeenAt: oldTime,
	}}); err != nil {
		t.Fatalf("sync announcement: %v", err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	jobRepo := storage.NewBackgroundJobs(db)
	s := New(
		config.SchedulerConfig{
			Retention: config.RetentionConfig{
				AnnouncementsDays: 1,
				MonitorLogsDays:   7,
			},
		},
		&monitor.Service{},
		monLogs,
		rates,
		notifies,
		announcements,
		nil,
		nil,
		log,
	).WithJobs(jobs.NewRunner(jobRepo, log))

	s.runRetention()

	list, total, err := announcements.ListPage(1, 10)
	if err != nil {
		t.Fatalf("list announcements: %v", err)
	}
	if total != 0 || len(list) != 0 {
		t.Fatalf("announcements not cleaned: total=%d list=%#v", total, list)
	}

	// 每轮定时任务记一条后台任务
	recorded, n, err := jobRepo.List(storage.JobFilter{Kind: storage.JobRetention}, 1, 10)
	if err != nil || n != 1 {
		t.Fatalf("retention jobs = %d, %v", n, err)
	}
	if got := recorded[0]; got.Source != storage.JobScheduled || got.Status != storage.JobSucceeded || got.Message != "删除了上游公告 1 条" {
		t.Fatalf("retention job = %+v", got)
	}
}

func TestNextRuns(t *testing.T) {
	from := time.Date(2026, 10, 13, 21, 7, 30, 0, time.UTC)
	runs, err := NextRuns("0 5-59/15 * * * *", from, 3)
	if err != nil {
		t.Fatalf("next runs: %v", err)
	}
	want := []string{"21:20", "21:35", "21:50"}
	for i, r := range runs {
		if r.Format("15:04") != want[i] || r.Second() != 0 {
			t.Fatalf("runs = %v, want %v", runs, want)
		}
	}
	if len(runs) != 3 {
		t.Fatalf("runs = %v", runs)
	}
	// 2 月 30 日永远不会到
	if runs, err := NextRuns("0 0 0 30 2 *", from, 3); err != nil || len(runs) != 0 {
		t.Fatalf("never: %v, %v", runs, err)
	}
	if _, err := NextRuns("0 0 * * *", from, 3); err == nil {
		t.Fatal("5-field spec must be rejected")
	}
}
