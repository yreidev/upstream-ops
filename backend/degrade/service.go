// Package degrade 用糖果题检测中转站的 GPT 分组有没有降智：以 Codex 新会话的形式提问，按插件巡检脚本的规则
// 连续三次一致才确认状态，确认降智或恢复时发通知。方案见 docs/gpt-degrade-check.md。
package degrade

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/yreidev/upstream-ops/backend/config"
	"github.com/yreidev/upstream-ops/backend/connector"
	"github.com/yreidev/upstream-ops/backend/crypto"
	"github.com/yreidev/upstream-ops/backend/jobs"
	"github.com/yreidev/upstream-ops/backend/notify"
	"github.com/yreidev/upstream-ops/backend/progress"
	"github.com/yreidev/upstream-ops/backend/storage"
)

const (
	// askTimeout 一次提问最长等多久，和插件一样。
	askTimeout = 10 * time.Minute
	// recoveryWait 降智的密钥首测答对后，隔多久再复测，和插件巡检脚本一样。
	recoveryWait = 240 * time.Second
	// checkAllConcurrency 全部检测时同时测几把密钥。
	checkAllConcurrency = 3
	// maxAnswerRunes 检测记录里最多存多少字的回答。
	maxAnswerRunes = 20000
)

// KeySource 取上游密钥，生产实现是 *channel.Service。
type KeySource interface {
	ListAllAPIKeys(ctx context.Context, channelID uint) ([]connector.APIKey, error)
	RevealAPIKey(ctx context.Context, channelID uint, keyID int64) (string, error)
}

// Notifier 发通知，生产实现是 *notify.Dispatcher。
type Notifier interface {
	Dispatch(ctx context.Context, msg notify.Message) error
}

// AskFunc 发一次糖果题，测试里换成假的。
type AskFunc func(ctx context.Context, baseURL, apiKey, installation, model, effort string) (Answer, time.Duration, error)

// ErrBusy 表示这把密钥正在检测。
var ErrBusy = errors.New("这把密钥正在检测，等这轮跑完再试")

// RevealError 表示站点不让从接口取完整密钥，页面据此让用户手动粘贴。
type RevealError struct{ Err error }

func (e *RevealError) Error() string { return "取不到完整密钥：" + e.Err.Error() }
func (e *RevealError) Unwrap() error { return e.Err }

type Service struct {
	repo     *storage.DegradeKeys
	channels *storage.Channels
	keys     KeySource
	notifier Notifier
	cipher   *crypto.Cipher
	log      *slog.Logger

	// Ask 发一次糖果题；RecoveryWait 是恢复确认前的等待。测试里替换。
	Ask          AskFunc
	RecoveryWait time.Duration

	mu       sync.Mutex
	defaults config.DegradeConfig
	busy     map[uint]bool
}

func NewService(repo *storage.DegradeKeys, channels *storage.Channels, keys KeySource, notifier Notifier, cipher *crypto.Cipher, log *slog.Logger) *Service {
	client := &http.Client{}
	return &Service{
		repo:     repo,
		channels: channels,
		keys:     keys,
		notifier: notifier,
		cipher:   cipher,
		log:      log,
		Ask: func(ctx context.Context, baseURL, apiKey, installation, model, effort string) (Answer, time.Duration, error) {
			return Ask(ctx, client, baseURL, apiKey, installation, model, effort, CandyPrompt)
		},
		RecoveryWait: recoveryWait,
		defaults:     config.DegradeConfig{}.WithDefaults(),
		busy:         map[uint]bool{},
	}
}

// UpdateDefaults 换上设置页保存的默认模型和推理强度。
func (s *Service) UpdateDefaults(cfg config.DegradeConfig) {
	s.mu.Lock()
	s.defaults = cfg.WithDefaults()
	s.mu.Unlock()
}

func (s *Service) Defaults() config.DegradeConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.defaults
}

// modelOf 返回这把密钥实际用的模型和推理强度（单独设了就用单独的）。
func (s *Service) modelOf(k *storage.DegradeKey) (model, effort string) {
	d := s.Defaults()
	model, effort = d.Model, d.Effort
	if strings.TrimSpace(k.Model) != "" {
		model = strings.TrimSpace(k.Model)
	}
	if strings.TrimSpace(k.Effort) != "" {
		effort = strings.TrimSpace(k.Effort)
	}
	return model, effort
}

