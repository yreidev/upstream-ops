package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/yreidev/upstream-ops/backend/channel"
	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/jobs"
	"github.com/yreidev/upstream-ops/backend/progress"
	"github.com/yreidev/upstream-ops/backend/storage"
)

func registerChannels(g *gin.RouterGroup, d *Deps) {
	gp := g.Group("/channels")
	gp.GET("", func(c *gin.Context) { listChannels(c, d) })
	gp.POST("", func(c *gin.Context) { createChannel(c, d) })
	gp.POST("/sync-all", func(c *gin.Context) { syncAllChannels(c, d) })
	gp.GET("/:id", func(c *gin.Context) { getChannel(c, d) })
	gp.PUT("/:id", func(c *gin.Context) { updateChannel(c, d) })
	gp.DELETE("/:id", func(c *gin.Context) { deleteChannel(c, d) })
	gp.POST("/:id/clear-login-info", func(c *gin.Context) { clearChannelLoginInfo(c, d) })
	gp.POST("/:id/enable", func(c *gin.Context) { toggleChannel(c, d, true) })
	gp.POST("/:id/disable", func(c *gin.Context) { toggleChannel(c, d, false) })
	gp.POST("/:id/test-login", func(c *gin.Context) { testLogin(c, d) })
	gp.POST("/:id/redeem", func(c *gin.Context) { redeemChannel(c, d) })
	gp.GET("/:id/recharge-info", func(c *gin.Context) { channelRechargeInfo(c, d) })
	gp.POST("/:id/recharge", func(c *gin.Context) { createChannelRecharge(c, d) })
	gp.GET("/:id/api-keys/groups", func(c *gin.Context) { listChannelAPIKeyGroups(c, d) })
	gp.GET("/:id/api-keys", func(c *gin.Context) { listChannelAPIKeys(c, d) })
	gp.POST("/:id/api-keys", func(c *gin.Context) { createChannelAPIKey(c, d) })
	gp.POST("/:id/api-keys/rename-to-group", func(c *gin.Context) { renameChannelAPIKeysToGroup(c, d) })
	gp.PUT("/:id/api-keys/:key_id", func(c *gin.Context) { updateChannelAPIKey(c, d) })
	gp.DELETE("/:id/api-keys/:key_id", func(c *gin.Context) { deleteChannelAPIKey(c, d) })
	gp.POST("/:id/api-keys/:key_id/reveal", func(c *gin.Context) { revealChannelAPIKey(c, d) })
	gp.POST("/:id/sync", func(c *gin.Context) { syncChannel(c, d) })
	gp.GET("/:id/rates", func(c *gin.Context) { channelRates(c, d) })
	gp.GET("/:id/balance-history", func(c *gin.Context) { balanceHistory(c, d) })
}

type channelInput struct {
	Name                        string                 `json:"name" binding:"required"`
	Type                        storage.ChannelType    `json:"type" binding:"required"`
	SiteURL                     string                 `json:"site_url" binding:"required"`
	Username                    string                 `json:"username"`
	SortOrder                   int                    `json:"sort_order"`
	Password                    string                 `json:"password"`
	CredentialMode              storage.CredentialMode `json:"credential_mode"`
	TokenCredential             string                 `json:"token_credential"` // JSON：token 模式时填写
	LoginExtraParams            string                 `json:"login_extra_params"`
	TurnstileEnabled            bool                   `json:"turnstile_enabled"`
	IgnoreAnnouncements         bool                   `json:"ignore_announcements"`
	CaptchaConfigID             *uint                  `json:"captcha_config_id"`
	BalanceThreshold            float64                `json:"balance_threshold"`
	RechargeMultiplier          *float64               `json:"recharge_multiplier"`
	RechargeMultiplierMode      string                 `json:"recharge_multiplier_mode"`
	MonitorEnabled              bool                   `json:"monitor_enabled"`
	OnlyCreatedKeyGroupsEnabled bool                   `json:"only_created_key_groups_enabled"`
	Tags                        []string               `json:"tags"`
	Notes                       string                 `json:"notes"`
}

