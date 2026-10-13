package captcha

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/bejix/upstream-ops/backend/crypto"
	"github.com/bejix/upstream-ops/backend/storage"
	"github.com/go-resty/resty/v2"
)

type BalanceResult struct {
	Balance float64 `json:"balance"`
	Unit    string  `json:"unit"`
}

type BalanceRefreshResult struct {
	Config *storage.CaptchaConfig
	Error  error
}

type balanceResp struct {
	ErrorID          int      `json:"errorId"`
	ErrorCode        string   `json:"errorCode"`
	ErrorDescription string   `json:"errorDescription"`
	Balance          *float64 `json:"balance"`
}

func FetchBalance(ctx context.Context, cfg *storage.CaptchaConfig, apiKey string) (*BalanceResult, error) {
	if cfg == nil {
		return nil, errors.New("captcha config is nil")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("%s: api key is empty", cfg.Type)
	}
	base, unit, err := balanceEndpoint(cfg)
	if err != nil {
		return nil, err
	}
	client := resty.New().SetTimeout(30 * time.Second)
	resp, err := client.R().
		SetContext(ctx).
		SetHeader("Content-Type", "application/json").
		SetBody(map[string]any{"clientKey": apiKey}).
		Post(strings.TrimRight(base, "/") + "/getBalance")
	if err != nil {
		return nil, fmt.Errorf("%s getBalance http: %w", cfg.Type, err)
	}
	var r balanceResp
	if err := json.Unmarshal(resp.Body(), &r); err != nil {
		return nil, fmt.Errorf("%s getBalance decode: %w", cfg.Type, err)
	}
	if r.ErrorID != 0 {
		msg := strings.TrimSpace(r.ErrorCode + " " + r.ErrorDescription)
		if msg == "" {
			msg = fmt.Sprintf("errorId=%d", r.ErrorID)
		}
		return nil, fmt.Errorf("%s getBalance: %s", cfg.Type, msg)
	}
	if r.Balance == nil {
		return nil, fmt.Errorf("%s getBalance: missing balance", cfg.Type)
	}
	return &BalanceResult{Balance: *r.Balance, Unit: unit}, nil
}

func RefreshBalance(ctx context.Context, repo *storage.Captchas, cipher *crypto.Cipher, cfg *storage.CaptchaConfig) (*storage.CaptchaConfig, error) {
	apiKey, err := cipher.Decrypt(cfg.APIKeyCipher)
	if err != nil {
		return cfg, err
	}

	now := time.Now()
	res, err := FetchBalance(ctx, cfg, apiKey)
	if err != nil {
		_ = repo.UpdateBalance(cfg.ID, cfg.LastBalance, cfg.BalanceUnit, err.Error(), now)
		cfg.BalanceAt = &now
		cfg.BalanceError = err.Error()
		return cfg, err
	}

	balance := res.Balance
	if err := repo.UpdateBalance(cfg.ID, &balance, res.Unit, "", now); err != nil {
		return cfg, err
	}
	cfg.LastBalance = &balance
	cfg.BalanceUnit = res.Unit
	cfg.BalanceAt = &now
	cfg.BalanceError = ""
	return cfg, nil
}

func RefreshAllBalances(ctx context.Context, repo *storage.Captchas, cipher *crypto.Cipher, log *slog.Logger) ([]BalanceRefreshResult, error) {
	list, err := repo.List()
	if err != nil {
		return nil, err
	}
	results := make([]BalanceRefreshResult, 0, len(list))
	for i := range list {
		cfg := &list[i]
		updated, err := RefreshBalance(ctx, repo, cipher, cfg)
		if err != nil && log != nil {
			log.Warn("refresh captcha balance failed", "captcha", cfg.Name, "type", cfg.Type, "err", err)
		}
		results = append(results, BalanceRefreshResult{Config: updated, Error: err})
	}
	return results, nil
}

func balanceEndpoint(cfg *storage.CaptchaConfig) (string, string, error) {
	if cfg.Type != storage.CaptchaYesCaptcha {
		return "", "", fmt.Errorf("unknown captcha provider: %s", cfg.Type)
	}
	if cfg.Endpoint != "" {
		return cfg.Endpoint, "points", nil
	}
	return "https://api.yescaptcha.com", "points", nil
}