// KeyView 是页面上看到的一把密钥。
type KeyView struct {
	storage.DegradeKey
	ChannelName     string `json:"channel_name"`
	ChannelType     string `json:"channel_type"`
	EffectiveModel  string `json:"effective_model"`
	EffectiveEffort string `json:"effective_effort"`
	Checking        bool   `json:"checking"`
}

// List 列出全部参与检测的密钥。
func (s *Service) List() ([]KeyView, error) {
	keys, err := s.repo.List()
	if err != nil {
		return nil, err
	}
	all, err := s.channels.List()
	if err != nil {
		return nil, err
	}
	byID := map[uint]storage.Channel{}
	for _, c := range all {
		byID[c.ID] = c
	}
	s.mu.Lock()
	busy := make(map[uint]bool, len(s.busy))
	for id, b := range s.busy {
		busy[id] = b
	}
	s.mu.Unlock()
	out := make([]KeyView, 0, len(keys))
	for i := range keys {
		k := &keys[i]
		model, effort := s.modelOf(k)
		c := byID[k.ChannelID]
		out = append(out, KeyView{
			DegradeKey: *k, ChannelName: c.Name, ChannelType: string(c.Type),
			EffectiveModel: model, EffectiveEffort: effort, Checking: busy[k.ID],
		})
	}
	return out, nil
}

// Candidate 是渠道里一把可以加入检测的上游密钥。
type Candidate struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	GroupName  string  `json:"group_name"`
	GroupRatio float64 `json:"group_ratio"`
	Status     string  `json:"status"`
	KeyTail    string  `json:"key_tail,omitempty"`
	Added      bool    `json:"added"`
}

// Candidates 列出渠道的全部上游密钥，标出哪些已经加入。
func (s *Service) Candidates(ctx context.Context, channelID uint) ([]Candidate, error) {
	keys, err := s.keys.ListAllAPIKeys(ctx, channelID)
	if err != nil {
		return nil, err
	}
	added, err := s.repo.List()
	if err != nil {
		return nil, err
	}
	out := make([]Candidate, 0, len(keys))
	for _, k := range keys {
		out = append(out, Candidate{
			ID: k.ID, Name: strings.TrimSpace(k.Name), GroupName: groupOf(k), GroupRatio: k.GroupRatio,
			Status: k.Status, KeyTail: visibleTail(k.Key),
			Added: slices.ContainsFunc(added, func(d storage.DegradeKey) bool {
				return d.ChannelID == channelID && d.UpstreamKeyID == k.ID
			}),
		})
	}
	return out, nil
}

// AddInput 加入一把密钥。Key 留空时从渠道接口取完整密钥。
type AddInput struct {
	ChannelID     uint   `json:"channel_id"`
	UpstreamKeyID int64  `json:"upstream_key_id"`
	Key           string `json:"key"`
}

// Add 加入一把密钥：完整密钥从渠道接口取，取不到时返回 *RevealError，由页面让用户粘贴后再提交。
func (s *Service) Add(ctx context.Context, in AddInput) (*storage.DegradeKey, error) {
	if in.ChannelID == 0 || in.UpstreamKeyID <= 0 {
		return nil, errors.New("请选择渠道和密钥")
	}
	if _, err := s.repo.FindByUpstream(in.ChannelID, in.UpstreamKeyID); err == nil {
		return nil, errors.New("这把密钥已经在检测列表里")
	}
	upstream, err := s.lookup(ctx, in.ChannelID, in.UpstreamKeyID)
	if err != nil {
		return nil, err
	}
	full, source, err := s.fullKey(ctx, in.ChannelID, upstream, in.Key)
	if err != nil {
		return nil, err
	}
	encrypted, err := s.cipher.Encrypt(full)
	if err != nil {
		return nil, err
	}
	k := &storage.DegradeKey{
		ChannelID: in.ChannelID, UpstreamKeyID: in.UpstreamKeyID,
		Name: strings.TrimSpace(upstream.Name), GroupName: groupOf(*upstream),
		KeyCipher: encrypted, KeyTail: tailOf(full), KeySource: source, State: storage.DegradeUnknown,
	}
	if err := s.repo.Create(k); err != nil {
		return nil, err
	}
	return k, nil
}