type channelUpdateInput struct {
	Name                        *string                 `json:"name"`
	SiteURL                     *string                 `json:"site_url"`
	Username                    *string                 `json:"username"`
	SortOrder                   *int                    `json:"sort_order"`
	Password                    *string                 `json:"password"`
	CredentialMode              *storage.CredentialMode `json:"credential_mode"`
	TokenCredential             *string                 `json:"token_credential"`
	LoginExtraParams            *string                 `json:"login_extra_params"`
	TurnstileEnabled            *bool                   `json:"turnstile_enabled"`
	IgnoreAnnouncements         *bool                   `json:"ignore_announcements"`
	CaptchaConfigID             *uint                   `json:"captcha_config_id"`
	BalanceThreshold            *float64                `json:"balance_threshold"`
	RechargeMultiplier          *float64                `json:"recharge_multiplier"`
	RechargeMultiplierMode      *string                 `json:"recharge_multiplier_mode"`
	MonitorEnabled              *bool                   `json:"monitor_enabled"`
	OnlyCreatedKeyGroupsEnabled *bool                   `json:"only_created_key_groups_enabled"`
	Tags                        *[]string               `json:"tags"` // 省略或 null 表示不修改，[] 表示清空
	Notes                       *string                 `json:"notes"`
}

type channelOutput struct {
	storage.Channel
	UserID string `json:"user_id,omitempty"`
}

type channelRedeemInput struct {
	Code string `json:"code"`
}

type channelRechargeInput struct {
	Amount        float64 `json:"amount"`
	PaymentMethod string  `json:"payment_method"`
	IsMobile      bool    `json:"is_mobile"`
}

type channelAPIKeyCreateInput = connector.APIKeyCreateRequest
type channelAPIKeyUpdateInput = connector.APIKeyUpdateRequest

func listChannels(c *gin.Context, d *Deps) {
	if c.Query("page") != "" || c.Query("page_size") != "" {
		page, pageSize, err := parseChannelPageQuery(c)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		filter, err := parseChannelListFilter(c)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		list, total, err := d.Channels.ListPage(page, pageSize, filter)
		if err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		pages := 1
		if total > 0 && pageSize != -1 {
			pages = int((total + int64(pageSize) - 1) / int64(pageSize))
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{
			"items":     channelOutputs(d, list),
			"total":     total,
			"page":      page,
			"page_size": pageSize,
			"pages":     pages,
		}})
		return
	}

	list, err := d.Channels.List()
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": channelOutputs(d, list)})
}

func createChannel(c *gin.Context, d *Deps) {
	var in channelInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	tags, err := normalizeChannelTagsInput(in.Tags)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	notes, err := normalizeChannelNotesInput(in.Notes)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	created, err := d.ChannelSvc.Create(channel.CreateInput{
		Name:                        in.Name,
		Type:                        in.Type,
		SiteURL:                     in.SiteURL,
		Username:                    in.Username,
		SortOrder:                   in.SortOrder,
		Password:                    in.Password,
		CredentialMode:              in.CredentialMode,
		TokenCredential:             in.TokenCredential,
		LoginExtraParams:            in.LoginExtraParams,
		TurnstileEnabled:            in.TurnstileEnabled,
		IgnoreAnnouncements:         in.IgnoreAnnouncements,
		CaptchaConfigID:             in.CaptchaConfigID,
		BalanceThreshold:            in.BalanceThreshold,
		RechargeMultiplier:          in.RechargeMultiplier,
		RechargeMultiplierMode:      in.RechargeMultiplierMode,
		MonitorEnabled:              in.MonitorEnabled,
		OnlyCreatedKeyGroupsEnabled: in.OnlyCreatedKeyGroupsEnabled,
		Tags:                        tags,
		Notes:                       notes,
	})
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": channelOutputFor(d, *created)})
}

// normalizeChannelTagsInput 规范化并校验渠道标签（个数 / 单个长度按规范化后的结果计算）。
func normalizeChannelTagsInput(tags []string) ([]string, error) {
	tags = storage.NormalizeChannelTags(tags)
	if len(tags) > storage.MaxChannelTags {
		return nil, fmt.Errorf("标签最多 %d 个", storage.MaxChannelTags)
	}
	for _, tag := range tags {
		if utf8.RuneCountInString(tag) > storage.MaxChannelTagRunes {
			return nil, fmt.Errorf("单个标签最多 %d 个字符：%s", storage.MaxChannelTagRunes, tag)
		}
	}
	return tags, nil
}

// normalizeChannelNotesInput 去掉首尾空白后校验备注长度。
func normalizeChannelNotesInput(notes string) (string, error) {
	notes = strings.TrimSpace(notes)
	if utf8.RuneCountInString(notes) > storage.MaxChannelNotesRunes {
		return "", fmt.Errorf("备注最多 %d 个字符", storage.MaxChannelNotesRunes)
	}
	return notes, nil
}

