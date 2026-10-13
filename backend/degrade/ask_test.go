package degrade

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHasStandalone21(t *testing.T) {
	cases := map[string]bool{
		"答案是 21 个":    true,
		"**21**":      true,
		"21":          true,
		"最少 210 个":    false,
		"121 个":       false,
		"最少需要 29 个":   false,
		"先 9 个再 12 个": false,
	}
	for text, want := range cases {
		if got := HasStandalone21(text); got != want {
			t.Errorf("HasStandalone21(%q) = %v, want %v", text, got, want)
		}
	}
}

func TestCodexTurnLooksLikeNewSession(t *testing.T) {
	body, headers, err := CodexTurn("upstream-ops:1:2", "gpt-test", "low", "题目")
	if err != nil {
		t.Fatalf("CodexTurn: %v", err)
	}
	var req struct {
		Model     string `json:"model"`
		Stream    bool   `json:"stream"`
		Include   []string
		Reasoning map[string]string `json:"reasoning"`
		Input     []struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"input"`
		ClientMetadata map[string]string `json:"client_metadata"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("body is not json: %v", err)
	}
	if req.Model != "gpt-test" || !req.Stream || req.Reasoning["effort"] != "low" || req.Reasoning["context"] != "all_turns" {
		t.Fatalf("request = %+v", req)
	}
	if len(req.Include) != 1 || req.Include[0] != "reasoning.encrypted_content" {
		t.Fatalf("include = %v", req.Include)
	}
	if len(req.Input) < 4 || req.Input[0].Type != "additional_tools" {
		t.Fatalf("input must start with the tool list, got %d items", len(req.Input))
	}
	last := req.Input[len(req.Input)-1]
	if last.Role != "user" || len(last.Content) != 1 || last.Content[0].Text != "题目" {
		t.Fatalf("last input item = %+v", last)
	}
	if !strings.Contains(string(body), "<environment_context>") {
		t.Fatal("environment context must be sent unescaped")
	}
	if headers.Get("Originator") != "codex-tui" || headers.Get("X-Openai-Internal-Codex-Responses-Lite") != "true" ||
		headers.Get("Session-Id") == "" || headers.Get("Session-Id") != req.ClientMetadata["session_id"] {
		t.Fatalf("headers = %v", headers)
	}

	// 同一把密钥的安装 ID 每次都一样，会话 ID 每次都是新的
	_, again, _ := CodexTurn("upstream-ops:1:2", "gpt-test", "low", "题目")
	var meta, metaAgain map[string]any
	_ = json.Unmarshal([]byte(headers.Get("X-Codex-Turn-Metadata")), &meta)
	_ = json.Unmarshal([]byte(again.Get("X-Codex-Turn-Metadata")), &metaAgain)
	if meta["installation_id"] == nil || meta["installation_id"] != metaAgain["installation_id"] {
		t.Fatalf("installation id must be stable: %v vs %v", meta["installation_id"], metaAgain["installation_id"])
	}
	if headers.Get("Session-Id") == again.Get("Session-Id") {
		t.Fatal("every check must start a new session")
	}

	// 不指定推理强度时请求里不带 effort
	body, headers, _ = CodexTurn("x", "gpt-test", "", "题目")
	var bare struct {
		Reasoning map[string]string `json:"reasoning"`
	}
	_ = json.Unmarshal(body, &bare)
	if _, ok := bare.Reasoning["effort"]; ok || strings.Contains(headers.Get("X-Codex-Turn-Metadata"), "reasoning_effort") {
		t.Fatalf("empty effort must be omitted: %v / %s", bare.Reasoning, headers.Get("X-Codex-Turn-Metadata"))
	}
}

func sse(events ...string) string {
	var b strings.Builder
	for _, e := range events {
		b.WriteString("data: " + e + "\n\n")
	}
	return b.String()
}

func TestReadStream(t *testing.T) {
	message := `{"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"最少要取 21 个。"}]}}`
	completed := `{"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":100,"output_tokens":20,"output_tokens_details":{"reasoning_tokens":7}}}}`

	got, err := ReadStream(strings.NewReader(sse(message, completed)))
	if err != nil || got.Text != "最少要取 21 个。" || got.InputTokens != 100 || got.OutputTokens != 20 || got.ReasoningTokens != 7 {
		t.Fatalf("completed stream = %+v, %v", got, err)
	}

	cases := map[string]string{
		"中断":   sse(message),
		"出错":   sse(`{"type":"error","message":"boom"}`),
		"没写完":  sse(`{"type":"response.incomplete","response":{"status":"incomplete","output":[]}}`),
		"调工具":  sse(`{"type":"response.output_item.done","item":{"type":"function_call"}}`, completed),
		"没有文字": sse(completed),
	}
	for name, stream := range cases {
		if _, err := ReadStream(strings.NewReader(stream)); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestAskPostsToResponses(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, sse(
			`{"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"21"}]}}`,
			`{"type":"response.completed","response":{"status":"completed","output":[]}}`,
		))
	}))
	defer srv.Close()

	answer, _, err := Ask(context.Background(), srv.Client(), srv.URL+"/", "sk-test", "x", "gpt-test", "low", CandyPrompt)
	if err != nil || answer.Text != "21" {
		t.Fatalf("Ask = %+v, %v", answer, err)
	}
	if gotPath != "/v1/responses" || gotAuth != "Bearer sk-test" {
		t.Fatalf("path %q auth %q", gotPath, gotAuth)
	}
}

func TestAskReportsUpstreamStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"code":"model_not_found"}}`, http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	_, _, err := Ask(context.Background(), srv.Client(), srv.URL, "sk-test", "x", "gpt-test", "low", CandyPrompt)
	if err == nil || !strings.Contains(err.Error(), "503") || !strings.Contains(err.Error(), "model_not_found") || !ModelUnavailable(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestModelUnavailable(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{&StatusError{Code: 503, Body: `{"error":{"code":"model_not_found","message":"当前分组 default 下对于模型 gpt-x 无可用渠道"}}`}, true},
		{&StatusError{Code: 503, Body: `{"error":{"message":"No available channel for model gpt-x under group default"}}`}, true},
		{&StatusError{Code: 404, Body: `{"error":{"message":"The model gpt-x does not exist"}}`}, true},
		{&StatusError{Code: 400, Body: `{"error":{"message":"模型 gpt-x 不支持"}}`}, true},
		{&StatusError{Code: 503, Body: `{"error":{"message":"上游负载已饱和，请稍后再试"}}`}, false},
		{&StatusError{Code: 401, Body: `{"error":{"code":"model_not_found"}}`}, false},
		{&StatusError{Code: 400, Body: `{"error":{"message":"Unsupported parameter: reasoning"}}`}, false},
		{errors.New("请求中转站：context deadline exceeded"), false},
		{nil, false},
	}
	for _, tc := range cases {
		if got := ModelUnavailable(tc.err); got != tc.want {
			t.Errorf("ModelUnavailable(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestAskReportsRateLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		http.Error(w, `{"error":{"message":"user requests-per-minute limit exceeded","type":"rate_limit_exceeded"}}`, http.StatusTooManyRequests)
	}))
	defer srv.Close()
	_, _, err := Ask(context.Background(), srv.Client(), srv.URL, "sk-test", "x", "gpt-test", "low", CandyPrompt)
	if wait, ok := RateLimited(err); !ok || wait != 7*time.Second {
		t.Fatalf("RateLimited(%v) = %v, %v", err, wait, ok)
	}
}

func TestRateLimited(t *testing.T) {
	cases := []struct {
		err  error
		ok   bool
		wait time.Duration
	}{
		{&StatusError{Code: 429, Body: `{"error":{"message":"user requests-per-minute limit exceeded","type":"rate_limit_exceeded"}}`}, true, 0},
		{&StatusError{Code: 429, Body: `{"error":{"message":"您已达到请求数限制：1分钟内最多请求2次"}}`, RetryAfter: 30 * time.Second}, true, 30 * time.Second},
		{&StatusError{Code: 429, Body: `{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}`}, false, 0},
		{&StatusError{Code: 503, Body: `{"error":{"message":"上游负载已饱和，请稍后再试"}}`}, false, 0},
		{errors.New("请求中转站：context deadline exceeded"), false, 0},
		{nil, false, 0},
	}
	for _, tc := range cases {
		if wait, ok := RateLimited(tc.err); ok != tc.ok || wait != tc.wait {
			t.Errorf("RateLimited(%v) = %v, %v, want %v, %v", tc.err, wait, ok, tc.wait, tc.ok)
		}
	}
}

func TestRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 13, 14, 15, 48, 0, time.UTC)
	cases := map[string]time.Duration{
		"":                              0,
		"60":                            time.Minute,
		" 5 ":                           5 * time.Second,
		"-3":                            0,
		"Tue, 13 Oct 2026 14:16:18 GMT": 30 * time.Second,
		"Tue, 13 Oct 2026 14:00:00 GMT": 0,
		"soon":                          0,
	}
	for v, want := range cases {
		if got := retryAfter(v, now); got != want {
			t.Errorf("retryAfter(%q) = %v, want %v", v, got, want)
		}
	}
}

func TestListModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer sk-test" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"data":[{"id":"gpt-b"},{"id":"gpt-a"},{"id":"gpt-b"}]}`)
	}))
	defer srv.Close()
	models, err := ListModels(context.Background(), srv.Client(), srv.URL, "sk-test")
	if err != nil || strings.Join(models, ",") != "gpt-a,gpt-b" {
		t.Fatalf("models = %v, %v", models, err)
	}
}