// ReplaceKey 重新取完整密钥（pasted 为空时从渠道接口取），密钥在站点上换过之后用。
func (s *Service) ReplaceKey(ctx context.Context, id uint, pasted string) (*storage.DegradeKey, error) {
	k, err := s.repo.Get(id)
	if err != nil {
		return nil, err
	}
	upstream, err := s.lookup(ctx, k.ChannelID, k.UpstreamKeyID)
	if err != nil {
		return nil, err
	}
	full, source, err := s.fullKey(ctx, k.ChannelID, upstream, pasted)
	if err != nil {
		return nil, err
	}
	encrypted, err := s.cipher.Encrypt(full)
	if err != nil {
		return nil, err
	}
	if err := s.repo.UpdateKey(id, encrypted, tailOf(full), source); err != nil {
		return nil, err
	}
	return s.repo.Get(id)
}

// lookup 在渠道的上游密钥里找到这一把，确认它还在，顺便拿名称和分组。
func (s *Service) lookup(ctx context.Context, channelID uint, keyID int64) (*connector.APIKey, error) {
	keys, err := s.keys.ListAllAPIKeys(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("读取渠道密钥失败：%w", err)
	}
	for i := range keys {
		if keys[i].ID == keyID {
			return &keys[i], nil
		}
	}
	return nil, errors.New("渠道里已经没有这把密钥")
}

// fullKey 优先用粘贴的密钥（尾号要和站点上的对得上），没粘贴就从渠道接口取。
func (s *Service) fullKey(ctx context.Context, channelID uint, upstream *connector.APIKey, pasted string) (string, storage.DegradeKeySource, error) {
	pasted = strings.TrimSpace(pasted)
	if pasted != "" {
		if len(pasted) < 8 || strings.IndexFunc(pasted, unicode.IsSpace) >= 0 {
			return "", "", errors.New("粘贴的密钥格式不对：不能有空格，至少 8 个字符")
		}
		if tail := visibleTail(upstream.Key); tail != "" && tail != tailOf(pasted) {
			return "", "", fmt.Errorf("粘贴的密钥尾号是 %s，站点上这把密钥的尾号是 %s，对不上", tailOf(pasted), tail)
		}
		return pasted, storage.DegradeKeyPasted, nil
	}
	full, err := s.keys.RevealAPIKey(ctx, channelID, upstream.ID)
	if err != nil {
		return "", "", &RevealError{Err: err}
	}
	full = strings.TrimSpace(full)
	if full == "" || strings.ContainsAny(full, "*•") {
		return "", "", &RevealError{Err: errors.New("站点返回的仍是打码后的密钥")}
	}
	return full, storage.DegradeKeyRevealed, nil
}

// UpdateModel 改这把密钥单独用的模型和推理强度，留空表示用默认值。
func (s *Service) UpdateModel(id uint, model, effort string) (*storage.DegradeKey, error) {
	model, effort = strings.TrimSpace(model), strings.TrimSpace(effort)
	if effort != "" && !slices.Contains(config.DegradeEfforts, effort) {
		return nil, fmt.Errorf("推理强度只能是 %s，或留空用默认值", strings.Join(config.DegradeEfforts, "、"))
	}
	if _, err := s.repo.Get(id); err != nil {
		return nil, err
	}
	if err := s.repo.UpdateModel(id, model, effort); err != nil {
		return nil, err
	}
	return s.repo.Get(id)
}

func (s *Service) Remove(id uint) error {
	if !s.lock(id) {
		return ErrBusy
	}
	defer s.unlock(id)
	return s.repo.Delete(id)
}

func (s *Service) Checks(id uint, limit int) ([]storage.DegradeCheck, error) {
	return s.repo.ListChecks(id, limit)
}

// Models 用这把密钥列出分组里能用的模型，选模型时参考，不扣费。
func (s *Service) Models(ctx context.Context, id uint) ([]string, error) {
	_, c, apiKey, err := s.load(id)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return ListModels(ctx, http.DefaultClient, c.SiteURL, apiKey)
}

