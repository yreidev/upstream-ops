package monitor

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/yreidev/upstream-ops/backend/channel"
	"github.com/yreidev/upstream-ops/backend/progress"
)

// ScanSummary 是一轮批量采集的结果，存进后台任务记录。
type ScanSummary struct {
	Total   int      `json:"total"`
	Success int      `json:"success"`
	Failed  int      `json:"failed"`
	Skipped int      `json:"skipped"` // 登录退避中，这轮没去请求上游
	Errors  []string `json:"errors,omitempty"`

	failedNames []string
}

// record 记下一个渠道的结果，并发一条带渠道的结论事件，页面按渠道显示。
func (s *ScanSummary) record(ctx context.Context, name string, err error) {
	switch {
	case err == nil:
		s.Success++
		progress.OK(ctx, progress.StageDone, "同步完成")
	case channel.IsBackoff(err):
		s.Skipped++
		progress.Skip(ctx, "本轮跳过："+err.Error())
	default:
		s.Failed++
		s.failedNames = append(s.failedNames, name)
		s.Errors = append(s.Errors, name+"："+err.Error())
		progress.Fail(ctx, progress.StageError, "同步失败："+err.Error())
	}
}

// Message 一句话结果，例如“7 个渠道：成功 6，失败 1（某站）”。
func (s *ScanSummary) Message() string {
	if s.Total == 0 {
		return "没有要采集的渠道"
	}
	msg := fmt.Sprintf("%d 个渠道：成功 %d", s.Total, s.Success)
	if s.Failed > 0 {
		msg += fmt.Sprintf("，失败 %d（%s）", s.Failed, strings.Join(s.failedNames, "、"))
	}
	if s.Skipped > 0 {
		msg += fmt.Sprintf("，登录退避跳过 %d", s.Skipped)
	}
	if done := s.Success + s.Failed + s.Skipped; done < s.Total {
		msg += fmt.Sprintf("，未跑 %d", s.Total-done)
	}
	return msg
}

// Err 有渠道失败时返回汇总的错误，任务记为失败。
func (s *ScanSummary) Err() error {
	if s.Failed == 0 {
		return nil
	}
	return errors.New(strings.Join(s.Errors, "；"))
}
