package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/channel"
	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/storage"
)

type rechargeChannelServiceStub struct {
	*channel.Service
	info   *connector.RechargeInfo
	launch *connector.RechargeLaunch
}

func (s *rechargeChannelServiceStub) GetRechargeInfo(ctx context.Context, channelID uint) (*connector.RechargeInfo, error) {
	return s.info, nil
}

func (s *rechargeChannelServiceStub) CreateRecharge(ctx context.Context, channelID uint, req connector.RechargeRequest) (*connector.RechargeLaunch, error) {
	return s.launch, nil
}

func TestChannelRechargeEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)

	db := openTestDB(t)
	channels := storage.NewChannels(db)
	if err := channels.Create(&storage.Channel{
		Name:           "a",
		Type:           storage.ChannelTypeNewAPI,
		SiteURL:        "https://a.example.com",
		Username:       "u1",
		PasswordCipher: "x",
		MonitorEnabled: true,
	}); err != nil {
		t.Fatalf("create channel: %v", err)
	}

	r := gin.New()
	apiGroup := r.Group("/api")
	stub := &rechargeChannelServiceStub{
		info: &connector.RechargeInfo{
			AmountLabel:   "充值金额",
			AmountStep:    0.01,
			MinAmount:     5,
			PresetAmounts: []float64{10, 20},
			Methods: []connector.RechargeMethod{
				{Type: "alipay", Name: "支付宝", MinAmount: 5},
			},
		},
		launch: &connector.RechargeLaunch{
			Mode:   "redirect",
			PayURL: "https://pay.example.com/go",
		},
	}
	registerChannels(apiGroup, &Deps{
		Channels:   channels,
		ChannelSvc: stub,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/channels/1/recharge-info", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("info status = %d body = %s", rec.Code, rec.Body.String())
	}

	var infoResp struct {
		Data struct {
			AmountLabel string `json:"amount_label"`
			Methods     []struct {
				Type string `json:"type"`
			} `json:"methods"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &infoResp); err != nil {
		t.Fatalf("decode info: %v", err)
	}
	if infoResp.Data.AmountLabel != "充值金额" || len(infoResp.Data.Methods) != 1 || infoResp.Data.Methods[0].Type != "alipay" {
		t.Fatalf("unexpected info: %#v", infoResp.Data)
	}

	postReq := httptest.NewRequest(http.MethodPost, "/api/channels/1/recharge", strings.NewReader(`{"amount":12.5,"payment_method":"alipay","is_mobile":true}`))
	postReq.Header.Set("Content-Type", "application/json")
	postRec := httptest.NewRecorder()
	r.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusOK {
		t.Fatalf("recharge status = %d body = %s", postRec.Code, postRec.Body.String())
	}
	var launchResp struct {
		Data struct {
			Mode   string `json:"mode"`
			PayURL string `json:"pay_url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(postRec.Body.Bytes(), &launchResp); err != nil {
		t.Fatalf("decode launch: %v", err)
	}
	if launchResp.Data.Mode != "redirect" || launchResp.Data.PayURL != "https://pay.example.com/go" {
		t.Fatalf("unexpected launch: %#v", launchResp.Data)
	}

}
