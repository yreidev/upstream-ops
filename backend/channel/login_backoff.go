package channel

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/yreidev/upstream-ops/backend/captcha"
	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// LoginError 表示错误发生在登录环节：登录被拒、登录后鉴权失败、token 模式下 token 已失效。
// 监控按"登录失败"上报。
type LoginError struct{ Err error }

func (e *LoginError) Error() string { return e.Err.Error() }
func (e *LoginError) Unwrap() error { return e.Err }

// CaptchaError 表示登录前求解 Turnstile 失败。监控按"打码失败"上报。
type CaptchaError struct{ Err error }

func (e *CaptchaError) Error() string { return e.Err.Error() }
func (e *CaptchaError) Unwrap() error { return e.Err }

// BackoffError 表示定时任务因登录退避跳过了这次登录，并没有真正请求上游。
// 调用方不应把它当成一次新的失败去上报或计数。
type BackoffError struct {
	Paused  bool
	NextAt  time.Time
	LastErr string
}

func (e *BackoffError) Error() string {
	if e.Paused {
		return "已暂停自动登录：" + e.LastErr
	}
	return fmt.Sprintf("登录失败退避中，%s 后自动重试：%s", e.NextAt.Format("15:04"), e.LastErr)
}

// IsBackoff 判断错误是不是登录退避跳过。
func IsBackoff(err error) bool {
	var backoffErr *BackoffError
	return errors.As(err, &backoffErr)
}

// IsLoginError 判断错误是否发生在登录环节（不含打码）。
func IsLoginError(err error) bool {
	var loginErr *LoginError
	return errors.As(err, &loginErr)
}

// IsCaptchaError 判断错误是否发生在打码环节。
func IsCaptchaError(err error) bool {
	var captchaErr *CaptchaError
	return errors.As(err, &captchaErr)
}

type scheduledKey struct{}

// WithScheduled 标记 ctx 来自定时任务。只有定时任务受登录退避限制，手动刷新、测试登录不受限。
func WithScheduled(ctx context.Context) context.Context {
	return context.WithValue(ctx, scheduledKey{}, true)
}

func isScheduled(ctx context.Context) bool {
	v, _ := ctx.Value(scheduledKey{}).(bool)
	return v
}

// loginBackoffSteps 连续登录失败后，定时任务下次自动登录前要等的时间，到最后一档后不再增加。
// 避免每 15 分钟反复登录：既浪费打码费，又会耗尽上游的会话配额（NewAPI 409 / 429）。
var loginBackoffSteps = []time.Duration{15 * time.Minute, 30 * time.Minute, time.Hour, 2 * time.Hour}

// loginBackoffSlack 定时任务触发有几秒抖动，距离可重试时间不到这么久也放行，免得刚好错过一轮。
const loginBackoffSlack = time.Minute

// autoLoginPausedNote 追加在永久错误后面，提示用户怎么恢复。
const autoLoginPausedNote = "（已暂停自动登录，修改渠道配置或手动刷新后恢复）"

type loginBackoffState struct {
	failures int
	failedAt time.Time
	nextAt   time.Time
	// paused 遇到永久错误（connector.IsPermanent）后暂停自动登录，直到配置变更或手动登录成功。
	paused bool
	// captchaID 因打码平台余额不足暂停时记下打码配置；之后查到它余额恢复就自动解除。
	captchaID uint
	lastErr   string
}

// loginBackoffs 按渠道记录登录退避状态。内存里放一份，设了 store 时同步写库，重启后读回，
// 暂停自动登录的渠道不会因为重启再白登录一次。写库失败不影响内存里的状态，最多重启后多试一次。
type loginBackoffs struct {
	mu     sync.Mutex
	states map[uint]*loginBackoffState
	store  *storage.LoginBackoffs
	loaded bool
}

// useStore 设置持久化存储，下次访问时从库里读回状态。
func (b *loginBackoffs) useStore(store *storage.LoginBackoffs) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.store = store
	b.loaded = false
}

// loadLocked 第一次访问时把库里的状态读进内存；读失败下次再试。调用方持有 b.mu。
func (b *loginBackoffs) loadLocked() {
	if b.states == nil {
		b.states = make(map[uint]*loginBackoffState)
	}
	if b.loaded || b.store == nil {
		return
	}
	rows, err := b.store.List()
	if err != nil {
		return
	}
	for _, row := range rows {
		if _, ok := b.states[row.ChannelID]; ok {
			continue
		}
		b.states[row.ChannelID] = &loginBackoffState{
			failures:  row.Failures,
			failedAt:  row.FailedAt,
			nextAt:    row.NextAt,
			paused:    row.Paused,
			captchaID: row.CaptchaID,
			lastErr:   row.LastError,
		}
	}
	b.loaded = true
}