// costNow 输出层判断"今日消费"是否跨天使用的当前时间，测试可替换。
var costNow = time.Now

func channelOutputs(d *Deps, list []storage.Channel) []channelOutput {
	now := costNow()
	out := make([]channelOutput, 0, len(list))
	for _, ch := range list {
		out = append(out, channelOutputAt(d, ch, now))
	}
	return out
}

func channelOutputFor(d *Deps, ch storage.Channel) channelOutput {
	return channelOutputAt(d, ch, costNow())
}

// channelOutputAt 组装渠道输出；TodayCost 按 now 做跨天归零（只影响响应，不回写数据库）。
func channelOutputAt(d *Deps, ch storage.Channel, now time.Time) channelOutput {
	out := channelOutput{Channel: ch}
	out.TodayCost = ch.EffectiveTodayCost(now)
	out.UserID = channelUserID(d, &ch)
	return out
}

func channelUserID(d *Deps, ch *storage.Channel) string {
	if d == nil || ch == nil || ch.Type != storage.ChannelTypeNewAPI {
		return ""
	}
	if ch.CredentialMode == storage.CredentialModeToken && d.Cipher != nil && ch.PasswordCipher != "" {
		raw, err := d.Cipher.Decrypt(ch.PasswordCipher)
		if err == nil {
			var cred channel.NewAPITokenCredential
			if json.Unmarshal([]byte(raw), &cred) == nil {
				if userID := strings.TrimSpace(cred.UserID); userID != "" {
					return userID
				}
			}
		}
	}
	if d.Sessions != nil {
		session, err := d.Sessions.FindByChannel(ch.ID)
		if err == nil && session != nil {
			return strings.TrimSpace(session.UserID)
		}
	}
	return ""
}

func getChannel(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	ch, err := d.Channels.FindByID(id)
	if err != nil {
		fail(c, http.StatusNotFound, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": channelOutputFor(d, *ch)})
}

func updateChannel(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	var in channelUpdateInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	var tags *[]string
	if in.Tags != nil {
		normalized, err := normalizeChannelTagsInput(*in.Tags)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		tags = &normalized
	}
	var notes *string
	if in.Notes != nil {
		normalized, err := normalizeChannelNotesInput(*in.Notes)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		notes = &normalized
	}
	updated, err := d.ChannelSvc.Update(id, channel.UpdateInput{
		Name:                        in.Name,
		SiteURL:                     in.SiteURL,
		Username:                    in.Username,
		SortOrder:                   in.SortOrder,
		Password:                    in.Password,
		CredentialMode:              in.CredentialMode,
		TokenCredential:             in.TokenCredential,
		LoginExtraParams:            in.LoginExtraParams,
		TurnstileEnabled:            in.TurnstileEnabled,
		IgnoreAnnouncements:         in.IgnoreAnnouncements,
		CaptchaConfigID:             in.CaptchaConfigID,
		BalanceThreshold:            in.BalanceThreshold,
		RechargeMultiplier:          in.RechargeMultiplier,
		RechargeMultiplierMode:      in.RechargeMultiplierMode,
		MonitorEnabled:              in.MonitorEnabled,
		OnlyCreatedKeyGroupsEnabled: in.OnlyCreatedKeyGroupsEnabled,
		Tags:                        tags,
		Notes:                       notes,
	})
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": channelOutputFor(d, *updated)})
}

func deleteChannel(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if err := d.ChannelSvc.Delete(id); err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func clearChannelLoginInfo(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	updated, err := d.ChannelSvc.ClearLoginInfo(id)
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": channelOutputFor(d, *updated)})
}

func toggleChannel(c *gin.Context, d *Deps, enabled bool) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	_, err = d.ChannelSvc.Update(id, channel.UpdateInput{MonitorEnabled: &enabled})
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "monitor_enabled": enabled})
}

// channelJobTimeout 单个渠道的同步或登录测试最长跑多久（含打码）。
const channelJobTimeout = 5 * time.Minute

// channelJob 是针对单个渠道的后台任务；同一渠道的同步和登录测试共用一个 Key，不会同时跑。
func channelJob(kind storage.JobKind, verb string, ch *storage.Channel) jobs.Spec {
	return jobs.Spec{
		Kind:      kind,
		Source:    storage.JobManual,
		ChannelID: ch.ID,
		Title:     verb + " " + ch.Name,
		Key:       fmt.Sprintf("channel:%d", ch.ID),
		Timeout:   channelJobTimeout,
	}
}

