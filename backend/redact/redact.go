// Package redact 把错误信息里夹带的通知渠道密钥抹掉，再写日志或落库。
//
// Go 的 HTTP 客户端出错时会把完整请求 URL 拼进错误信息（*url.Error），
// Telegram 的 bot token 和企业微信机器人的 key 都在 URL 里，不处理就会原样进日志。
package redact

import "regexp"

const mask = "***"

var patterns = []*regexp.Regexp{
	// https://api.telegram.org/bot<token>/sendMessage、/file/bot<token>/...
	regexp.MustCompile(`(?i)(api\.telegram\.org/(?:file/)?bot)[^/\s"']+`),
	// 企业微信机器人 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>
	regexp.MustCompile(`(?i)([?&]key=)[^&\s"']+`),
}

// Secrets 返回抹掉已知密钥后的文本。
func Secrets(s string) string {
	for _, re := range patterns {
		s = re.ReplaceAllString(s, "${1}"+mask)
	}
	return s
}
