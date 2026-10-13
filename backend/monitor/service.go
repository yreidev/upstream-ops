// Package monitor 周期性扫描渠道，采集余额 / 倍率并写入快照、变化日志和通知。
package monitor

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/yreidev/upstream-ops/backend/channel"
	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/notify"
	"github.com/yreidev/upstream-ops/backend/progress"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// Service 监控扫描服务。
type Service struct {
	channels      *storage.Channels
	announcements *storage.UpstreamAnnouncements
	rates         *storage.Rates
	monitorLogs   *storage.MonitorLogs
	channelSvc    *channel.Service
	dispatcher    *notify.Dispatcher
	log           *slog.Logger
}

func NewService(
	channels *storage.Channels,
	announcements *storage.UpstreamAnnouncements,
	rates *storage.Rates,
	monitorLogs *storage.MonitorLogs,
	channelSvc *channel.Service,
	dispatcher *notify.Dispatcher,
	log *slog.Logger,
) *Service {
	return &Service{
		channels:      channels,
		announcements: announcements,
		rates:         rates,
		monitorLogs:   monitorLogs,
		channelSvc:    channelSvc,
		dispatcher:    dispatcher,
		log:           log,
	}
}

// ScanAllBalances 扫描所有启用监控的渠道余额。单个失败不影响其他。
// 定时任务调用，受登录退避限制（见 channel.WithScheduled）。
func (s *Service) ScanAllBalances(ctx context.Context) {
	ctx = channel.WithScheduled(ctx)
	list, err := s.channels.ListMonitorEnabled()
	if err != nil {
		s.log.Error("list channels", "err", err)
		return
	}
	for i := range list {
		c := list[i]
		if err := s.RefreshBalance(ctx, &c); err != nil {
			s.logScanError("refresh balance failed", c.Name, err)
		}
	}
}

func (s *Service) logScanError(msg, channelName string, err error) {
	if channel.IsBackoff(err) {
		s.log.Debug(msg, "channel", channelName, "err", err)
		return
	}
	s.log.Warn(msg, "channel", channelName, "err", err)
}

// ScanAllRates 扫描所有启用监控的渠道倍率。定时任务调用，受登录退避限制。
func (s *Service) ScanAllRates(ctx context.Context) {
	ctx = channel.WithScheduled(ctx)
	list, err := s.channels.ListMonitorEnabled()
	if err != nil {
		s.log.Error("list channels", "err", err)
		return
	}
	batch := notify.RateNotificationBatch{}
	for i := range list {
		c := list[i]
		if err := s.refreshRates(ctx, &c, &batch); err != nil {
			s.logScanError("refresh rates failed", c.Name, err)
		}
	}
	if !batch.Empty() {
		_ = s.dispatcher.DispatchRateNotificationBatch(ctx, batch)
	}
}

// RefreshBalance 单个渠道余额刷新，可被 API 手动触发。
func (s *Service) RefreshBalance(ctx context.Context, c *storage.Channel) error {
	resolved, conn, session, err := s.prepare(ctx, c)
	if err != nil {
		return err
	}

	progress.Start(ctx, progress.StageBalance, "拉取余额…")
	started := time.Now()
	res, err := conn.GetBalance(ctx, resolved, session)
	s.appendMonitorLog(ctx, c.ID, storage.MonitorJobBalance, started, err)
	if err != nil {
		progress.Fail(ctx, progress.StageBalance, err.Error())
		s.reportFailure(ctx, c, notify.FailureBalance, err)
		return err
	}
	s.reportSuccess(ctx, c, notify.FailureBalance)

	sampledAt := res.SampledAt
	if sampledAt.IsZero() {
		sampledAt = time.Now()
	}
	if err := s.channels.UpdateBalance(c.ID, res.Balance, &sampledAt, ""); err != nil {
		return err
	}
	_ = s.rates.AppendBalance(&storage.BalanceSnapshot{
		ChannelID: c.ID,
		Balance:   res.Balance,
		SampledAt: sampledAt,
	})
	progress.OK(ctx, progress.StageBalance, fmt.Sprintf("当前余额 %.4f", res.Balance),
		map[string]any{"balance": res.Balance})

	// 余额阈值检查放在消费采集之前：消费接口出错不能连带吞掉低余额提醒。
	if c.BalanceThreshold > 0 && res.Balance < c.BalanceThreshold {
		body := fmt.Sprintf("当前余额: %.4f，阈值: %.4f", res.Balance, c.BalanceThreshold)
		_ = s.dispatcher.Dispatch(ctx, notify.Message{
			Event:     storage.EventBalanceLow,
			ChannelID: c.ID,
			Subject:   fmt.Sprintf("%s 余额低于阈值", c.Name),
			Body:      body,
		})
	}

	progress.Start(ctx, progress.StageCost, "拉取消费…")
	started = time.Now()
	costRes, err := conn.GetCosts(ctx, resolved, session)
	s.appendMonitorLog(ctx, c.ID, storage.MonitorJobCosts, started, err)
	if err != nil {
		progress.Fail(ctx, progress.StageCost, err.Error())
		s.reportFailure(ctx, c, notify.FailureCosts, err)
		return err
	}
	s.reportSuccess(ctx, c, notify.FailureCosts)
	costAt := time.Now()
	if err := s.channels.UpdateCosts(c.ID, costRes.TodayCost, costRes.TotalCost, costAt); err != nil {
		progress.Fail(ctx, progress.StageCost, err.Error())
		return err
	}
	_ = s.rates.AppendCost(&storage.CostSnapshot{
		ChannelID: c.ID,
		TodayCost: costRes.TodayCost,
		SampledAt: sampledAt,
	})
	progress.OK(ctx, progress.StageCost, fmt.Sprintf("今日 %0.4f / 累计 %0.4f", costRes.TodayCost, costRes.TotalCost),
		map[string]any{"today_cost": costRes.TodayCost, "total_cost": costRes.TotalCost})
	return nil
}

