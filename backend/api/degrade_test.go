package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/crypto"
	"github.com/yreidev/upstream-ops/backend/degrade"
	"github.com/yreidev/upstream-ops/backend/notify"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// 测试里的密钥是编的。
const degradeTestKey = "sk-test-0000000000000000T0k1"

type degradeKeySource struct{ revealErr error }

func (f *degradeKeySource) ListAllAPIKeys(context.Context, uint) ([]connector.APIKey, error) {
	return []connector.APIKey{{ID: 7, Name: "演示密钥", Key: "sk-tes**********T0k1", GroupName: "演示分组"}}, nil
}

func (f *degradeKeySource) RevealAPIKey(context.Context, uint, int64) (string, error) {
	return degradeTestKey, f.revealErr
}

type nopNotifier struct{}

func (nopNotifier) Dispatch(context.Context, notify.Message) error { return nil }

func TestDegradeRoutes(t *testing.T) {
	env := newJobTestEnv(t)
	ch := &storage.Channel{Name: "演示站", Type: storage.ChannelType("newapi"), SiteURL: "https://relay.example.com", Username: "u", PasswordCipher: "x"}
	if err := env.channels.Create(ch); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	cipher, _ := crypto.NewCipher("test-secret-test-secret-test-secret")
	keys := &degradeKeySource{revealErr: errors.New("status 403: browser origin required")}
	svc := degrade.NewService(storage.NewDegradeKeys(env.db), env.channels, keys, nopNotifier{}, cipher, slog.New(slog.NewTextHandler(io.Discard, nil)))
	svc.Ask = func(context.Context, string, string, string, string, string) (degrade.Answer, time.Duration, error) {
		return degrade.Answer{Text: "最少要取 21 个。"}, time.Second, nil
	}
	svc.FetchModels = func(context.Context, string, string) ([]string, error) {
		return []string{"gpt-6.1-sol", "gpt-5"}, nil
	}
	env.deps.Degrade = svc
	registerDegrade(env.r.Group("/api"), env.deps)

	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		env.r.ServeHTTP(rec, req)
		return rec
	}
	add := `{"channel_id":` + strconv.Itoa(int(ch.ID)) + `,"upstream_key_id":7`

	// 站点不让取完整密钥：返回 422 和 code，页面据此让用户粘贴
	rec := do(http.MethodPost, "/api/degrade/keys", add+`}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), `"code":"reveal_failed"`) {
		t.Fatalf("add without key = %d %s", rec.Code, rec.Body.String())
	}
	rec = do(http.MethodPost, "/api/degrade/keys", add+`,"key":"`+degradeTestKey+`"}`)
	if rec.Code != http.StatusCreated || strings.Contains(rec.Body.String(), degradeTestKey) {
		t.Fatalf("add with pasted key = %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Data storage.DegradeKey `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	id := strconv.Itoa(int(created.Data.ID))

	code, data := env.get(t, "/api/degrade/keys")
	if code != http.StatusOK || !strings.Contains(string(data), `"models":["gpt-6.1-sol"]`) ||
		!strings.Contains(string(data), `"channel_name":"演示站"`) || strings.Contains(string(data), degradeTestKey) {
		t.Fatalf("list = %d %s", code, data)
	}
	if rec := do(http.MethodPatch, "/api/degrade/keys/"+id, `{"model":"gpt-own","effort":"extreme"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad effort = %d %s", rec.Code, rec.Body.String())
	}

	// 检测在后台任务里跑，结论写在任务结果和密钥上
	code, started := env.start(t, context.Background(), "/api/degrade/keys/"+id+"/check")
	if code != http.StatusAccepted || started.Job.Kind != storage.JobDegradeCheck || started.Job.ChannelID != ch.ID {
		t.Fatalf("check = %d %+v", code, started)
	}
	done := env.wait(t, started.Job.ID)
	if done.Status != storage.JobSucceeded || done.Message != "三次都答对，确认正常" {
		t.Fatalf("check job = %+v", done)
	}
	code, data = env.get(t, "/api/degrade/keys/"+id+"/checks")
	if code != http.StatusOK || strings.Count(string(data), `"result":"correct"`) != 3 {
		t.Fatalf("checks = %d %s", code, data)
	}

	code, started = env.start(t, context.Background(), "/api/degrade/check-all")
	if code != http.StatusAccepted || started.Job.Kind != storage.JobDegradeCheckAll {
		t.Fatalf("check all = %d %+v", code, started)
	}
	if done := env.wait(t, started.Job.ID); done.Status != storage.JobSucceeded || !strings.Contains(done.Message, "1 把密钥：正常 1") {
		t.Fatalf("check all job = %+v", done)
	}

	if rec := do(http.MethodDelete, "/api/degrade/keys/"+id, ""); rec.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodPost, "/api/degrade/keys/"+id+"/check", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("check removed key = %d %s", rec.Code, rec.Body.String())
	}
}
