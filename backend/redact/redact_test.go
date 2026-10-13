package redact

import "testing"

func TestSecrets(t *testing.T) {
	cases := map[string]string{
		`Post "https://api.telegram.org/bot123456:AAH-x_y/sendMessage": context deadline exceeded`: `Post "https://api.telegram.org/bot***/sendMessage": context deadline exceeded`,
		`Get "https://api.telegram.org/file/bot123:abc/photos/1.jpg": EOF`:                         `Get "https://api.telegram.org/file/bot***/photos/1.jpg": EOF`,
		`Post "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0a1b-2c3d": i/o timeout`:       `Post "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***": i/o timeout`,
		`https://example.com/hook?a=1&key=secret&b=2`:                                              `https://example.com/hook?a=1&key=***&b=2`,
		`status 502: Bad Gateway`: `status 502: Bad Gateway`,
		`telegram 请求失败: dial tcp: lookup api.telegram.org: i/o timeout`: `telegram 请求失败: dial tcp: lookup api.telegram.org: i/o timeout`,
	}
	for in, want := range cases {
		if got := Secrets(in); got != want {
			t.Errorf("Secrets(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}