// load 读出密钥、所属渠道和解密后的完整密钥。
func (s *Service) load(id uint) (*storage.DegradeKey, *storage.Channel, string, error) {
	k, err := s.repo.Get(id)
	if err != nil {
		return nil, nil, "", err
	}
	c, err := s.channels.FindByID(k.ChannelID)
	if err != nil {
		return nil, nil, "", fmt.Errorf("读取渠道：%w", err)
	}
	apiKey, err := s.cipher.Decrypt(k.KeyCipher)
	if err != nil {
		return nil, nil, "", fmt.Errorf("解密密钥：%w", err)
	}
	return k, c, apiKey, nil
}

func (s *Service) lock(id uint) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy[id] {
		return false
	}
	s.busy[id] = true
	return true
}

func (s *Service) unlock(id uint) {
	s.mu.Lock()
	delete(s.busy, id)
	s.mu.Unlock()
}

// CheckJobSpec 手动检测一把密钥的后台任务；同一把同时只跑一个。
func CheckJobSpec(k *storage.DegradeKey, channelName string) jobs.Spec {
	return jobs.Spec{
		Kind:      storage.JobDegradeCheck,
		Source:    storage.JobManual,
		ChannelID: k.ChannelID,
		Title:     "降智检测：" + keyLabel(channelName, k),
		Key:       fmt.Sprintf("%s:%d", storage.JobDegradeCheck, k.ID),
		// 最坏是三次都等满 10 分钟，再加恢复确认前的 4 分钟
		Timeout: 3*askTimeout + recoveryWait + time.Minute,
	}
}

// CheckAllJobSpec 检测全部密钥的后台任务，手动和定时巡检共用一个 Key，同时只跑一个。
func CheckAllJobSpec(source storage.JobSource) jobs.Spec {
	title := "降智检测：全部密钥"
	if source == storage.JobScheduled {
		title = "降智巡检"
	}
	return jobs.Spec{
		Kind:    storage.JobDegradeCheckAll,
		Source:  source,
		Title:   title,
		Key:     string(storage.JobDegradeCheckAll),
		Timeout: time.Hour,
	}
}

// CheckJob 返回手动检测一把密钥的后台任务描述和任务本体。
func (s *Service) CheckJob(id uint) (jobs.Spec, jobs.Func, error) {
	k, err := s.repo.Get(id)
	if err != nil {
		return jobs.Spec{}, nil, err
	}
	name := ""
	if c, err := s.channels.FindByID(k.ChannelID); err == nil {
		name = c.Name
	}
	return CheckJobSpec(k, name), s.CheckOne(id), nil
}

// CheckOne 检测一把密钥（跑一轮），作为后台任务执行。请求失败时任务记为失败。
func (s *Service) CheckOne(id uint) jobs.Func {
	return func(ctx context.Context) (string, any, error) {
		round, err := s.checkKey(ctx, id)
		if err != nil {
			return "", nil, err
		}
		if round.Err != "" {
			return round.Message, round, errors.New(round.Message)
		}
		return round.Message, round, nil
	}
}

// CheckAll 检测全部密钥，每把跑一轮，作为后台任务执行。有密钥请求失败时任务记为失败。
func (s *Service) CheckAll(ctx context.Context) (string, any, error) {
	keys, err := s.repo.List()
	if err != nil {
		return "", nil, err
	}
	sum := &Summary{Total: len(keys)}
	if len(keys) == 0 {
		return sum.Message(), sum, nil
	}
	channelNames := s.channelNames()
	var (
		wg  sync.WaitGroup
		mu  sync.Mutex
		sem = make(chan struct{}, checkAllConcurrency)
	)
	for i := range keys {
		k := keys[i]
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			kctx := progress.ForChannel(ctx, k.ChannelID, keyLabel(channelNames[k.ChannelID], &k), index+1, len(keys))
			round, err := s.checkKey(kctx, k.ID)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				round = &Round{KeyID: k.ID, Label: keyLabel(channelNames[k.ChannelID], &k), State: k.State, Err: err.Error(), Message: err.Error()}
				if errors.Is(err, ErrBusy) {
					round.Busy = true
				}
				progress.Fail(kctx, progress.StageDegrade, err.Error())
			}
			sum.add(round)
		}(i)
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return sum.Message(), sum, err
	}
	return sum.Message(), sum, sum.Err()
}

