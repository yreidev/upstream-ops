package storage

import "testing"

// 带 default:true 的布尔字段，新建时传 false 也要原样落库，不能被换成默认值。
func TestCreateKeepsFalseForDefaultTrueFields(t *testing.T) {
	db := openTestDB(t)

	ch := &Channel{Name: "paused", Type: ChannelTypeNewAPI, SiteURL: "https://a.example.com", PasswordCipher: "x", MonitorEnabled: false}
	if err := NewChannels(db).Create(ch); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	var gotCh Channel
	if err := db.First(&gotCh, ch.ID).Error; err != nil {
		t.Fatalf("load channel: %v", err)
	}
	if gotCh.MonitorEnabled {
		t.Errorf("channel monitor_enabled = true, want false")
	}

	nc := &NotificationChannel{Name: "off", Type: NotifyTelegram, ConfigCipher: "x", Subscriptions: "[]", Enabled: false}
	if err := NewNotifications(db).CreateChannel(nc); err != nil {
		t.Fatalf("create notification channel: %v", err)
	}
	var gotNC NotificationChannel
	if err := db.First(&gotNC, nc.ID).Error; err != nil {
		t.Fatalf("load notification channel: %v", err)
	}
	if gotNC.Enabled {
		t.Errorf("notification channel enabled = true, want false")
	}

	cc := &CaptchaConfig{Name: "off", Type: CaptchaYesCaptcha, APIKeyCipher: "x", Enabled: false}
	if err := NewCaptchas(db).Create(cc); err != nil {
		t.Fatalf("create captcha config: %v", err)
	}
	var gotCC CaptchaConfig
	if err := db.First(&gotCC, cc.ID).Error; err != nil {
		t.Fatalf("load captcha config: %v", err)
	}
	if gotCC.Enabled {
		t.Errorf("captcha config enabled = true, want false")
	}

	// 默认值仍然生效：没写 false 的字段照常是 true
	on := &Channel{Name: "on", Type: ChannelTypeNewAPI, SiteURL: "https://b.example.com", PasswordCipher: "x", MonitorEnabled: true}
	if err := NewChannels(db).Create(on); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	var gotOn Channel
	if err := db.First(&gotOn, on.ID).Error; err != nil {
		t.Fatalf("load channel: %v", err)
	}
	if !gotOn.MonitorEnabled {
		t.Errorf("channel monitor_enabled = false, want true")
	}
}