func (b *loginBackoffs) deleteLocked(channelIDs ...uint) {
	for _, id := range channelIDs {
		delete(b.states, id)
	}
	if b.store != nil {
		_ = b.store.Delete(channelIDs...)
	}
}

func (b *loginBackoffs) get(channelID uint) (loginBackoffState, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.loadLocked()
	st, ok := b.states[channelID]
	if !ok {
		return loginBackoffState{}, false
	}
	return *st, true
}

// recordFailure 记一次登录失败，返回这次是否进入暂停。
func (b *loginBackoffs) recordFailure(c *storage.Channel, err error, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.loadLocked()
	st, ok := b.states[c.ID]
	if !ok {
		st = &loginBackoffState{}
		b.states[c.ID] = st
	}
	st.failures++
	step := loginBackoffSteps[min(st.failures, len(loginBackoffSteps))-1]
	st.failedAt = now
	st.nextAt = now.Add(step)
	st.paused = connector.IsPermanent(err)
	st.captchaID = 0
	if st.paused && IsCaptchaError(err) && c.CaptchaConfigID != nil {
		st.captchaID = *c.CaptchaConfigID
	}
	st.lastErr = err.Error()
	if b.store != nil {
		_ = b.store.Save(&storage.LoginBackoffState{
			ChannelID: c.ID,
			Failures:  st.failures,
			FailedAt:  st.failedAt,
			NextAt:    st.nextAt,
			Paused:    st.paused,
			CaptchaID: st.captchaID,
			LastError: st.lastErr,
		})
	}
	return st.paused
}

func (b *loginBackoffs) clear(channelID uint) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.loadLocked()
	// 没读成库时也删一次库里的行，免得留下过期的暂停状态，重启后误读回来
	if _, ok := b.states[channelID]; ok || !b.loaded {
		b.deleteLocked(channelID)
	}
}

// clearIf 删除满足条件的状态。
func (b *loginBackoffs) clearIf(match func(*loginBackoffState) bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.loadLocked()
	var ids []uint
	for id, st := range b.states {
		if match(st) {
			ids = append(ids, id)
		}
	}
	if len(ids) > 0 {
		b.deleteLocked(ids...)
	}
}

// checkLoginBackoff 定时任务登录前调用：还在退避或暂停中就返回 *BackoffError。
func (s *Service) checkLoginBackoff(c *storage.Channel) error {
	st, ok := s.loginBackoffs.get(c.ID)
	if !ok {
		return nil
	}
	if st.paused {
		if st.captchaID != 0 && s.captchaRecovered(st.captchaID, st.failedAt) {
			s.loginBackoffs.clear(c.ID)
			return nil
		}
		return &BackoffError{Paused: true, LastErr: st.lastErr}
	}
	if time.Until(st.nextAt) > loginBackoffSlack {
		return &BackoffError{NextAt: st.nextAt, LastErr: st.lastErr}
	}
	return nil
}

// captchaRecovered 判断打码配置在 since 之后是否查到过正余额（定时任务每轮都会刷新打码余额）。
func (s *Service) captchaRecovered(captchaID uint, since time.Time) bool {
	if s.Captchas == nil {
		return false
	}
	cfg, err := s.Captchas.FindByID(captchaID)
	if err != nil || cfg == nil {
		return false
	}
	return cfg.BalanceAt != nil && cfg.BalanceAt.After(since) && cfg.LastBalance != nil && *cfg.LastBalance > 0
}

// PersistLoginBackoffs 让登录退避和暂停状态写进数据库，重启后接着生效。不调用时只放内存。
func (s *Service) PersistLoginBackoffs(store *storage.LoginBackoffs) {
	s.loginBackoffs.useStore(store)
}

// ResumeAutoLogin 解除渠道的登录退避和暂停，渠道配置被修改时调用。
func (s *Service) ResumeAutoLogin(channelID uint) {
	s.loginBackoffs.clear(channelID)
}

// ResumeAutoLoginForCaptcha 解除因该打码配置出错而暂停的渠道，打码配置被修改时调用。
func (s *Service) ResumeAutoLoginForCaptcha(captchaID uint) {
	s.loginBackoffs.clearIf(func(st *loginBackoffState) bool { return st.captchaID == captchaID })
}

// permanentCaptchaError 把打码平台的"不处理不会好"错误（余额不足）标成 connector 的永久错误。
func permanentCaptchaError(err error) error {
	var apiErr *captcha.APIError
	if errors.As(err, &apiErr) && apiErr.Permanent() {
		return connector.Permanent(err)
	}
	return err
}