func (s *Service) channelNames() map[uint]string {
	names := map[uint]string{}
	all, err := s.channels.List()
	if err != nil {
		s.log.Warn("list channels for degrade check", "err", err)
		return names
	}
	for _, c := range all {
		names[c.ID] = c.Name
	}
	return names
}

// Round 是一把密钥一轮检测的结果。
type Round struct {
	KeyID   uint                    `json:"key_id"`
	Label   string                  `json:"label"`
	Model   string                  `json:"model"`
	Effort  string                  `json:"effort"`
	Results []storage.DegradeResult `json:"results"`
	// Before / State 是这轮前后的确认状态，Changed 表示这轮改了状态。
	Before  storage.DegradeState `json:"before"`
	State   storage.DegradeState `json:"state"`
	Changed bool                 `json:"changed"`
	Message string               `json:"message"`
	// Err 非空表示有请求失败，这轮不算数。
	Err  string `json:"error,omitempty"`
	Busy bool   `json:"busy,omitempty"`
}

// checkKey 按巡检规则跑一轮：先测一次，需要时复测两次，三次一致才改状态。
func (s *Service) checkKey(ctx context.Context, id uint) (*Round, error) {
	if !s.lock(id) {
		return nil, ErrBusy
	}
	defer s.unlock(id)
	k, c, apiKey, err := s.load(id)
	if err != nil {
		return nil, err
	}
	model, effort := s.modelOf(k)
	round := &Round{KeyID: k.ID, Label: keyLabel(c.Name, k), Model: model, Effort: effort, Before: k.State, State: k.State}
	installation := fmt.Sprintf("upstream-ops:%d:%d", k.ChannelID, k.UpstreamKeyID)

	ask := func(attempt int) (storage.DegradeResult, error) {
		label := "首测"
		if attempt > 1 {
			label = fmt.Sprintf("复测第 %d 次", attempt-1)
		}
		progress.Start(ctx, progress.StageDegrade, fmt.Sprintf("%s：%s · %s", label, model, effortText(effort)))
		actx, cancel := context.WithTimeout(ctx, askTimeout)
		answer, elapsed, askErr := s.Ask(actx, c.SiteURL, apiKey, installation, model, askEffort(effort))
		cancel()
		if askErr != nil && ctx.Err() != nil {
			return "", ctx.Err() // 任务被取消（服务停止或超时），这次不记
		}
		check := &storage.DegradeCheck{
			KeyID: k.ID, ChannelID: k.ChannelID, Attempt: attempt, Model: model, Effort: effort,
			Answer: truncate(answer.Text, maxAnswerRunes), InputTokens: answer.InputTokens,
			OutputTokens: answer.OutputTokens, ReasoningTokens: answer.ReasoningTokens,
			DurationMs: elapsed.Milliseconds(), CheckedAt: time.Now(),
		}
		switch {
		case askErr != nil:
			check.Result, check.Error = storage.DegradeFailed, askErr.Error()
		case HasStandalone21(answer.Text):
			check.Result = storage.DegradeCorrect
		default:
			check.Result = storage.DegradeWrong
		}
		if err := s.repo.AppendCheck(check); err != nil {
			s.log.Warn("record degrade check", "key", k.ID, "err", err)
		}
		round.Results = append(round.Results, check.Result)
		took := fmt.Sprintf("（%s）", elapsed.Round(time.Second))
		switch check.Result {
		case storage.DegradeFailed:
			progress.Fail(ctx, progress.StageDegrade, label+"请求失败："+askErr.Error())
		case storage.DegradeCorrect:
			progress.OK(ctx, progress.StageDegrade, label+"答对"+took)
		default:
			progress.Fail(ctx, progress.StageDegrade, label+"答错"+took)
		}
		return check.Result, askErr
	}

	first, err := ask(1)
	if err != nil && ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		round.Err = err.Error()
		round.Message = "请求失败，状态不变：" + err.Error()
		s.finish(ctx, k, c, round, first)
		return round, nil
	}

	switch {
	case k.State == storage.DegradeNormal && first == storage.DegradeCorrect:
		round.Message = "首测答对，保持正常"
	case k.State == storage.DegradeDegraded && first == storage.DegradeWrong:
		round.Message = "首测答错，保持降智"
	default:
		if k.State == storage.DegradeDegraded {
			progress.Start(ctx, progress.StageDegrade, fmt.Sprintf("首测答对，等 %s 后复测两次", s.RecoveryWait.Round(time.Second)))
			if err := sleep(ctx, s.RecoveryWait); err != nil {
				return nil, err
			}
		}
		for attempt := 2; attempt <= 3; attempt++ {
			if _, err := ask(attempt); err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				round.Err = err.Error()
				round.Message = "复测请求失败，状态不变：" + err.Error()
				s.finish(ctx, k, c, round, first)
				return round, nil
			}
		}
		s.decide(k, round)
	}
	s.finish(ctx, k, c, round, first)
	return round, nil
}

