package notify

import (
	"context"
	"fmt"
	"time"

	"github.com/yreidev/upstream-ops/backend/redact"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// FailureKind 失败通知的去重粒度：同一上游同一类失败合并计数。
type FailureKind string

const (
	FailureLogin   FailureKind = "login"   // 登录失败（含 token 已失效）
	FailureCaptcha FailureKind = "captcha" // 打码失败
	FailureSession FailureKind = "session" // 校验 / 刷新已有会话失败，多为上游暂时不可用
	FailureBalance FailureKind = "balance"
	FailureCosts   FailureKind = "costs"
	FailureRates   FailureKind = "rates"
	// FailureCCHSync 同步成本倍率到 CCH 失败。不属于某个上游渠道，ChannelID 为 0。
	FailureCCHSync FailureKind = "cch_sync"
)

// Label 是失败类别的中文名，用在通知标题里：「<渠道> <Label>失败」「<渠道> <Label>已恢复」。
func (k FailureKind) Label() string {
	switch k {
	case FailureLogin:
		return "登录"
	case FailureCaptcha:
		return "打码"
	case FailureSession:
		return "会话校验"
	case FailureBalance:
		return "余额采集"
	case FailureCosts:
		return "消费采集"
	case FailureRates:
		return "倍率采集"
	case FailureCCHSync:
		return "CCH 倍率同步"
	default:
		return string(k)
	}
}

// Event 是这类失败对应的通知事件，订阅过滤按它走。
func (k FailureKind) Event() storage.NotificationEvent {
	switch k {
	case FailureLogin:
		return storage.EventLoginFailed
	case FailureCaptcha:
		return storage.EventCaptchaFailed
	case FailureCCHSync:
		return storage.EventCCHSync
	default:
		return storage.EventMonitorFailed
	}
}

// system 表示这类失败不属于某个上游渠道，用 ChannelID 0 记录和通知。
func (k FailureKind) system() bool {
	return k == FailureCCHSync
}

// failureSubject 拼通知标题：「<渠道> <类别><结果>」，系统类失败没有渠道名。
func failureSubject(channelName string, kind FailureKind, outcome string) string {
	if channelName == "" {
		return kind.Label() + outcome
	}
	return fmt.Sprintf("%s %s%s", channelName, kind.Label(), outcome)
}

const (
	// failureNotifyThreshold / failureNotifyMinSpan：连续失败至少这么多次、且从第一次失败起已过这么久才通知。
	// 定时任务每 15 分钟一轮，等于"连续两轮都失败"；同一轮里余额和倍率任务各失败一次不算。
	failureNotifyThreshold = 2
	failureNotifyMinSpan   = 10 * time.Minute
	// failureRemindInterval 通知过之后仍未恢复，每隔这么久再提醒一次。
	failureRemindInterval = 6 * time.Hour
)

// Failure 是一次采集 / 登录失败。
type Failure struct {
	ChannelID   uint
	ChannelName string
	Kind        FailureKind
	Err         error
	// Immediate 表示不用等连续失败，第一次就通知：账号密码错误、打码余额不足这类不处理不会好的错误。
	Immediate bool
}

// ReportFailure 记一次失败，按去重规则决定是否发失败通知：
//   - 连续失败达到 failureNotifyThreshold 次且持续 failureNotifyMinSpan 以上（或 Immediate）时通知一次；
//   - 之后仍未恢复，每 failureRemindInterval 提醒一次；
//   - 计数持久化在 notification_failure_states，重启不丢。
func (d *Dispatcher) ReportFailure(ctx context.Context, f Failure) error {
	if f.Err == nil || (f.ChannelID == 0 && !f.Kind.system()) {
		return nil
	}
	now := time.Now()
	errText := redact.Secrets(f.Err.Error())

	d.failureMu.Lock()
	state, err := d.repo.RecordFailure(f.ChannelID, string(f.Kind), errText, now)
	if err != nil {
		d.failureMu.Unlock()
		return err
	}
	send, remind := shouldNotifyFailure(state, f.Immediate, now)
	if send {
		if err := d.repo.MarkFailureNotified(f.ChannelID, string(f.Kind), now); err != nil {
			d.failureMu.Unlock()
			return err
		}
	}
	d.failureMu.Unlock()

	if !send {
		if d.log != nil {
			d.log.Debug("failure notification deferred",
				"channel_id", f.ChannelID, "kind", f.Kind, "failures", state.Failures)
		}
		return nil
	}
	return d.Dispatch(ctx, Message{
		Event:     f.Kind.Event(),
		ChannelID: f.ChannelID,
		Subject:   failureSubject(f.ChannelName, f.Kind, "失败"),
		Body:      failureBody(state, remind, errText),
	})
}

func shouldNotifyFailure(state *storage.NotificationFailureState, immediate bool, now time.Time) (send, remind bool) {
	if state.NotifiedAt != nil {
		return now.Sub(*state.NotifiedAt) >= failureRemindInterval, true
	}
	if immediate {
		return true, false
	}
	return state.Failures >= failureNotifyThreshold && now.Sub(state.FirstFailedAt) >= failureNotifyMinSpan, false
}

func failureBody(state *storage.NotificationFailureState, remind bool, errText string) string {
	since := state.FirstFailedAt.Format("01-02 15:04")
	switch {
	case remind:
		return fmt.Sprintf("仍未恢复：自 %s 起已连续失败 %d 次（%s）。\n最近一次错误：%s",
			since, state.Failures, formatFailureDuration(state.LastFailedAt.Sub(state.FirstFailedAt)), errText)
	case state.Failures > 1:
		return fmt.Sprintf("自 %s 起连续失败 %d 次。\n最近一次错误：%s", since, state.Failures, errText)
	default:
		return errText
	}
}

// ReportSuccess 记一次成功：清掉这些类别的连续失败计数；之前发过失败通知的，补发一条恢复通知。
func (d *Dispatcher) ReportSuccess(ctx context.Context, channelID uint, channelName string, kinds ...FailureKind) error {
	if len(kinds) == 0 {
		return nil
	}
	if channelID == 0 {
		for _, k := range kinds {
			if !k.system() {
				return nil
			}
		}
	}
	names := make([]string, len(kinds))
	for i, k := range kinds {
		names[i] = string(k)
	}
	d.failureMu.Lock()
	cleared, err := d.repo.ClearFailures(channelID, names)
	d.failureMu.Unlock()
	if err != nil {
		return err
	}
	now := time.Now()
	for _, state := range cleared {
		if state.NotifiedAt == nil {
			continue
		}
		kind := FailureKind(state.Kind)
		_ = d.Dispatch(ctx, Message{
			Event:     storage.EventRecovered,
			ChannelID: channelID,
			Subject:   failureSubject(channelName, kind, "已恢复"),
			Body: fmt.Sprintf("自 %s 起连续失败 %d 次，故障持续约 %s。\n最后一次错误：%s",
				state.FirstFailedAt.Format("01-02 15:04"), state.Failures,
				formatFailureDuration(now.Sub(state.FirstFailedAt)), state.LastError),
		})
	}
	return nil
}

func formatFailureDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "不到 1 分钟"
	case d < time.Hour:
		return fmt.Sprintf("%d 分钟", int(d/time.Minute))
	case d < 24*time.Hour:
		h := int(d / time.Hour)
		if m := int(d%time.Hour) / int(time.Minute); m > 0 {
			return fmt.Sprintf("%d 小时 %d 分钟", h, m)
		}
		return fmt.Sprintf("%d 小时", h)
	default:
		days := int(d / (24 * time.Hour))
		if h := int(d%(24*time.Hour)) / int(time.Hour); h > 0 {
			return fmt.Sprintf("%d 天 %d 小时", days, h)
		}
		return fmt.Sprintf("%d 天", days)
	}
}
