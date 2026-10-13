package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-resty/resty/v2"
	"github.com/yreidev/upstream-ops/backend/storage"
)

func init() {
	Register(storage.NotifyTelegram, func(raw string) (Notifier, error) { return newTelegram(raw) })
}

type telegramConfig struct {
	BotToken string `json:"bot_token"`
	ChatID   string `json:"chat_id"`
}

type telegram struct {
	cfg  telegramConfig
	http *resty.Client
	base string
}

func newTelegram(raw string) (*telegram, error) {
	var cfg telegramConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return nil, err
	}
	if cfg.BotToken == "" || cfg.ChatID == "" {
		return nil, errors.New("telegram bot_token and chat_id are required")
	}
	return &telegram{cfg: cfg, http: resty.New().SetTimeout(sendTimeout), base: "https://api.telegram.org"}, nil
}

func (t *telegram) Type() storage.NotificationChannelType { return storage.NotifyTelegram }

// telegramMaxBodyRunes 正文截断长度。Telegram 限制解析后的文本不超过 4096 字符，
// 标题和截断提示另占一些，留足余量。
const telegramMaxBodyRunes = 3800

// Send 用 HTML 模式发送：通知正文是 CommonMark 的一个小子集（见 BuildRateNotificationBatchMessage），
// 转成 Telegram 支持的 HTML 标签，其余字符全部转义。旧的 Markdown 模式遇到分组名里的 "_"、"*" 会解析失败。
// HTML 万一仍被拒（can't parse entities），退回纯文本再发一次。
func (t *telegram) Send(ctx context.Context, msg Message) error {
	body := truncateRunes(msg.Body, telegramMaxBodyRunes)
	err := t.sendMessage(ctx, "<b>"+telegramEscape(msg.Subject)+"</b>\n"+telegramHTML(body), "HTML")
	var sendErr *SendError
	if errors.As(err, &sendErr) && strings.Contains(strings.ToLower(sendErr.Error()), "can't parse entities") {
		return t.sendMessage(ctx, msg.Subject+"\n"+body, "")
	}
	return err
}

type telegramResponse struct {
	OK          bool   `json:"ok"`
	ErrorCode   int    `json:"error_code"`
	Description string `json:"description"`
	Parameters  struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

func (t *telegram) sendMessage(ctx context.Context, text, parseMode string) error {
	payload := map[string]any{
		"chat_id": t.cfg.ChatID,
		"text":    text,
		"link_preview_options": map[string]any{
			"is_disabled": true,
		},
	}
	if parseMode != "" {
		payload["parse_mode"] = parseMode
	}
	resp, err := t.http.R().
		SetContext(ctx).
		SetBody(payload).
		Post(t.base + "/bot" + t.cfg.BotToken + "/sendMessage")
	if err != nil {
		return requestError("telegram", err)
	}
	var r telegramResponse
	_ = json.Unmarshal(resp.Body(), &r)
	if !resp.IsError() && r.OK {
		return nil
	}
	code := resp.StatusCode()
	desc := strings.TrimSpace(r.Description)
	if desc == "" {
		desc = resp.Status()
	}
	sendErr := &SendError{Err: fmt.Errorf("telegram %d: %s", code, desc)}
	switch {
	case code == http.StatusTooManyRequests:
		sendErr.RetryAfter = time.Duration(r.Parameters.RetryAfter) * time.Second
	case code == http.StatusBadRequest, code == http.StatusUnauthorized, code == http.StatusForbidden, code == http.StatusNotFound:
		// 400 参数或格式错误、401 token 无效、403 被移出群或被用户屏蔽、404 token 不存在
		sendErr.Permanent = true
	}
	return sendErr
}

var telegramEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func telegramEscape(s string) string { return telegramEscaper.Replace(s) }

var (
	telegramHeading = regexp.MustCompile(`^#{1,6}\s+(.*)$`)
	telegramBold    = regexp.MustCompile(`\*\*([^*\n]+?)\*\*`)
	telegramCode    = regexp.MustCompile("`([^`\n]+)`")
)

// telegramHTML 把通知正文用到的 CommonMark 子集转成 Telegram HTML：
// 标题 → 加粗，**粗体** → <b>，`代码` → <code>，"> " 引用 → <blockquote>，"- " 列表 → "• "。
// 其余内容原样转义，不会被当成标签。
func telegramHTML(body string) string {
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		switch {
		case telegramHeading.MatchString(line):
			lines[i] = "<b>" + telegramInline(telegramHeading.FindStringSubmatch(line)[1]) + "</b>"
		case strings.HasPrefix(line, "> "):
			lines[i] = "<blockquote>" + telegramInline(strings.TrimPrefix(line, "> ")) + "</blockquote>"
		case strings.HasPrefix(line, "- "):
			lines[i] = "• " + telegramInline(strings.TrimPrefix(line, "- "))
		default:
			lines[i] = telegramInline(line)
		}
	}
	return strings.Join(lines, "\n")
}

func telegramInline(s string) string {
	s = telegramEscape(s)
	s = telegramCode.ReplaceAllString(s, "<code>$1</code>")
	return telegramBold.ReplaceAllString(s, "<b>$1</b>")
}

// truncateRunes 超过 max 个字符时截断并注明。
func truncateRunes(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max]) + "\n…（内容过长，已截断）"
}