// decide 看三次结果是否一致，一致就确认状态，写好这轮的说明。
func (s *Service) decide(k *storage.DegradeKey, round *Round) {
	correct := 0
	for _, r := range round.Results {
		if r == storage.DegradeCorrect {
			correct++
		}
	}
	tally := fmt.Sprintf("三次里答对 %d 次、答错 %d 次", correct, len(round.Results)-correct)
	switch correct {
	case len(round.Results):
		round.State = storage.DegradeNormal
	case 0:
		round.State = storage.DegradeDegraded
	default:
		round.Message = tally + "，结果不一致，保持" + stateText(k.State)
		return
	}
	round.Changed = round.State != k.State
	switch {
	case !round.Changed:
		round.Message = tally + "，保持" + stateText(k.State)
	case round.State == storage.DegradeDegraded:
		round.Message = "三次都答错，确认降智"
	case k.State == storage.DegradeDegraded:
		round.Message = "三次都答对，确认恢复"
	default:
		round.Message = "三次都答对，确认正常"
	}
}

// finish 记下这轮结论，状态变了就发通知：确认降智、确认恢复都发；未确认的密钥第一次定为正常不发。
func (s *Service) finish(ctx context.Context, k *storage.DegradeKey, c *storage.Channel, round *Round, first storage.DegradeResult) {
	state := storage.DegradeState("")
	if round.Changed {
		state = round.State
	}
	if err := s.repo.RecordRound(k.ID, time.Now(), first, round.Message, state); err != nil {
		s.log.Warn("record degrade round", "key", k.ID, "err", err)
	}
	if round.Err == "" {
		progress.OK(ctx, progress.StageDone, round.Message)
	}
	if !round.Changed || (round.State == storage.DegradeNormal && round.Before == storage.DegradeUnknown) {
		return
	}
	if err := s.notifier.Dispatch(ctx, buildMessage(k, c, round)); err != nil {
		s.log.Warn("dispatch degrade notification", "key", k.ID, "err", err)
	}
}