// RefreshRates 单个渠道倍率刷新，可被 API 手动触发。
func (s *Service) RefreshRates(ctx context.Context, c *storage.Channel) error {
	batch := notify.RateNotificationBatch{}
	if err := s.refreshRates(ctx, c, &batch); err != nil {
		return err
	}
	if !batch.Empty() {
		_ = s.dispatcher.DispatchRateNotificationBatch(ctx, batch)
	}
	return nil
}

func (s *Service) refreshRates(ctx context.Context, c *storage.Channel, batch *notify.RateNotificationBatch) error {
	resolved, conn, session, err := s.prepare(ctx, c)
	if err != nil {
		return err
	}

	progress.Start(ctx, progress.StageRates, "拉取分组倍率…")
	started := time.Now()
	results, err := conn.GetRates(ctx, resolved, session)
	s.appendMonitorLog(ctx, c.ID, storage.MonitorJobRates, started, err)
	if err != nil {
		progress.Fail(ctx, progress.StageRates, err.Error())
		s.reportFailure(ctx, c, notify.FailureRates, err)
		return err
	}
	s.reportSuccess(ctx, c, notify.FailureRates)

	now := time.Now()
	existing, err := s.rates.ListByChannel(c.ID)
	if err != nil {
		return err
	}
	isFirstSync := len(existing) == 0
	existingByName := make(map[string]storage.RateSnapshot, len(existing))
	for _, snapshot := range existing {
		existingByName[snapshot.ModelName] = snapshot
	}

	// "仅显示已创建密钥的分组"开关：开关开启时只派发"已挂密钥的分组"的 added/removed/changes
	// 通知；RateSnapshot 本地存储仍按全量维护，确保通知设置等可继续读全分组。
	// 拉 set 失败时不做过滤（保险：避免上游密钥接口抖动导致通知被全静音），仅日志告警。
	var keyGroupSet *channel.APIKeyGroupSet
	if c.OnlyCreatedKeyGroupsEnabled {
		set, setErr := s.channelSvc.ListAPIKeyGroupSet(ctx, c.ID)
		if setErr != nil {
			s.log.Warn("list api key group set failed; skip dispatch filtering",
				"channel", c.Name, "err", setErr)
		} else if set.Empty() {
			// 渠道没有密钥 → 任何 added / changes / removed 都不应通知。
			keyGroupSet = &channel.APIKeyGroupSet{}
		} else {
			keyGroupSet = set
		}
	}
	resultInSet := func(r connector.RateResult) bool {
		if keyGroupSet == nil {
			return true
		}
		if r.GroupID != nil {
			return keyGroupSet.ContainsGroupID(r.GroupID)
		}
		return keyGroupSet.ContainsGroupName(r.ModelName)
	}
	snapInSet := func(snap storage.RateSnapshot) bool {
		if keyGroupSet == nil {
			return true
		}
		return keyGroupSet.ContainsSnapshot(snap)
	}

	seen := make(map[string]struct{}, len(results))
	changes := make([]notify.RateChange, 0, len(results))
	added := make([]notify.RateChange, 0)
	for _, r := range results {
		seen[r.ModelName] = struct{}{}
		prev, err := s.rates.Upsert(&storage.RateSnapshot{
			ChannelID:       c.ID,
			RemoteGroupID:   r.GroupID,
			ModelName:       r.ModelName,
			Description:     r.Description,
			Ratio:           r.Ratio,
			CompletionRatio: r.CompletionRatio,
			LastSeenAt:      now,
		})
		if err != nil {
			s.log.Warn("rate upsert failed", "channel", c.Name, "model", r.ModelName, "err", err)
			continue
		}
		if prev == nil {
			if !isFirstSync && resultInSet(r) {
				added = append(added, notify.RateChange{
					GroupName: r.ModelName,
					NewRatio:  r.Ratio,
					NewComp:   r.CompletionRatio,
					ChangedAt: now,
				})
			}
			continue
		}
		if prev.Ratio == r.Ratio && prev.CompletionRatio == r.CompletionRatio {
			continue
		}
		oldRatio := prev.Ratio
		oldComp := prev.CompletionRatio
		_ = s.rates.AppendChange(&storage.RateChangeLog{
			ChannelID:          c.ID,
			ModelName:          r.ModelName,
			OldRatio:           &oldRatio,
			NewRatio:           r.Ratio,
			OldCompletionRatio: &oldComp,
			NewCompletionRatio: r.CompletionRatio,
			ChangedAt:          now,
		})
		if resultInSet(r) {
			changes = append(changes, notify.RateChange{
				GroupName: r.ModelName,
				OldRatio:  oldRatio,
				NewRatio:  r.Ratio,
				OldComp:   oldComp,
				NewComp:   r.CompletionRatio,
				ChangedAt: now,
			})
		}
	}
	removed := make([]notify.RateChange, 0)
	for _, snapshot := range existingByName {
		if _, ok := seen[snapshot.ModelName]; ok {
			continue
		}
		if err := s.rates.DeleteSnapshot(c.ID, snapshot.ModelName); err != nil {
			s.log.Warn("rate delete failed", "channel", c.Name, "model", snapshot.ModelName, "err", err)
			continue
		}
		if snapInSet(snapshot) {
			removed = append(removed, notify.RateChange{
				GroupName: snapshot.ModelName,
				OldRatio:  snapshot.Ratio,
				OldComp:   snapshot.CompletionRatio,
				ChangedAt: now,
			})
		}
	}
	for _, change := range changes {
		batch.Changed = append(batch.Changed, notify.ChannelRateChange{ChannelID: c.ID, ChannelName: c.Name, Change: change})
	}
	for _, change := range added {
		batch.Added = append(batch.Added, notify.ChannelRateChange{ChannelID: c.ID, ChannelName: c.Name, Change: change})
	}
	for _, change := range removed {
		batch.Removed = append(batch.Removed, notify.ChannelRateChange{ChannelID: c.ID, ChannelName: c.Name, Change: change})
	}
	if err := s.syncAnnouncements(ctx, c, resolved, conn, session); err != nil {
		s.log.Warn("sync announcements failed", "channel", c.Name, "err", err)
	}
	progress.OK(ctx, progress.StageRates, fmt.Sprintf("拉到 %d 个分组", len(results)),
		map[string]any{"count": len(results)})
	return nil
}

