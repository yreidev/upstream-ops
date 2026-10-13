package captcha

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-resty/resty/v2"
	"github.com/yreidev/upstream-ops/backend/storage"
)

func init() {
	Register(storage.CaptchaYesCaptcha, func(c Config) Provider { return newYesCaptcha(c) })
}

// yesCaptcha 对接 https://yescaptcha.com 的 TurnstileTaskProxyless。
//
// 走 createTask + getTaskResult JSON API：
//
//	POST /createTask     -> { errorId, taskId }
//	POST /getTaskResult  -> { status: "ready", solution: { token } } 或 status: "processing"
//
// 在拿到 ready 之前每 2 秒轮询一次，最多 ~120 秒。
type yesCaptcha struct {
	cfg          Config
	http         *resty.Client
	base         string
	pollInterval time.Duration
}

func newYesCaptcha(c Config) *yesCaptcha {
	base := c.Endpoint
	if base == "" {
		base = "https://api.yescaptcha.com"
	}
	return &yesCaptcha{
		cfg:          c,
		http:         resty.New().SetTimeout(30 * time.Second),
		base:         base,
		pollInterval: 2 * time.Second,
	}
}

type yesCaptchaCreateResp struct {
	ErrorID          int    `json:"errorId"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
	TaskID           any    `json:"taskId"` // 兼容 string / number
}

type yesCaptchaResultResp struct {
	ErrorID          int    `json:"errorId"`
	ErrorCode        string `json:"errorCode"`
	ErrorDescription string `json:"errorDescription"`
	Status           string `json:"status"` // "ready" | "processing"
	Solution         struct {
		Token string `json:"token"`
	} `json:"solution"`
}

// APIError 是打码平台返回的业务错误（errorId != 0）。
type APIError struct {
	Op          string // createTask / getTaskResult
	Code        string
	Description string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("yescaptcha %s: %s %s", e.Op, e.Code, e.Description)
}

// Permanent 表示不处理就不会好的错误：账户余额不足，充值前每次求解都会失败。
func (e *APIError) Permanent() bool {
	return e.Code == "ERROR_ZERO_BALANCE"
}

func (p *yesCaptcha) SolveTurnstile(ctx context.Context, siteKey, pageURL string) (string, error) {
	if p.cfg.APIKey == "" {
		return "", errors.New("yescaptcha: api key is empty")
	}
	if siteKey == "" {
		return "", errors.New("yescaptcha: siteKey is empty")
	}

	taskID, err := p.createTask(ctx, siteKey, pageURL)
	if err != nil {
		return "", err
	}

	deadline := time.Now().Add(120 * time.Second)
	ticker := time.NewTicker(p.pollInterval)
	defer ticker.Stop()

	// 轮询时网关偶发 5xx / HTML 错误页不代表任务失败（任务已经扣费），继续轮询到超时；
	// 平台明确返回 errorId 才放弃。
	var lastPollErr error
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ticker.C:
			if time.Now().After(deadline) {
				if lastPollErr != nil {
					return "", fmt.Errorf("yescaptcha: timed out waiting for solution (last error: %w)", lastPollErr)
				}
				return "", errors.New("yescaptcha: timed out waiting for solution")
			}
			token, ready, err := p.fetchResult(ctx, taskID)
			if err != nil {
				var apiErr *APIError
				if errors.As(err, &apiErr) || ctx.Err() != nil {
					return "", err
				}
				lastPollErr = err
				continue
			}
			if ready {
				return token, nil
			}
		}
	}
}

func (p *yesCaptcha) createTask(ctx context.Context, siteKey, pageURL string) (string, error) {
	body := map[string]any{
		"clientKey": p.cfg.APIKey,
		"task": map[string]any{
			"type":       "TurnstileTaskProxyless",
			"websiteURL": pageURL,
			"websiteKey": siteKey,
		},
	}
	resp, err := p.http.R().
		SetContext(ctx).
		SetHeader("Content-Type", "application/json").
		SetBody(body).
		Post(p.base + "/createTask")
	if err != nil {
		return "", fmt.Errorf("yescaptcha createTask http: %w", err)
	}
	var r yesCaptchaCreateResp
	if err := json.Unmarshal(resp.Body(), &r); err != nil {
		if resp.IsError() {
			return "", fmt.Errorf("yescaptcha createTask: %s", resp.Status())
		}
		return "", fmt.Errorf("yescaptcha createTask decode: %w", err)
	}
	if r.ErrorID != 0 {
		return "", &APIError{Op: "createTask", Code: r.ErrorCode, Description: r.ErrorDescription}
	}
	if r.TaskID == nil {
		if resp.IsError() {
			return "", fmt.Errorf("yescaptcha createTask: %s", resp.Status())
		}
		return "", errors.New("yescaptcha createTask: missing taskId")
	}
	switch v := r.TaskID.(type) {
	case string:
		if v == "" {
			return "", errors.New("yescaptcha createTask: empty taskId")
		}
		return v, nil
	case float64:
		return fmt.Sprintf("%.0f", v), nil
	default:
		return fmt.Sprint(v), nil
	}
}

func (p *yesCaptcha) fetchResult(ctx context.Context, taskID string) (string, bool, error) {
	resp, err := p.http.R().
		SetContext(ctx).
		SetHeader("Content-Type", "application/json").
		SetBody(map[string]any{
			"clientKey": p.cfg.APIKey,
			"taskId":    taskID,
		}).
		Post(p.base + "/getTaskResult")
	if err != nil {
		return "", false, fmt.Errorf("yescaptcha getTaskResult http: %w", err)
	}
	var r yesCaptchaResultResp
	if err := json.Unmarshal(resp.Body(), &r); err != nil {
		if resp.IsError() {
			return "", false, fmt.Errorf("yescaptcha getTaskResult: %s", resp.Status())
		}
		return "", false, fmt.Errorf("yescaptcha getTaskResult decode: %w", err)
	}
	if r.ErrorID != 0 {
		return "", false, &APIError{Op: "getTaskResult", Code: r.ErrorCode, Description: r.ErrorDescription}
	}
	if r.Status == "ready" {
		if r.Solution.Token == "" {
			return "", false, errors.New("yescaptcha: ready but empty token")
		}
		return r.Solution.Token, true, nil
	}
	return "", false, nil
}
