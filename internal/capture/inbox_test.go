package capture_test

import (
	"agentfirehose/internal/adapters/claudecode"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/capture"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func inboxEngine(t *testing.T, dir string) *capture.Engine {
	t.Helper()
	e, err := capture.New(capture.Options{SpoolDir: dir, Policy: privacy.ModeBalanced})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func admitInbox(t *testing.T, e *capture.Engine, id, source, session string, category event.Category, name string, second int) event.Event {
	t.Helper()
	ev, err := e.Admit(context.Background(), event.Event{ID: id, Source: source, SessionID: session, Category: category, Name: name, Summary: name,
		Time: time.Date(2026, 9, 6, 12, 0, second, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	return ev
}

func TestAttentionRequestSurvivesRestartAndDuplicateAdmission(t *testing.T) {
	dir := t.TempDir()
	e := inboxEngine(t, dir)
	ev := admitInbox(t, e, "request", "codex", "s", event.CategoryPermission, "PermissionRequest", 0)
	if _, err := e.Admit(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	got := e.Attention()
	if len(got.Sessions) != 1 || got.Sessions[0].Pending == nil {
		t.Fatalf("no pending request: %+v", got)
	}
	s := got.Sessions[0]
	if s.Pending.EventID != "request" || s.Pending.Kind != "request" || s.Events != 1 {
		t.Fatalf("incorrect episode: %+v", s)
	}
	if got.Sessions[0].Pending.ObservedAt.IsZero() {
		t.Fatal("missing observation timestamp")
	}
	restarted := inboxEngine(t, dir).Attention()
	if !reflect.DeepEqual(got.Sessions, restarted.Sessions) {
		t.Fatalf("restart changed attention: %+v", restarted.Sessions)
	}
}

func TestAttentionResolutionIgnoresMetadataOtherSourcesAndLateRequests(t *testing.T) {
	e := inboxEngine(t, t.TempDir())
	admitInbox(t, e, "r1", "codex", "same", event.CategoryPermission, "PermissionRequest", 1)
	admitInbox(t, e, "meta", "codex", "same", event.CategoryMeta, "PreCompact", 2)
	admitInbox(t, e, "child", "codex", "same", event.CategorySession, "SubagentStop", 3)
	admitInbox(t, e, "other", "opencode", "same", event.CategoryMessage, "message.updated", 4)
	got := e.Attention()
	if len(got.Sessions) != 2 || got.Sessions[0].Pending == nil {
		t.Fatalf("lost source-scoped request: %+v", got)
	}
	admitInbox(t, e, "resume", "codex", "same", event.CategoryTool, "PreToolUse", 5)
	admitInbox(t, e, "late", "codex", "same", event.CategoryPermission, "PermissionRequest", 0)
	got = e.Attention()
	if got.Sessions[0].Pending != nil || got.Sessions[0].State != "working" {
		t.Fatalf("resolved request reopened: %+v", got.Sessions[0])
	}
	admitInbox(t, e, "r2", "codex", "same", event.CategoryPermission, "PermissionRequest", 6)
	if e.Attention().Sessions[0].Pending.EventID != "r2" {
		t.Fatal("new episode not created")
	}
	admitInbox(t, e, "stop", "codex", "same", event.CategorySession, "Stop", 7)
	if s := e.Attention().Sessions[0]; s.Pending != nil || s.State != "done" {
		t.Fatalf("completion not resolved: %+v", s)
	}
}

func TestAttentionUsesCapturedClaudeEvidenceAndKeepsToolFailuresPassive(t *testing.T) {
	for _, tt := range []struct{ file, kind string }{
		{"notification.json", "request"}, {"stop_failure.json", "failure"}, {"post_tool_use_failure.json", ""},
	} {
		t.Run(tt.file, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("..", "adapters", "claudecode", "testdata", tt.file))
			if err != nil {
				t.Fatal(err)
			}
			ev, err := claudecode.Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			e := inboxEngine(t, t.TempDir())
			admitted, err := e.Admit(context.Background(), *ev)
			if err != nil {
				t.Fatal(err)
			}
			s := e.Attention().Sessions[0]
			if s.CWD != admitted.CWD || s.CWD == ev.CWD {
				t.Fatalf("workspace must match privacy-processed evidence: %+v", s)
			}
			if tt.kind == "" {
				if s.Pending != nil {
					t.Fatal("tool failure triggered attention")
				}
				return
			}
			if s.Pending == nil || s.Pending.Kind != tt.kind || s.Pending.EventID != admitted.ID {
				t.Fatalf("wrong captured evidence: %+v", s)
			}
		})
	}
}

func TestAttentionUnknownPermissionIsUncertainAndReplyResolves(t *testing.T) {
	e := inboxEngine(t, t.TempDir())
	admitInbox(t, e, "unknown", "claude-code", "s", event.CategoryPermission, "Notification", 0)
	s := e.Attention().Sessions[0]
	if s.Pending != nil || s.Uncertainty == "" {
		t.Fatalf("unknown notification was trusted: %+v", s)
	}
	admitInbox(t, e, "r", "opencode", "s", event.CategoryPermission, "permission.updated", 1)
	admitInbox(t, e, "reply", "opencode", "s", event.CategoryPermission, "permission.replied", 2)
	s = e.Attention().Sessions[1]
	if s.Pending != nil || s.State != "working" {
		t.Fatalf("reply did not resolve: %+v", s)
	}
}

func TestAttentionWarningEvidenceAndQueriesAreDetached(t *testing.T) {
	dir := t.TempDir()
	e := inboxEngine(t, dir)
	ev := event.Event{ID: "warning", Time: time.Now().UTC(), Source: "codex", Category: event.CategoryMeta, Name: "adapter.unknown_event", Severity: event.SeverityWarn, Summary: "unmapped source event", Payload: map[string]any{"native": "unknown"}}
	admitted, err := e.Admit(context.Background(), ev)
	if err != nil {
		t.Fatal(err)
	}
	got := e.Attention()
	if len(got.Warnings) != 1 || got.Warnings[0].EventID != "warning" {
		t.Fatalf("missing capture warning: %+v", got)
	}
	exact, err := e.Event("warning")
	if err != nil || !reflect.DeepEqual(exact, admitted) {
		t.Fatalf("wrong evidence: %+v %v", exact, err)
	}
	admitInbox(t, e, "r", "codex", "s", event.CategoryPermission, "PermissionRequest", 0)
	got = e.Attention()
	got.Sessions[0].Pending.Summary = "modified"
	got.Warnings[0].Summary = "modified"
	clean := inboxEngine(t, dir).Attention()
	if !reflect.DeepEqual(e.Attention(), clean) {
		t.Fatal("snapshot mutation or rebuild altered evidence")
	}
	if _, err := e.Event("missing"); err == nil {
		t.Fatal("missing evidence succeeded")
	}
}

func TestAttentionCoalescesNativeRequestAndWarnsWithoutSession(t *testing.T) {
	e := inboxEngine(t, t.TempDir())
	ev := event.Event{ID: "r1", Source: "codex", SessionID: "s", Category: event.CategoryPermission, Name: "PermissionRequest", CallID: "call", Time: time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)}
	if _, err := e.Admit(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	ev.ID = "r2"
	ev.Time = ev.Time.Add(time.Second)
	if _, err := e.Admit(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if s := e.Attention().Sessions[0]; s.Pending.EventID != "r1" {
		t.Fatalf("repeat native request became new episode: %+v", s)
	}
	ev.ID = "w"
	ev.SessionID = ""
	ev.Category = event.CategoryMeta
	ev.Name = "adapter.unknown_event"
	ev.Severity = event.SeverityWarn
	if _, err := e.Admit(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if e.Attention().Warnings[0].Source != "codex" {
		t.Fatal("warning lacks source")
	}
}

func TestAttentionPreservesSourceClockAndMinimalPrivacyUncertainty(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "adapters", "claudecode", "testdata", "notification.json"))
	if err != nil {
		t.Fatal(err)
	}
	ev, err := claudecode.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	sourceTime := ev.Time.Add(-time.Minute)
	ev.SourceTime = &sourceTime
	e, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeMinimal})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Admit(context.Background(), *ev); err != nil {
		t.Fatal(err)
	}
	got := e.Attention().Sessions[0]
	if got.Pending != nil || got.Uncertainty == "" {
		t.Fatalf("redacted request classification must remain uncertain: %+v", got)
	}
	if got.Last.SourceTime == nil || !got.Last.SourceTime.Equal(sourceTime) {
		t.Fatal("source clock lost")
	}
	*got.Last.SourceTime = time.Time{}
	if e.Attention().Sessions[0].Last.SourceTime.IsZero() {
		t.Fatal("caller changed source clock")
	}
}