// prepare 解密渠道并拿到可用会话，同时上报会话相关的失败 / 恢复。
func (s *Service) prepare(ctx context.Context, c *storage.Channel) (*connector.Channel, connector.Connector, *connector.AuthSession, error) {
	resolved, conn, session, err := s.ensureSession(ctx, c)
	if err != nil {
		// 登录退避跳过的这一轮没有请求上游，不算新的失败。
		if !channel.IsBackoff(err) {
			s.reportFailure(ctx, c, prepareFailureKind(err), err)
		}
		return nil, nil, nil, err
	}
	s.reportSuccess(ctx, c, notify.FailureLogin, notify.FailureCaptcha, notify.FailureSession)
	return resolved, conn, session, nil
}

func (s *Service) ensureSession(ctx context.Context, c *storage.Channel) (*connector.Channel, connector.Connector, *connector.AuthSession, error) {
	resolved, err := s.channelSvc.Resolve(ctx, c)
	if err != nil {
		return nil, nil, nil, err
	}
	conn, err := connector.For(resolved.Type)
	if err != nil {
		return nil, nil, nil, err
	}
	s.channelSvc.ApplyHTTPConfig(conn)
	session, err := s.channelSvc.EnsureSession(ctx, c, resolved, conn)
	if err != nil {
		return nil, nil, nil, err
	}
	return resolved, conn, session, nil
}

