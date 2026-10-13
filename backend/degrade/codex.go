// Codex 请求构造和 data/codex_context.json 移植自 haowang02/cpa-plugin-codex-candy-eval
// （提交 0de3802，MIT 许可，Copyright (c) 2026 Hao Wang），许可全文见 data/LICENSE-cpa-plugin-codex-candy-eval。
// 改动：安装 ID 按渠道和密钥生成，请求发往中转站的 /v1/responses，不经过 CPA。

package degrade

import (
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// 一次检测模拟 codex-tui 0.160.0 在 Responses Lite 上新开会话的第一个请求。data/codex_context.json 是这个客户端的
// 工具列表、基础指令和本轮上下文，取自一次抓包，机器路径已换成 /home/user/workspace。
const (
	codexUserAgent   = "codex-tui/0.160.0 (Ubuntu 26.4.0; aarch64) ghostty/1.3.1 (codex-tui; 0.160.0)"
	codexEnvironment = `<environment_context>
  <cwd>/home/user/workspace</cwd>
  <shell>bash</shell>
  <current_date>%s</current_date>
  <timezone>Etc/UTC</timezone>
  <filesystem><workspace_roots><root>/home/user/workspace</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>/home/user/workspace</path></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry><entry access="read"><path>/home/user/workspace/.git</path></entry><entry access="read"><path>/home/user/workspace/.agents</path></entry><entry access="read"><path>/home/user/workspace/.codex</path></entry><entry access="read"><path>/home/user/workspace/.aws</path></entry></file_system></permission_profile></filesystem>
</environment_context>`
)

// codexText 是上下文消息里的一段文字，Kind 是 Codex 给这段内容标的类型。
type codexText struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

//go:embed data/codex_context.json
var codexContextJSON []byte

var codexContext = func() (ctx struct {
	Tools            json.RawMessage `json:"tools"`
	BaseInstructions string          `json:"base_instructions"`
	Messages         []struct {
		Role    string      `json:"role"`
		Content []codexText `json:"content"`
	} `json:"messages"`
}) {
	if err := json.Unmarshal(codexContextJSON, &ctx); err != nil {
		panic(err)
	}
	return ctx
}()

// codexTools 是 Codex 发出去的工具列表原样字节，工具项的 ID 按这些字节算。
var codexTools = func() []byte {
	var tools bytes.Buffer
	if err := json.Compact(&tools, codexContext.Tools); err != nil {
		panic(err)
	}
	return tools.Bytes()
}()

type codexItem struct {
	Type     string             `json:"type"`
	ID       string             `json:"id"`
	Role     string             `json:"role"`
	Tools    json.RawMessage    `json:"tools,omitempty"`
	Content  []codexContent     `json:"content,omitempty"`
	Metadata *codexItemMetadata `json:"internal_chat_message_metadata_passthrough,omitempty"`
}

type codexContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type codexItemMetadata struct {
	TurnID           string   `json:"turn_id,omitempty"`
	CreateTime       float64  `json:"create_time,omitempty"`
	ContentItemKinds []string `json:"content_item_kinds"`
}

type codexReasoning struct {
	Effort  string `json:"effort,omitempty"`
	Context string `json:"context"`
}

type codexClientMetadata struct {
	ThreadID       string `json:"thread_id"`
	WindowID       string `json:"x-codex-window-id"`
	TurnID         string `json:"turn_id"`
	RootTurnID     string `json:"root_turn_id"`
	TurnMetadata   string `json:"x-codex-turn-metadata"`
	InstallationID string `json:"x-codex-installation-id"`
	SessionID      string `json:"session_id"`
}

type codexRequest struct {
	Model             string              `json:"model"`
	Input             []codexItem         `json:"input"`
	ToolChoice        string              `json:"tool_choice"`
	ParallelToolCalls bool                `json:"parallel_tool_calls"`
	Reasoning         codexReasoning      `json:"reasoning"`
	Store             bool                `json:"store"`
	Stream            bool                `json:"stream"`
	Include           []string            `json:"include"`
	PromptCacheKey    string              `json:"prompt_cache_key"`
	Text              map[string]string   `json:"text"`
	ClientMetadata    codexClientMetadata `json:"client_metadata"`
}

type codexTurnMetadata struct {
	InstallationID             string `json:"installation_id"`
	SessionID                  string `json:"session_id"`
	ThreadID                   string `json:"thread_id"`
	AgentName                  string `json:"agent_name"`
	TurnID                     string `json:"turn_id"`
	WindowID                   string `json:"window_id"`
	WindowNumber               int    `json:"window_number"`
	ContextWindowID            string `json:"context_window_id"`
	RequestKind                string `json:"request_kind"`
	RootTurnID                 string `json:"root_turn_id"`
	ThreadSource               string `json:"thread_source"`
	TurnTrigger                string `json:"turn_trigger"`
	Sandbox                    string `json:"sandbox"`
	SandboxMode                string `json:"sandbox_mode"`
	AutoReviewEnabled          bool   `json:"auto_review_enabled"`
	NodeReplAutoReviewRequired bool   `json:"node_repl_auto_review_required"`
	NodeReplDisabled           bool   `json:"node_repl_disabled"`
	TurnStartedAtUnixMS        int64  `json:"turn_started_at_unix_ms"`
	AnalyticsEnabled           bool   `json:"analytics_enabled"`
	Model                      string `json:"model"`
	ReasoningEffort            string `json:"reasoning_effort,omitempty"`
}

// CodexTurn 返回一个新 Codex 会话的请求体和请求头，第一条用户消息是 prompt。
// installation 用来生成稳定的安装 ID（同一把密钥每次都像同一台机器）；effort 为空时由上游决定推理强度。
func CodexTurn(installation, model, effort, prompt string) ([]byte, http.Header, error) {
	now := time.Now()
	thread, turnID := uuidV7(), uuidV7().String()
	threadID := thread.String()
	windowID := threadID + ":0"
	seed := sha256.Sum256([]byte("codex-installation:" + installation))
	installationID := newUUID(seed[:], 4).String()
	metadata, err := json.Marshal(codexTurnMetadata{
		InstallationID: installationID, SessionID: threadID, ThreadID: threadID, AgentName: "/root",
		TurnID: turnID, WindowID: windowID, ContextWindowID: uuidV7().String(), RequestKind: "turn",
		RootTurnID: turnID, ThreadSource: "user", TurnTrigger: "user", Sandbox: "seccomp", SandboxMode: "workspace-write",
		AutoReviewEnabled: true, NodeReplAutoReviewRequired: true, TurnStartedAtUnixMS: now.UnixMilli(),
		AnalyticsEnabled: true, Model: model, ReasoningEffort: effort,
	})
	if err != nil {
		return nil, nil, err
	}
	created := float64(now.UnixMicro()) / 1e6
	input := codexPrefix(thread)
	for _, message := range codexContext.Messages {
		input = append(input, codexMessage("msg_"+uuidV7().String(), message.Role, turnID, created, message.Content...))
	}
	input = append(input,
		codexMessage("msg_"+uuidV7().String(), "user", turnID, created,
			codexText{"environments.environment_context", fmt.Sprintf(codexEnvironment, now.UTC().Format(time.DateOnly))}),
		codexMessage("msg_"+uuidV7().String(), "user", turnID, created, codexText{"user.text", prompt}),
	)
	request := codexRequest{
		Model: model, Input: input, ToolChoice: "auto", Reasoning: codexReasoning{effort, "all_turns"},
		Stream: true, Include: []string{"reasoning.encrypted_content"}, PromptCacheKey: threadID,
		Text: map[string]string{"verbosity": "low"},
		ClientMetadata: codexClientMetadata{
			ThreadID: threadID, WindowID: windowID, TurnID: turnID, RootTurnID: turnID,
			TurnMetadata: string(metadata), InstallationID: installationID, SessionID: threadID,
		},
	}
	// 和 Codex 一样不转义 <、>、&
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(request); err != nil {
		return nil, nil, err
	}
	headers := http.Header{
		"Accept":                                 {"text/event-stream"},
		"Content-Type":                           {"application/json"},
		"Originator":                             {"codex-tui"},
		"User-Agent":                             {codexUserAgent},
		"Session-Id":                             {threadID},
		"Thread-Id":                              {threadID},
		"X-Client-Request-Id":                    {threadID},
		"X-Codex-Window-Id":                      {windowID},
		"X-Codex-Turn-Metadata":                  {string(metadata)},
		"X-Codex-Beta-Features":                  {"remote_compaction_v2"},
		"X-Openai-Internal-Codex-Responses-Lite": {"true"},
	}
	return bytes.TrimSuffix(body.Bytes(), []byte("\n")), headers, nil
}

// codexPrefix 是 Codex 每个请求开头的工具项和基础指令项，ID 按会话 ID 和内容算出。
func codexPrefix(thread uuid) []codexItem {
	space := uuidV5(uuidOID, []byte(thread.String()))
	instructions := codexContext.BaseInstructions
	return []codexItem{
		{Type: "additional_tools", ID: "at_" + uuidV5(space, codexTools).String(), Role: "developer", Tools: codexTools},
		codexMessage("msg_"+uuidV5(space, []byte(instructions)).String(), "developer", "", 0, codexText{"model.base_instructions", instructions}),
	}
}

func codexMessage(id, role, turnID string, created float64, parts ...codexText) codexItem {
	metadata := &codexItemMetadata{TurnID: turnID, CreateTime: created}
	item := codexItem{Type: "message", ID: id, Role: role, Metadata: metadata}
	for _, part := range parts {
		item.Content = append(item.Content, codexContent{"input_text", part.Text})
		metadata.ContentItemKinds = append(metadata.ContentItemKinds, part.Kind)
	}
	return item
}

type uuid [16]byte

// uuidOID 是 RFC 9562 里 ISO OID 的命名空间。
var uuidOID = uuid{0x6b, 0xa7, 0xb8, 0x12, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8}

func newUUID(b []byte, version byte) (id uuid) {
	copy(id[:], b)
	id[6] = id[6]&0x0f | version<<4
	id[8] = id[8]&0x3f | 0x80
	return id
}

func uuidV5(space uuid, name []byte) uuid {
	sum := sha1.Sum(append(space[:], name...))
	return newUUID(sum[:], 5)
}

func uuidV7() uuid {
	var b [16]byte
	binary.BigEndian.PutUint64(b[:], uint64(time.Now().UnixMilli())<<16)
	_, _ = rand.Read(b[6:])
	return newUUID(b[:], 7)
}

func (id uuid) String() string {
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}
