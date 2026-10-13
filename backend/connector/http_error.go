package connector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
)

const maxHTTPErrorSummaryRunes = 300

// StatusError 是上游返回非 2xx 时的错误，保留状态码供调用方分类（见 IsTransient）。
type StatusError struct {
	Code    int
	Summary string
}

func (e *StatusError) Error() string {
	if e.Summary == "" {
		return fmt.Sprintf("status %d", e.Code)
	}
	return fmt.Sprintf("status %d: %s", e.Code, e.Summary)
}

func HTTPStatusError(statusCode int, body []byte) error {
	return &StatusError{Code: statusCode, Summary: summarizeHTTPErrorBody(body)}
}

// StatusCode 取出错误链里的上游 HTTP 状态码，没有则返回 0。
func StatusCode(err error) int {
	var statusErr *StatusError
	if errors.As(err, &statusErr) {
		return statusErr.Code
	}
	return 0
}

// IsTransient 判断错误是不是临时故障：网络错误、超时、408、429 和 5xx（含 Cloudflare 52x）。
// 这类错误不能说明凭据失效，不应据此判定 token 过期、刷新会话或重新登录。
func IsTransient(err error) bool {
	if err == nil {
		return false
	}
	if code := StatusCode(err); code != 0 {
		return code == 408 || code == 429 || code >= 500
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	// *url.Error、*net.OpError、*net.DNSError 都实现了 net.Error，覆盖连接失败、TLS 握手超时、域名解析失败等
	var netErr net.Error
	return errors.As(err, &netErr)
}

// PermanentError 标记"不改配置就不会自己好"的错误，如账号密码错误、账号被停用。
// 定时任务遇到它会暂停自动登录，直到渠道配置被修改或用户手动刷新。
type PermanentError struct {
	Err error
}

func (e *PermanentError) Error() string { return e.Err.Error() }
func (e *PermanentError) Unwrap() error { return e.Err }

// Permanent 把 err 标记为 PermanentError，nil 原样返回。
func Permanent(err error) error {
	if err == nil {
		return nil
	}
	return &PermanentError{Err: err}
}

// IsPermanent 判断错误链里是否有 PermanentError。
func IsPermanent(err error) bool {
	var permanentErr *PermanentError
	return errors.As(err, &permanentErr)
}

func summarizeHTTPErrorBody(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err == nil {
		for _, key := range []string{"message", "error", "detail", "msg"} {
			if value, ok := payload[key]; ok {
				msg := strings.TrimSpace(fmt.Sprint(value))
				if msg != "" {
					return truncateHTTPErrorSummary(collapseHTTPErrorWhitespace(msg))
				}
			}
		}
	}

	if title := htmlTagText(text, "title"); title != "" {
		return truncateHTTPErrorSummary(collapseHTTPErrorWhitespace(title))
	}
	if h1 := htmlTagText(text, "h1"); h1 != "" {
		return truncateHTTPErrorSummary(collapseHTTPErrorWhitespace(h1))
	}

	return truncateHTTPErrorSummary(collapseHTTPErrorWhitespace(text))
}

func htmlTagText(text string, tag string) string {
	lower := strings.ToLower(text)
	open := "<" + tag
	start := strings.Index(lower, open)
	if start < 0 {
		return ""
	}
	gt := strings.Index(lower[start:], ">")
	if gt < 0 {
		return ""
	}
	contentStart := start + gt + 1
	closeTag := "</" + tag + ">"
	end := strings.Index(lower[contentStart:], closeTag)
	if end < 0 {
		return ""
	}
	return strings.TrimSpace(text[contentStart : contentStart+end])
}

func collapseHTTPErrorWhitespace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func truncateHTTPErrorSummary(s string) string {
	runes := []rune(s)
	if len(runes) <= maxHTTPErrorSummaryRunes {
		return s
	}
	return string(runes[:maxHTTPErrorSummaryRunes]) + "..."
}
