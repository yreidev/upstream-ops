// Package notify 通知发送统一接口与 Dispatcher。
//
// 支持 Telegram Bot 与企业微信群机器人，每种类型走 ConfigCipher 里的 JSON 字段。
package notify

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/yreidev/upstream-ops/backend/storage"
)

// Message 待发送的通知消息。
//
// ChannelID / ModelName 用于 Dispatcher 做订阅过滤：
//   - ChannelID = 来源上游 ID，0 表示系统消息或测试发送，跳过订阅过滤
//   - ModelName = 倍率相关事件填写当前分组名
type Message struct {
	Event     storage.NotificationEvent
	ChannelID uint
	ModelName string
	Subject   string
	Body      string
	Extra     map[string]any
}

// Notifier 通知渠道抽象。
type Notifier interface {
	Send(ctx context.Context, msg Message) error
	Type() storage.NotificationChannelType
}

// Factory 用解密后的 JSON 配置构造一个 Notifier。
type Factory func(rawConfig string) (Notifier, error)

var (
	mu       sync.RWMutex
	registry = map[storage.NotificationChannelType]Factory{}
)

// Register 由各 notifier 实现在 init() 中注册。
func Register(t storage.NotificationChannelType, f Factory) {
	mu.Lock()
	defer mu.Unlock()
	registry[t] = f
}

// Supported 判断通知类型是否已注册。
func Supported(t storage.NotificationChannelType) bool {
	mu.RLock()
	defer mu.RUnlock()
	_, ok := registry[t]
	return ok
}

// Build 根据存储模型 + 已解密配置构造 Notifier。
func Build(c *storage.NotificationChannel, decryptedConfig string) (Notifier, error) {
	if c == nil {
		return nil, errors.New("notification channel is nil")
	}
	mu.RLock()
	f, ok := registry[c.Type]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown notifier type: %s", c.Type)
	}
	return f(decryptedConfig)
}

// sendTimeout 单次调用通知平台接口的超时。
const sendTimeout = 15 * time.Second

// SendError 是通知平台明确给出结果的发送失败，告诉 Dispatcher 要不要、隔多久重试。
type SendError struct {
	Err error
	// RetryAfter 平台要求的等待时间（Telegram 429 的 parameters.retry_after、企业微信 45009 限频）。
	RetryAfter time.Duration
	// Permanent 重试也不会成功：token / webhook 无效、群聊不存在、参数错误等。
	Permanent bool
}

func (e *SendError) Error() string { return e.Err.Error() }
func (e *SendError) Unwrap() error { return e.Err }

// requestError 去掉 HTTP 客户端错误里的请求 URL（Telegram bot token、企业微信 key 都在 URL 里），只留底层原因。
func requestError(platform string, err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	return fmt.Errorf("%s request: %w", platform, err)
}