// prepareFailureKind 按出错环节归类：打码、登录，其余（会话校验 / 刷新失败、上游暂时不可用）归为会话。
func prepareFailureKind(err error) notify.FailureKind {
	switch {
	case channel.IsCaptchaError(err):
		return notify.FailureCaptcha
	case channel.IsLoginError(err):
		return notify.FailureLogin
	default:
		return notify.FailureSession
	}
}

// reportFailure 交给 Dispatcher 做失败去重；永久错误（密码错误、打码余额不足等）立即通知。
func (s *Service) reportFailure(ctx context.Context, c *storage.Channel, kind notify.FailureKind, err error) {
	if channel.IsCanceled(ctx) {
		return // 手动刷新时用户关掉了页面，不算失败
	}
	if reportErr := s.dispatcher.ReportFailure(ctx, notify.Failure{
		ChannelID:   c.ID,
		ChannelName: c.Name,
		Kind:        kind,
		Err:         err,
		Immediate:   connector.IsPermanent(err),
	}); reportErr != nil {
		s.log.Warn("report failure", "channel", c.Name, "kind", kind, "err", reportErr)
	}
}

func (s *Service) reportSuccess(ctx context.Context, c *storage.Channel, kinds ...notify.FailureKind) {
	if err := s.dispatcher.ReportSuccess(ctx, c.ID, c.Name, kinds...); err != nil {
		s.log.Warn("report success", "channel", c.Name, "err", err)
	}
}

// appendMonitorLog 写一条监控日志；调用方取消导致的失败不记录，见 channel.IsCanceled。
func (s *Service) appendMonitorLog(ctx context.Context, channelID uint, job storage.MonitorJob, started time.Time, err error) {
	if err != nil && channel.IsCanceled(ctx) {
		return
	}
	_ = s.monitorLogs.Append(&storage.MonitorLog{
		ChannelID:    channelID,
		Job:          job,
		Success:      err == nil,
		ErrorMessage: errString(err),
		StartedAt:    started,
		FinishedAt:   time.Now(),
	})
}

func (s *Service) syncAnnouncements(ctx context.Context, c *storage.Channel, resolved *connector.Channel, conn connector.Connector, session *connector.AuthSession) error {
	if s.announcements == nil {
		return nil
	}
	if c.IgnoreAnnouncements {
		return nil
	}
	items, err := conn.GetAnnouncements(ctx, resolved, session)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return nil
	}
	records := make([]storage.UpstreamAnnouncement, 0, len(items))
	for _, item := range items {
		records = append(records, storage.UpstreamAnnouncement{
			ChannelID:       c.ID,
			SourceKey:       item.SourceKey,
			Title:           item.Title,
			Content:         item.Content,
			Type:            item.Type,
			Link:            item.Link,
			PublishedAt:     item.PublishedAt,
			SourceUpdatedAt: item.SourceUpdatedAt,
		})
	}
	existingCount, err := s.announcements.CountByChannel(c.ID)
	if err != nil {
		return err
	}
	newRecords, err := s.announcements.Sync(c.ID, records)
	if err != nil {
		return err
	}
	if existingCount == 0 {
		return nil
	}
	for i := range newRecords {
		rec := newRecords[i]
		_ = s.dispatcher.Dispatch(ctx, notify.Message{
			Event:     storage.EventAnnouncement,
			ChannelID: c.ID,
			Subject:   announcementSubject(c, rec),
			Body:      announcementBody(c, rec),
			Extra: map[string]any{
				"announcement_id": rec.ID,
				"source_key":      rec.SourceKey,
				"title":           rec.Title,
				"type":            rec.Type,
				"link":            rec.Link,
			},
		})
	}
	return nil
}

func announcementSubject(c *storage.Channel, a storage.UpstreamAnnouncement) string {
	title := strings.TrimSpace(a.Title)
	if title == "" {
		title = strings.TrimSpace(a.Content)
	}
	if title == "" {
		title = "上游公告"
	}
	if len([]rune(title)) > 40 {
		title = string([]rune(title)[:40])
	}
	return fmt.Sprintf("%s 公告 · %s", c.Name, title)
}

func announcementBody(c *storage.Channel, a storage.UpstreamAnnouncement) string {
	var b strings.Builder
	if a.Content != "" {
		b.WriteString(a.Content)
	}
	if a.Link != "" {
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("来源：")
		b.WriteString(a.Link)
	}
	if a.PublishedAt != nil {
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("发布时间：")
		b.WriteString(a.PublishedAt.Format("2006-01-02 15:04"))
	}
	return b.String()
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
