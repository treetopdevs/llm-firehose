package index

import (
	"time"

	"agentfirehose/internal/event"
)

// SessionState is the derived primary attention state for one session.
type SessionState string

const (
	StateWorking    SessionState = "working"
	StateNeedsInput SessionState = "needs_input"
	StateIdle       SessionState = "idle"
	StateDone       SessionState = "done"

	// IdleAfter is how long a working session may sit without events before
	// becoming idle. needs_input sessions never idle — they need the human.
	IdleAfter = 90 * time.Second
)

// Attention is the pure attention snapshot for one session.
type Attention struct {
	State    SessionState
	Since    time.Time
	Reason   string
	HasError bool
}

// Transition applies one event to an attention snapshot. changed is false
// when the primary state, reason, and error overlay are unchanged.
func Transition(prev Attention, ev event.Event) (Attention, bool) {
	next := prev
	t := ev.Time

	switch {
	case isPermissionReply(ev):
		// The human answered; the agent resumes on its own.
		next.State = StateWorking
		next.Since = t
		next.Reason = ""

	case ev.Category == event.CategoryPermission:
		next.State = StateNeedsInput
		next.Since = t
		next.Reason = ev.Summary

	case isSessionEnd(ev):
		next.State = StateDone
		next.Since = t
		next.Reason = ""

	case isActivity(ev):
		if prev.State != StateWorking || prev.HasError || prev.Reason != "" {
			next.State = StateWorking
			next.Since = t
			next.Reason = ""
			next.HasError = false
		}

	case prev.State == StateDone:
		// Stay done for non-activity, non-end events (e.g. meta).
	}

	if ev.Category == event.CategoryError || ev.Severity == event.SeverityError {
		next.HasError = true
	}

	if next.State != prev.State || next.Reason != prev.Reason || next.HasError != prev.HasError {
		return next, true
	}
	return next, false
}

// TickIdle moves a working session to idle when quiet long enough.
// needs_input and done are never transitioned to idle, and neither is a
// session with an open tool call (toolOpen) — a long-running command between
// PreToolUse and PostToolUse is the agent waiting on its tool, not idleness.
func TickIdle(prev Attention, lastActivity, now time.Time, toolOpen bool) (Attention, bool) {
	if prev.State != StateWorking || toolOpen {
		return prev, false
	}
	if now.Sub(lastActivity) < IdleAfter {
		return prev, false
	}
	next := prev
	next.State = StateIdle
	next.Since = now
	next.Reason = ""
	return next, true
}

func isSessionEnd(ev event.Event) bool {
	if ev.Category != event.CategorySession {
		return false
	}
	switch ev.Name {
	case "Stop", "SessionEnd", "SubagentStop", // claude-code hooks
		"task_complete",                   // codex turn completion
		"session.idle", "session.deleted": // opencode lifecycle
		return true
	}
	return false
}

// isPermissionReply reports whether the permission event is the human's
// answer (opencode permission.replied) rather than a new request.
func isPermissionReply(ev event.Event) bool {
	return ev.Category == event.CategoryPermission && ev.Name == "permission.replied"
}

func isActivity(ev event.Event) bool {
	switch ev.Category {
	case event.CategoryTool, event.CategoryMessage, event.CategoryFile,
		event.CategoryShell, event.CategoryPrompt:
		return true
	}
	return false
}