// testLogin 在后台测试登录，session 落库以便后续同步复用。
func testLogin(c *gin.Context, d *Deps) {
	ch, ok := findChannelParam(c, d)
	if !ok {
		return
	}
	startJob(c, d, channelJob(storage.JobChannelTestLogin, "测试登录", ch), func(ctx context.Context) (string, any, error) {
		ctx = progress.ForChannel(ctx, ch.ID, ch.Name, 1, 1)
		if err := d.ChannelSvc.TestLogin(ctx, ch.ID); err != nil {
			return "", nil, err
		}
		return "登录测试成功", nil, nil
	})
}

func redeemChannel(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if _, err := d.Channels.FindByID(id); err != nil {
		fail(c, http.StatusNotFound, err)
		return
	}

	var in channelRedeemInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	res, err := d.ChannelSvc.RedeemCode(c.Request.Context(), id, in.Code)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

func channelRechargeInfo(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	info, err := d.ChannelSvc.GetRechargeInfo(c.Request.Context(), id)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": info})
}

func createChannelRecharge(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	var in channelRechargeInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if in.Amount <= 0 {
		fail(c, http.StatusBadRequest, fmt.Errorf("充值金额必须大于 0"))
		return
	}
	if in.PaymentMethod != "alipay" && in.PaymentMethod != "wxpay" {
		fail(c, http.StatusBadRequest, fmt.Errorf("仅支持 alipay 或 wxpay"))
		return
	}
	res, err := d.ChannelSvc.CreateRecharge(c.Request.Context(), id, connector.RechargeRequest{
		Amount:        in.Amount,
		PaymentMethod: in.PaymentMethod,
		IsMobile:      in.IsMobile,
	})
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

func listChannelAPIKeys(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	page, pageSize, err := parsePageQuery(c)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	res, err := d.ChannelSvc.ListAPIKeys(c.Request.Context(), id, connector.APIKeyQuery{
		Page:     page,
		PageSize: pageSize,
		Search:   c.Query("search"),
		Status:   c.Query("status"),
		GroupID:  c.Query("group_id"),
	})
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

func listChannelAPIKeyGroups(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	res, err := d.ChannelSvc.ListAPIKeyGroups(c.Request.Context(), id)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

func createChannelAPIKey(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	var in channelAPIKeyCreateInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		fail(c, http.StatusBadRequest, fmt.Errorf("密钥名称不能为空"))
		return
	}
	res, err := d.ChannelSvc.CreateAPIKey(c.Request.Context(), id, connector.APIKeyCreateRequest(in))
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

func updateChannelAPIKey(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	keyID, err := int64Param(c, "key_id")
	if err != nil || keyID <= 0 {
		fail(c, http.StatusBadRequest, fmt.Errorf("密钥 ID 无效"))
		return
	}
	var in channelAPIKeyUpdateInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	res, err := d.ChannelSvc.UpdateAPIKey(c.Request.Context(), id, keyID, connector.APIKeyUpdateRequest(in))
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// renameChannelAPIKeysToGroup 把渠道全部密钥的名称改成各自所属的分组名。
func renameChannelAPIKeysToGroup(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	res, err := d.ChannelSvc.RenameAPIKeysToGroup(c.Request.Context(), id)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

func deleteChannelAPIKey(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	keyID, err := int64Param(c, "key_id")
	if err != nil || keyID <= 0 {
		fail(c, http.StatusBadRequest, fmt.Errorf("密钥 ID 无效"))
		return
	}
	if err := d.ChannelSvc.DeleteAPIKey(c.Request.Context(), id, keyID); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func revealChannelAPIKey(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	keyID, err := int64Param(c, "key_id")
	if err != nil || keyID <= 0 {
		fail(c, http.StatusBadRequest, fmt.Errorf("密钥 ID 无效"))
		return
	}
	key, err := d.ChannelSvc.RevealAPIKey(c.Request.Context(), id, keyID)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"key": key}})
}

func channelRates(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	list, err := d.Rates.ListByChannel(id)
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	// ?only_with_keys=1：仅返回"已创建密钥的分组"。
	// 该参数由前端按渠道开关 channel.only_created_key_groups_enabled 拼接，
	// 通知设置等全量场景不传该参数，仍返回完整 RateSnapshot。
	if onlyWithKeys := c.Query("only_with_keys"); onlyWithKeys == "1" || strings.EqualFold(onlyWithKeys, "true") {
		set, err := d.ChannelSvc.ListAPIKeyGroupSet(c.Request.Context(), id)
		if err != nil {
			fail(c, http.StatusInternalServerError, err)
			return
		}
		if set.Empty() {
			// 没有任何已创建密钥 → 返回空数组（开关语义就是"只显示有密钥的分组"）。
			c.JSON(http.StatusOK, gin.H{"data": []storage.RateSnapshot{}})
			return
		}
		filtered := make([]storage.RateSnapshot, 0, len(list))
		for _, snap := range list {
			if set.ContainsSnapshot(snap) {
				filtered = append(filtered, snap)
			}
		}
		c.JSON(http.StatusOK, gin.H{"data": filtered})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": list})
}

func balanceHistory(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	list, err := d.Rates.BalanceHistory(id, limit)
	if err != nil {
		fail(c, http.StatusInternalServerError, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": list})
}

func uintParam(c *gin.Context, name string) (uint, error) {
	id, err := strconv.ParseUint(c.Param(name), 10, 64)
	return uint(id), err
}

func int64Param(c *gin.Context, name string) (int64, error) {
	return strconv.ParseInt(c.Param(name), 10, 64)
}

func parsePageQuery(c *gin.Context) (int, int, error) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		return 0, 0, fmt.Errorf("page 必须是正整数")
	}
	pageSize, err := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if err != nil || pageSize < 1 {
		return 0, 0, fmt.Errorf("page_size 必须是正整数")
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize, nil
}

func parseChannelPageQuery(c *gin.Context) (int, int, error) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		return 0, 0, fmt.Errorf("page 必须是正整数")
	}
	pageSize, err := strconv.Atoi(c.DefaultQuery("page_size", "20"))
	if err != nil || pageSize == 0 || pageSize < -1 {
		return 0, 0, fmt.Errorf("page_size 必须是正整数或 -1")
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize, nil
}

// parseChannelListFilter 解析分页列表的 q / status / tag / sort / order 参数，
// 未知的 status / sort / order 或超长的 q / tag 返回错误（由调用方转成 400）。
func parseChannelListFilter(c *gin.Context) (storage.ChannelListFilter, error) {
	return storage.ChannelListFilter{
		Query:  c.Query("q"),
		Status: c.Query("status"),
		Tag:    c.Query("tag"),
		Sort:   c.Query("sort"),
		Order:  c.Query("order"),
	}.Normalize()
}

// syncChannel 在后台同步单个渠道：先余额和消费，再倍率，任一步失败仍做下一步。
func syncChannel(c *gin.Context, d *Deps) {
	ch, ok := findChannelParam(c, d)
	if !ok {
		return
	}
	startJob(c, d, channelJob(storage.JobChannelSync, "同步", ch), func(ctx context.Context) (string, any, error) {
		ctx = progress.ForChannel(ctx, ch.ID, ch.Name, 1, 1)
		balErr := d.Monitor.RefreshBalance(ctx, ch)
		rateErr := d.Monitor.RefreshRates(ctx, ch)
		if balErr != nil || rateErr != nil {
			return "", nil, errors.New(joinErrorMessages(balErr, rateErr))
		}
		return "同步完成", nil, nil
	})
}

// syncAllChannels 在后台逐个同步全部渠道的余额和消费。
func syncAllChannels(c *gin.Context, d *Deps) {
	startJob(c, d, jobs.Spec{
		Kind:    storage.JobChannelSyncAll,
		Source:  storage.JobManual,
		Title:   "同步全部渠道",
		Key:     string(storage.JobChannelSyncAll),
		Timeout: 15 * time.Minute,
	}, func(ctx context.Context) (string, any, error) {
		sum, err := d.Monitor.SyncAllBalances(ctx)
		if err != nil {
			return "", nil, err
		}
		return sum.Message(), sum, sum.Err()
	})
}

// findChannelParam 按路径里的 :id 取渠道，失败时已写好错误响应。
func findChannelParam(c *gin.Context, d *Deps) (*storage.Channel, bool) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return nil, false
	}
	ch, err := d.Channels.FindByID(id)
	if err != nil {
		fail(c, http.StatusNotFound, err)
		return nil, false
	}
	return ch, true
}

func joinErrorMessages(errs ...error) string {
	parts := make([]string, 0, len(errs))
	for _, err := range errs {
		if err != nil {
			parts = append(parts, err.Error())
		}
	}
	return strings.Join(parts, " | ")
}
