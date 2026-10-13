package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/go-resty/resty/v2"
	"github.com/yreidev/upstream-ops/backend/storage"
)

func init() {
	Register(storage.NotifyWecom, func(raw string) (Notifier, error) { return newWecom(raw) })
}

type wecomConfig struct {
	WebhookURL string `json:"webhook_url"`
}

type wecom struct {
	cfg  wecomConfig
	http *resty.Client
}

func newWecom(raw string) (*wecom, error) {
	var cfg wecomConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return nil, err
	}
	if cfg.WebhookURL == "" {
		return nil, errors.New("wecom webhook_url is required")
	}
	return &wecom{cfg: cfg, http: resty.New().SetTimeout(sendTimeout)}, nil
}

func (w *wecom) Type() storage.NotificationChannelType { return storage.NotifyWecom }

// wecomMaxContentBytes 群机器人 markdown 消息 content 最长 4096 字节（UTF-8）。
const wecomMaxContentBytes = 4096

const wecomTruncatedNote = "\n…（内容过长，已截断）"

// 群机器人接口的错误码（HTTP 状态总是 200，结果看 errcode）。
const (
	wecomErrInvalidParam   = 40058 // 参数不合法，如内容超长
	wecomErrRateLimited    = 45009 // 接口调用超过限制：每个机器人每分钟最多 20 条
	wecomErrInvalidWebhook = 93000 // webhook 地址无效或机器人已被移出群
)

// wecomRateLimitWait 遇到限频时的等待时间（限制按分钟计）。
const wecomRateLimitWait = time.Minute

func (w *wecom) Send(ctx context.Context, msg Message) error {
	resp, err := w.http.R().
		SetContext(ctx).
		SetBody(map[string]any{
			"msgtype": "markdown",
			"markdown": map[string]string{
				"content": wecomContent(msg),
			},
		}).
		Post(w.cfg.WebhookURL)
	if err != nil {
		return requestError("wecom", err)
	}
	if resp.IsError() {
		return fmt.Errorf("wecom returned %s", resp.Status())
	}
	var r struct {
		ErrCode int    `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
	}
	if err := json.Unmarshal(resp.Body(), &r); err != nil {
		return fmt.Errorf("wecom decode response: %w", err)
	}
	if r.ErrCode == 0 {
		return nil
	}
	sendErr := &SendError{Err: fmt.Errorf("wecom errcode %d: %s", r.ErrCode, r.ErrMsg)}
	switch r.ErrCode {
	case wecomErrRateLimited:
		sendErr.RetryAfter = wecomRateLimitWait
	case wecomErrInvalidParam, wecomErrInvalidWebhook:
		sendErr.Permanent = true
	}
	return sendErr
}

// wecomContent 拼出 markdown 内容，超过 4096 字节时按字符边界截断正文。
func wecomContent(msg Message) string {
	content := "**" + msg.Subject + "**\n" + msg.Body
	if len(content) <= wecomMaxContentBytes {
		return content
	}
	limit := wecomMaxContentBytes - len(wecomTruncatedNote)
	cut := limit
	for cut > 0 && !utf8.RuneStart(content[cut]) {
		cut--
	}
	return content[:cut] + wecomTruncatedNote
}
