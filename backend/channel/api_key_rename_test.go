package channel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yreidev/upstream-ops/backend/connector"
)

func TestRenameAPIKeysToGroup(t *testing.T) {
	longGroup := strings.Repeat("长", 17) // 51 字节，超过 NewAPI 的 50 字节上限
	var mu sync.Mutex
	var puts []map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/api/user/self", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":{"id":9}}`))
	})
	mux.HandleFunc("/api/user/self/groups", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":{"claude-max":{"ratio":1,"desc":""},"gpt":{"ratio":0.5,"desc":""},"` + longGroup + `":{"ratio":1,"desc":""}}}`))
	})
	mux.HandleFunc("/api/token/", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`{"success":true,"message":"","data":{"items":[
				{"id":1,"name":"old","status":1,"expired_time":-1,"remain_quota":100,"group":"claude-max"},
				{"id":2,"name":"gpt","status":1,"group":"gpt"},
				{"id":3,"name":"x","status":1,"group":""},
				{"id":4,"name":"y","status":1,"group":"gone"},
				{"id":5,"name":"z","status":1,"group":"` + longGroup + `"},
				{"id":6,"name":"w","status":1,"group":"gpt"}
			],"total":6,"page":1,"page_size":100,"pages":1}}`))
		case http.MethodPut:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			puts = append(puts, body)
			mu.Unlock()
			_, _ = w.Write([]byte(`{"success":true,"message":""}`))
		}
	})
	mux.HandleFunc("/api/token/1", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"message":"","data":{"id":1,"name":"old","status":1,"expired_time":-1,"remain_quota":100,"group":"claude-max"}}`))
	})
	mux.HandleFunc("/api/token/6", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":false,"message":"令牌不存在"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	svc, ch, _, _ := newStoredNewAPIChannel(t, srv.URL)
	if err := svc.persistSession(ch.ID, &connector.AuthSession{
		UserID: "9", AccessToken: "access", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("persist session: %v", err)
	}

	res, err := svc.RenameAPIKeysToGroup(context.Background(), ch.ID)
	if err != nil {
		t.Fatalf("RenameAPIKeysToGroup: %v", err)
	}
	if res.Renamed != 1 || res.Unchanged != 1 || len(res.Skipped) != 3 || len(res.Failed) != 1 {
		t.Fatalf("result = %+v", res)
	}
	wantSkipped := map[int64]string{3: "未分组", 4: "分组不在上游现有分组里", 5: "分组名超过 50 字节，NewAPI 不接受"}
	for _, s := range res.Skipped {
		if wantSkipped[s.ID] != s.Reason {
			t.Fatalf("skipped %d reason = %q, want %q", s.ID, s.Reason, wantSkipped[s.ID])
		}
	}
	if res.Failed[0].ID != 6 || !strings.Contains(res.Failed[0].Reason, "令牌不存在") {
		t.Fatalf("failed = %+v", res.Failed)
	}
	if len(puts) != 1 || puts[0]["id"] != float64(1) || puts[0]["name"] != "claude-max" ||
		puts[0]["group"] != "claude-max" || puts[0]["remain_quota"] != float64(100) || puts[0]["expired_time"] != float64(-1) {
		t.Fatalf("PUT bodies = %#v", puts)
	}
}

func TestSameAPIKeyNameUnescapesSub2API(t *testing.T) {
	if !sameAPIKeyName("A&amp;B", "A&B", true) {
		t.Fatal("sub2api stores names HTML-escaped; they must compare equal")
	}
	if sameAPIKeyName("A&amp;B", "A&B", false) {
		t.Fatal("newapi does not escape names")
	}
}

func TestAPIKeyGroupNameSub2API(t *testing.T) {
	id := func(v int64) *int64 { return &v }
	liveByID := map[int64]string{3: " Claude Max "}
	cases := []struct {
		key        connector.APIKey
		wantName   string
		wantReason string
	}{
		{connector.APIKey{GroupID: id(3), GroupName: "旧名字"}, "Claude Max", ""},
		{connector.APIKey{}, "", "未分组"},
		{connector.APIKey{GroupID: id(8), GroupName: "已删"}, "", "分组不在上游现有分组里"},
	}
	for _, c := range cases {
		name, reason := apiKeyGroupName(c.key, true, nil, liveByID)
		if name != c.wantName || reason != c.wantReason {
			t.Errorf("apiKeyGroupName(%+v) = %q, %q; want %q, %q", c.key, name, reason, c.wantName, c.wantReason)
		}
	}
}
