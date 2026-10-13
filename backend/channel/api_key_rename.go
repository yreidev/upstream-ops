package channel

import (
	"context"
	"html"
	"strings"

	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/storage"
)

// newAPIMaxTokenNameBytes NewAPI 令牌名称上限，按字节算（中文一个字 3 字节）。
const newAPIMaxTokenNameBytes = 50

// RenameAPIKeysResult 一键把密钥名称改成分组名的结果。
type RenameAPIKeysResult struct {
	Renamed   int                 `json:"renamed"`
	Unchanged int                 `json:"unchanged"`
	Skipped   []APIKeyRenameIssue `json:"skipped"`
	Failed    []APIKeyRenameIssue `json:"failed"`
}

// APIKeyRenameIssue 被跳过或修改失败的密钥及原因。
type APIKeyRenameIssue struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// RenameAPIKeysToGroup 把渠道全部密钥的名称改成各自所属的分组名。
// 已经同名的不动；未分组、分组已失效、分组名超出上游长度限制的跳过；单把失败不影响其余。
func (s *Service) RenameAPIKeysToGroup(ctx context.Context, channelID uint) (*RenameAPIKeysResult, error) {
	c, resolved, conn, session, err := s.prepareConnectorCall(ctx, channelID)
	if err != nil {
		return nil, err
	}
	groups, err := conn.ListAPIKeyGroups(ctx, resolved, session)
	if err != nil {
		return nil, err
	}
	keys, err := listAllAPIKeys(ctx, conn, resolved, session)
	if err != nil {
		return nil, err
	}

	isSub2API := c.Type == storage.ChannelTypeSub2API
	liveNames := make(map[string]struct{}, len(groups))
	liveByID := make(map[int64]string, len(groups))
	for _, g := range groups {
		liveNames[g.Name] = struct{}{}
		if g.ID != nil {
			liveByID[*g.ID] = g.Name
		}
	}

	result := &RenameAPIKeysResult{Skipped: []APIKeyRenameIssue{}, Failed: []APIKeyRenameIssue{}}
	for _, k := range keys {
		issue := APIKeyRenameIssue{ID: k.ID, Name: k.Name}
		target, reason := apiKeyGroupName(k, isSub2API, liveNames, liveByID)
		if reason == "" && !isSub2API && len(target) > newAPIMaxTokenNameBytes {
			reason = "分组名超过 50 字节，NewAPI 不接受"
		}
		if reason != "" {
			issue.Reason = reason
			result.Skipped = append(result.Skipped, issue)
			continue
		}
		if sameAPIKeyName(k.Name, target, isSub2API) {
			result.Unchanged++
			continue
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if _, err := conn.UpdateAPIKey(ctx, resolved, session, k.ID, connector.APIKeyUpdateRequest{Name: &target}); err != nil {
			issue.Reason = err.Error()
			result.Failed = append(result.Failed, issue)
			continue
		}
		result.Renamed++
	}
	_ = s.Channels.SetLastError(c.ID, "")
	return result, nil
}

// apiKeyGroupName 返回密钥当前所属分组的名称；拿不到时返回跳过原因。
// 分组判断与前端密钥列表一致：NewAPI 按分组名，Sub2API 按分组 ID 对照上游现有分组。
func apiKeyGroupName(k connector.APIKey, isSub2API bool, liveNames map[string]struct{}, liveByID map[int64]string) (string, string) {
	if isSub2API {
		if k.GroupID == nil {
			return "", "未分组"
		}
		name, ok := liveByID[*k.GroupID]
		if !ok || strings.TrimSpace(name) == "" {
			return "", "分组不在上游现有分组里"
		}
		return strings.TrimSpace(name), ""
	}
	name := strings.TrimSpace(k.Group)
	if name == "" {
		return "", "未分组"
	}
	if _, ok := liveNames[name]; !ok {
		return "", "分组不在上游现有分组里"
	}
	return name, ""
}

// sameAPIKeyName Sub2API 保存名称时会做 HTML 转义（& 存成 &amp;），比较前先还原。
func sameAPIKeyName(name, target string, isSub2API bool) bool {
	name = strings.TrimSpace(name)
	if name == target {
		return true
	}
	return isSub2API && html.UnescapeString(name) == target
}