func buildMessage(k *storage.DegradeKey, c *storage.Channel, round *Round) notify.Message {
	verdict := "确认降智"
	if round.State == storage.DegradeNormal {
		verdict = "已恢复"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# GPT 降智检测\n\n> 检测时间：%s\n\n", time.Now().Format("2006-01-02 15:04"))
	fmt.Fprintf(&b, "- 渠道：%s\n", c.Name)
	fmt.Fprintf(&b, "- 密钥：%s\n", keyName(k))
	if k.GroupName != "" {
		fmt.Fprintf(&b, "- 分组：%s\n", k.GroupName)
	}
	fmt.Fprintf(&b, "- 模型：%s · %s\n", round.Model, effortText(round.Effort))
	fmt.Fprintf(&b, "- 判定：**%s**（%s）\n", verdict, round.Message)
	return notify.Message{
		Event:     storage.EventDegrade,
		ChannelID: c.ID,
		Subject:   fmt.Sprintf("【降智检测】%s %s", keyLabel(c.Name, k), verdict),
		Body:      b.String(),
	}
}

// Summary 是一次全部检测的结果。
type Summary struct {
	Total    int      `json:"total"`
	Normal   int      `json:"normal"`
	Degraded int      `json:"degraded"`
	Unknown  int      `json:"unknown"`
	Failed   int      `json:"failed"`
	Busy     int      `json:"busy"`
	Changes  []string `json:"changes,omitempty"`
	Rounds   []*Round `json:"rounds"`

	failedNames []string
	errors      []string
}

func (s *Summary) add(r *Round) {
	s.Rounds = append(s.Rounds, r)
	switch {
	case r.Busy:
		s.Busy++
		return
	case r.Err != "":
		s.Failed++
		s.failedNames = append(s.failedNames, r.Label)
		s.errors = append(s.errors, r.Label+"："+r.Err)
	}
	switch r.State {
	case storage.DegradeNormal:
		s.Normal++
	case storage.DegradeDegraded:
		s.Degraded++
	default:
		s.Unknown++
	}
	if r.Changed {
		s.Changes = append(s.Changes, r.Label+" "+r.Message)
	}
}

// Message 一句话结果，例如“5 把密钥：正常 3，降智 1，未确认 1；请求失败 1（某站 · 某密钥）”。
func (s *Summary) Message() string {
	if s.Total == 0 {
		return "还没有加入检测的密钥"
	}
	msg := fmt.Sprintf("%d 把密钥：正常 %d，降智 %d，未确认 %d", s.Total, s.Normal, s.Degraded, s.Unknown)
	if s.Failed > 0 {
		msg += fmt.Sprintf("；请求失败 %d（%s）", s.Failed, strings.Join(s.failedNames, "、"))
	}
	if s.Busy > 0 {
		msg += fmt.Sprintf("；正在单独检测、这次跳过 %d", s.Busy)
	}
	if done := len(s.Rounds); done < s.Total {
		msg += fmt.Sprintf("；未跑 %d", s.Total-done)
	}
	if len(s.Changes) > 0 {
		msg += "；状态变化：" + strings.Join(s.Changes, "、")
	}
	return msg
}

// Err 有密钥请求失败时返回汇总的错误，任务记为失败。
func (s *Summary) Err() error {
	if s.Failed == 0 {
		return nil
	}
	return errors.New(strings.Join(s.errors, "；"))
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// askEffort 把 "none" 换成空字符串：请求里不带推理强度，由上游决定。
func askEffort(effort string) string {
	if effort == "none" {
		return ""
	}
	return effort
}

func effortText(effort string) string {
	if effort == "none" || effort == "" {
		return "推理强度由上游决定"
	}
	return effort
}

func stateText(st storage.DegradeState) string {
	switch st {
	case storage.DegradeNormal:
		return "正常"
	case storage.DegradeDegraded:
		return "降智"
	default:
		return "未确认"
	}
}

func keyName(k *storage.DegradeKey) string {
	name := k.Name
	if name == "" {
		name = fmt.Sprintf("密钥 #%d", k.UpstreamKeyID)
	}
	if k.KeyTail != "" {
		name += "（尾号 " + k.KeyTail + "）"
	}
	return name
}

func keyLabel(channelName string, k *storage.DegradeKey) string {
	name := k.Name
	if name == "" {
		name = fmt.Sprintf("密钥 #%d", k.UpstreamKeyID)
	}
	if channelName == "" {
		return name
	}
	return channelName + " · " + name
}

func groupOf(k connector.APIKey) string {
	if g := strings.TrimSpace(k.GroupName); g != "" {
		return g
	}
	return strings.TrimSpace(k.Group)
}

// tailOf 取密钥末 4 位，页面上用来辨认。
func tailOf(key string) string {
	r := []rune(strings.TrimSpace(key))
	if len(r) <= 4 {
		return ""
	}
	return string(r[len(r)-4:])
}

// visibleTail 取站点列表里打码密钥的末 4 位；末尾也打了码或不够长时返回空，表示没法比。
func visibleTail(masked string) string {
	tail := tailOf(masked)
	if strings.ContainsAny(tail, "*•.…") {
		return ""
	}
	return tail
}
