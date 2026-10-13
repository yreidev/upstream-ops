// 事件流解析、糖果题题面和判定移植自 haowang02/cpa-plugin-codex-candy-eval（MIT 许可，见 codex.go 开头）。

package degrade

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// CandyPrompt 是糖果题，正确答案是 21。
const CandyPrompt = `不使用任何外部工具回答以下问题：

在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

        苹果味  桃子味  西瓜味
圆形       7      9      8
五角星形   7      6      4
`

// HasStandalone21 判断回答里有没有前后都不挨着数字的 21，有就算答对。
func HasStandalone21(text string) bool {
	isDigit := func(i int) bool { return i >= 0 && i < len(text) && text[i] >= '0' && text[i] <= '9' }
	for i := 0; i+1 < len(text); i++ {
		if text[i] == '2' && text[i+1] == '1' && !isDigit(i-1) && !isDigit(i+2) {
			return true
		}
	}
	return false
}

// Answer 是一次回答的文字和 token 用量。
type Answer struct {
	Text            string
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
}

// maxStreamBytes 事件流最多读多少；模型复读停不下来时靠超时和这个上限截断。
const maxStreamBytes = 32 << 20

// Ask 以 Codex 新会话的形式向 baseURL/v1/responses 发 prompt，读完事件流后返回回答和耗时。
// 模型没回答完、调了工具或没给文字时返回错误，同时带回已知的 token 用量。
func Ask(ctx context.Context, client *http.Client, baseURL, apiKey, installation, model, effort, prompt string) (Answer, time.Duration, error) {
	body, headers, err := CodexTurn(installation, model, effort, prompt)
	if err != nil {
		return Answer{}, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/v1/responses", bytes.NewReader(body))
	if err != nil {
		return Answer{}, 0, err
	}
	req.Header = headers
	req.Header.Set("Authorization", "Bearer "+apiKey)
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return Answer{}, time.Since(start), fmt.Errorf("请求中转站：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return Answer{}, time.Since(start), statusError(resp)
	}
	out, err := ReadStream(io.LimitReader(resp.Body, maxStreamBytes))
	return out, time.Since(start), err
}

// StatusError 是中转站返回的非 2xx 响应；RetryAfter 是响应头 Retry-After 要求等的时间，没给时为 0。
type StatusError struct {
	Code       int
	Body       string
	RetryAfter time.Duration
}

func (e *StatusError) Error() string { return fmt.Sprintf("中转站返回 %d：%s", e.Code, e.Body) }

func statusError(resp *http.Response) *StatusError {
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return &StatusError{
		Code:       resp.StatusCode,
		Body:       truncate(strings.TrimSpace(string(snippet)), 500),
		RetryAfter: retryAfter(resp.Header.Get("Retry-After"), time.Now()),
	}
}

// retryAfter 解析 Retry-After：秒数或 HTTP 日期，解析不了时返回 0。
func retryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	if n, err := strconv.Atoi(v); err == nil {
		return max(time.Duration(n)*time.Second, 0)
	}
	if t, err := http.ParseTime(v); err == nil {
		return max(t.Sub(now), 0)
	}
	return 0
}

// RateLimited 判断这次请求是不是被中转站限流（429），过一会儿再发就行；额度用完的 429 不算，等了也没用。
func RateLimited(err error) (wait time.Duration, ok bool) {
	var se *StatusError
	if !errors.As(err, &se) || se.Code != http.StatusTooManyRequests {
		return 0, false
	}
	body := strings.ToLower(se.Body)
	for _, s := range []string{"insufficient_quota", "exceeded your current quota", "额度不足", "余额不足"} {
		if strings.Contains(body, s) {
			return 0, false
		}
	}
	return se.RetryAfter, true
}

// ModelUnavailable 判断这次请求失败是不是因为分组里没有这个模型，这时可以换下一个备选模型。
// NewAPI 返回 503、错误码 model_not_found（“当前分组 … 下对于模型 … 无可用渠道”）；其他站点按常见写法认。
func ModelUnavailable(err error) bool {
	var se *StatusError
	if !errors.As(err, &se) {
		return false
	}
	switch se.Code {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusServiceUnavailable:
	default:
		return false
	}
	body := strings.ToLower(se.Body)
	if strings.Contains(body, "model_not_found") || strings.Contains(body, "无可用渠道") || strings.Contains(body, "no available channel") {
		return true
	}
	if !strings.Contains(body, "model") && !strings.Contains(body, "模型") {
		return false
	}
	for _, s := range []string{"not found", "does not exist", "not supported", "not available", "不存在", "不支持"} {
		if strings.Contains(body, s) {
			return true
		}
	}
	return false
}

