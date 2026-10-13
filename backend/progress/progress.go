// Package progress 把任务的分步进度经 context 传到业务层，由外层决定怎么记录。
//
// 业务层只管 Start / OK / Fail；后台任务（jobs 包）把记录进度的 Observer 塞进 ctx，
// 事件随任务一起存库，页面轮询任务时读到。ctx 里没有 Observer 时 Emit 什么都不做。
package progress

import (
	"context"
	"time"
)

// Stage 标记当前事件属于哪个阶段，便于前端按 stage 给图标 / 颜色。
type Stage string

const (
	StageCaptcha Stage = "captcha"
	StageLogin   Stage = "login"
	StageSession Stage = "session"
	StageBalance Stage = "balance"
	StageCost    Stage = "cost"
	StageRates   Stage = "rates"
	StageDegrade Stage = "degrade"
	StageDone    Stage = "done"
	StageSkipped Stage = "skipped"
	StageError   Stage = "error"
)

// Event 一条进度事件。OK 三态：nil = 进行中，true = 成功，false = 失败。
type Event struct {
	Stage       Stage     `json:"stage"`
	Message     string    `json:"message"`
	OK          *bool     `json:"ok,omitempty"`
	Data        any       `json:"data,omitempty"`
	Time        time.Time `json:"time"`
	ChannelID   uint      `json:"channel_id,omitempty"`
	ChannelName string    `json:"channel_name,omitempty"`
	Index       int       `json:"index,omitempty"`
	Total       int       `json:"total,omitempty"`
}

// Observer 消费进度事件。
type Observer interface {
	Emit(Event)
}

// NopObserver 什么都不做，ctx 里没有 Observer 时用它。
type NopObserver struct{}

func (NopObserver) Emit(Event) {}

type ctxKey struct{}

// WithObserver 把 observer 绑到 context。
func WithObserver(ctx context.Context, obs Observer) context.Context {
	if obs == nil {
		return ctx
	}
	return context.WithValue(ctx, ctxKey{}, obs)
}

// FromContext 从 context 取 observer；没有则返回 NopObserver。
func FromContext(ctx context.Context) Observer {
	if obs, ok := ctx.Value(ctxKey{}).(Observer); ok {
		return obs
	}
	return NopObserver{}
}

// Start 发送一条"进行中"事件。
func Start(ctx context.Context, s Stage, msg string) {
	FromContext(ctx).Emit(Event{Stage: s, Message: msg, Time: time.Now()})
}

// OK 发送一条"成功"事件，可附带 data。
func OK(ctx context.Context, s Stage, msg string, data ...any) {
	ok := true
	ev := Event{Stage: s, Message: msg, OK: &ok, Time: time.Now()}
	if len(data) > 0 {
		ev.Data = data[0]
	}
	FromContext(ctx).Emit(ev)
}

// Skip 发送一条"跳过"事件：没去做，也不算失败（如登录退避中）。
func Skip(ctx context.Context, msg string) {
	ok := true
	FromContext(ctx).Emit(Event{Stage: StageSkipped, Message: msg, OK: &ok, Time: time.Now()})
}

// Fail 发送一条"失败"事件。
func Fail(ctx context.Context, s Stage, msg string) {
	no := false
	FromContext(ctx).Emit(Event{Stage: s, Message: msg, OK: &no, Time: time.Now()})
}

// ForChannel 让 ctx 里发出的事件都带上渠道和序号（第 index 个，共 total 个），批量任务里用来区分是哪个渠道。
func ForChannel(ctx context.Context, channelID uint, channelName string, index, total int) context.Context {
	return WithObserver(ctx, channelObserver{
		base:        FromContext(ctx),
		channelID:   channelID,
		channelName: channelName,
		index:       index,
		total:       total,
	})
}

type channelObserver struct {
	base        Observer
	channelID   uint
	channelName string
	index       int
	total       int
}

func (o channelObserver) Emit(ev Event) {
	ev.ChannelID = o.channelID
	ev.ChannelName = o.channelName
	ev.Index = o.index
	ev.Total = o.total
	o.base.Emit(ev)
}
