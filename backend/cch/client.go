// Package cch 把上游分组倍率同步到 Claude Code Hub（CCH）供应商的成本倍率。
//
// 只用到 CCH 管理接口 /api/v1 里的两个：列出供应商、修改单个供应商。
// 鉴权用 Authorization: Bearer <ADMIN_TOKEN>；令牌鉴权不走 CSRF 校验（CCH 只对 Cookie 会话校验）。
package cch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-resty/resty/v2"
)

// Provider 是 CCH 供应商列表里同步要用的字段。MaskedKey 形如 "sk-a••••••wxyz"（首尾各 4 位）。
type Provider struct {
	ID             int64   `json:"id"`
	Name           string  `json:"name"`
	URL            string  `json:"url"`
	MaskedKey      string  `json:"maskedKey"`
	IsEnabled      bool    `json:"isEnabled"`
	CostMultiplier float64 `json:"costMultiplier"`
}

// APIError 是 CCH 返回的非 2xx 响应，Detail / Code 取自它的 problem+json。
type APIError struct {
	Status int
	Code   string
	Detail string
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("CCH 返回 %d", e.Status)
	if e.Code != "" {
		msg += " " + e.Code
	}
	if e.Detail != "" {
		msg += "：" + e.Detail
	}
	if e.Unauthorized() {
		msg += "（管理令牌无效或权限不足，请到设置页检查 CCH 令牌）"
	}
	return msg
}

// Unauthorized 表示令牌不对或不是管理员，不改配置不会自己好。
func (e *APIError) Unauthorized() bool {
	return e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden
}

// IsUnauthorized 判断错误链里是否有 CCH 的 401 / 403。
func IsUnauthorized(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Unauthorized()
}

type Client struct {
	baseURL string
	token   string
	http    *resty.Client
}

// NormalizeBaseURL 去掉末尾的 / 和多填的 /api/v1，校验是 http(s) 地址。
func NormalizeBaseURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	s = strings.TrimRight(s, "/")
	s = strings.TrimSuffix(s, "/api/v1")
	s = strings.TrimRight(s, "/")
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("CCH 地址要以 http:// 或 https:// 开头，如 https://cch.example.com")
	}
	return s, nil
}

func NewClient(baseURL, token string, timeout time.Duration, userAgent string) *Client {
	h := resty.New().SetTimeout(timeout)
	if userAgent != "" {
		h.SetHeader("User-Agent", userAgent)
	}
	return &Client{baseURL: baseURL, token: token, http: h}
}

func (c *Client) request(ctx context.Context) *resty.Request {
	return c.http.R().
		SetContext(ctx).
		SetHeader("Accept", "application/json").
		SetAuthToken(c.token)
}

// ListProviders 列出全部供应商（含已停用的）。
func (c *Client) ListProviders(ctx context.Context) ([]Provider, error) {
	resp, err := c.request(ctx).Get(c.baseURL + "/api/v1/providers")
	if err != nil {
		return nil, fmt.Errorf("请求 CCH 供应商列表：%w", requestError(err))
	}
	if resp.IsError() {
		return nil, apiError(resp)
	}
	var body struct {
		Items []Provider `json:"items"`
	}
	if err := json.Unmarshal(resp.Body(), &body); err != nil {
		return nil, fmt.Errorf("解析 CCH 供应商列表：%w", err)
	}
	return body.Items, nil
}

// SetCostMultiplier 只改一个供应商的成本倍率，其它字段不动。
func (c *Client) SetCostMultiplier(ctx context.Context, id int64, value float64) error {
	resp, err := c.request(ctx).
		SetHeader("Content-Type", "application/json").
		SetBody(map[string]float64{"cost_multiplier": value}).
		Patch(c.baseURL + "/api/v1/providers/" + strconv.FormatInt(id, 10))
	if err != nil {
		return fmt.Errorf("请求修改 CCH 供应商：%w", requestError(err))
	}
	if resp.IsError() {
		return apiError(resp)
	}
	return nil
}

func apiError(resp *resty.Response) error {
	out := &APIError{Status: resp.StatusCode()}
	var problem struct {
		Detail    string `json:"detail"`
		ErrorCode string `json:"errorCode"`
	}
	if json.Unmarshal(resp.Body(), &problem) == nil {
		out.Code = problem.ErrorCode
		out.Detail = problem.Detail
	}
	if out.Code == "" && out.Detail == "" {
		text := strings.TrimSpace(string(resp.Body()))
		if r := []rune(text); len(r) > 200 {
			text = string(r[:200])
		}
		out.Detail = text
	}
	return out
}

// requestError 去掉 resty 错误里的请求 URL，只留底层原因。
func requestError(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}