type responseItem struct {
	Type    string `json:"type"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

type responseBody struct {
	Status string          `json:"status"`
	Error  json.RawMessage `json:"error"`
	Output []responseItem  `json:"output"`
	Usage  struct {
		InputTokens         int64 `json:"input_tokens"`
		OutputTokens        int64 `json:"output_tokens"`
		OutputTokensDetails struct {
			ReasoningTokens int64 `json:"reasoning_tokens"`
		} `json:"output_tokens_details"`
	} `json:"usage"`
}

// ListModels 用这把密钥请求 baseURL/v1/models，列出分组里能用的模型，不扣费。
func ListModels(ctx context.Context, client *http.Client, baseURL, apiKey string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求中转站：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, statusError(resp)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("解析模型列表失败：%w", err)
	}
	models := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		if id := strings.TrimSpace(m.ID); id != "" && !slices.Contains(models, id) {
			models = append(models, id)
		}
	}
	slices.Sort(models)
	return models, nil
}

// ReadStream 读完 Responses 事件流，取出最终回答和 token 用量。
func ReadStream(r io.Reader) (Answer, error) {
	var (
		out   responseBody
		items []responseItem
		final bool
	)
	reader := bufio.NewReader(r)
	for {
		line, readErr := reader.ReadBytes('\n')
		if data, ok := bytes.CutPrefix(bytes.TrimSpace(line), []byte("data:")); ok {
			var event struct {
				Type     string          `json:"type"`
				Response json.RawMessage `json:"response"`
				Item     json.RawMessage `json:"item"`
			}
			if json.Unmarshal(data, &event) == nil {
				switch event.Type {
				case "response.output_item.done":
					var item responseItem
					if json.Unmarshal(event.Item, &item) == nil {
						items = append(items, item)
					}
				case "response.completed", "response.incomplete", "response.failed":
					if err := json.Unmarshal(event.Response, &out); err != nil {
						return Answer{}, fmt.Errorf("解析模型响应失败：%w", err)
					}
					final = true
				case "error":
					return Answer{}, fmt.Errorf("模型返回错误：%s", truncate(string(bytes.TrimSpace(data)), 500))
				}
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return Answer{}, fmt.Errorf("读取模型响应流：%w", readErr)
			}
			break
		}
	}
	if !final {
		return Answer{}, errors.New("模型响应流在完成前中断")
	}
	// Codex 的事件流会逐个推送输出项，最终响应里的 output 可能是空的
	if len(out.Output) == 0 {
		out.Output = items
	}
	answer := Answer{
		InputTokens:     out.Usage.InputTokens,
		OutputTokens:    out.Usage.OutputTokens,
		ReasoningTokens: out.Usage.OutputTokensDetails.ReasoningTokens,
	}
	if (out.Status != "" && out.Status != "completed") || (len(out.Error) > 0 && string(out.Error) != "null") {
		return answer, fmt.Errorf("模型响应未完成（%s）：%s", out.Status, truncate(string(out.Error), 500))
	}
	var text strings.Builder
	for _, item := range out.Output {
		if item.Type != "message" {
			continue
		}
		for _, part := range item.Content {
			if part.Type == "output_text" || part.Type == "text" {
				text.WriteString(part.Text)
			}
		}
	}
	answer.Text = text.String()
	if strings.TrimSpace(answer.Text) == "" {
		// Codex 请求带着工具列表，function_call、custom_tool_call 这类输出项表示模型想调工具
		if slices.ContainsFunc(out.Output, func(item responseItem) bool { return strings.HasSuffix(item.Type, "_call") }) {
			return answer, errors.New("模型调用了工具，没有直接回答")
		}
		return answer, errors.New("模型没有返回文字")
	}
	return answer, nil
}

// truncate 按字符截断，超出时加省略号。
func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max]) + "…"
}
