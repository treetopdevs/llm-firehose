package capture_test

import (
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

func observation() event.Event {
	return event.Event{
		Time:     time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC),
		Source:   "generic",
		Category: event.CategoryPrompt,
		Summary:  "capture me",
		Payload:  map[string]any{"prompt": "private value"},
	}
}

func TestAdmissionReturnsTheCapturedEvent(t *testing.T) {
	dir := t.TempDir()
	engine, err := capture.New(capture.Options{SpoolDir: dir, Policy: privacy.ModeBalanced})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	got, err := engine.Admit(context.Background(), observation())
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}
	if got.ID == "" || got.SchemaVersion != event.CurrentSchemaVersion || got.CaptureTime == nil {
		t.Fatalf("captured event is incomplete: %+v", got)
	}
	if got.Raw != "" || got.Payload["prompt"] != "private value" {
		t.Fatalf("balanced policy result = %+v", got)
	}

	history, err := engine.Recent(1)
	if err != nil {
		t.Fatalf("Recent: %v", err)
	}
	if len(history) != 1 || !reflect.DeepEqual(history[0], got) {
		t.Fatalf("history = %+v, want captured event %+v", history, got)
	}
}

func TestAdmissionAppliesEveryCapturePolicy(t *testing.T) {
	tests := []struct {
		name      string
		policy    privacy.Mode
		wantRaw   string
		wantValue any
	}{
		{name: "minimal", policy: privacy.ModeMinimal, wantValue: map[string]any{"sha256": "3889abc195887d2ed1f1bbb05eb25761fca526d8d2167438228ac5077c27aae7", "len": 13}},
		{name: "balanced", policy: privacy.ModeBalanced, wantValue: "private value"},
		{name: "full", policy: privacy.ModeFull, wantRaw: "native private value", wantValue: "private value"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: tt.policy})
			if err != nil {
				t.Fatal(err)
			}
			ev := observation()
			ev.Raw = "native private value"
			got, err := engine.Admit(context.Background(), ev)
			if err != nil {
				t.Fatal(err)
			}
			if got.Raw != tt.wantRaw || !reflect.DeepEqual(got.Payload["prompt"], tt.wantValue) {
				t.Fatalf("policy result raw=%q payload=%#v", got.Raw, got.Payload["prompt"])
			}
		})
	}
}

func TestSetPolicyAppliesAtomicallyToLaterAdmissions(t *testing.T) {
	engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	engine.SetPolicy(privacy.ModeMinimal)
	got, err := engine.Admit(context.Background(), observation())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got.Payload["prompt"].(map[string]any); !ok {
		t.Fatalf("updated policy was not applied: %+v", got.Payload)
	}
}

func TestAdmissionEnrichesWorkspaceBeforeCapturePolicy(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	cwd := filepath.Join(repo, "nested")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	engine, err := capture.New(capture.Options{
		SpoolDir: filepath.Join(root, "spool"),
		Policy:   privacy.ModeMinimal,
	})
	if err != nil {
		t.Fatal(err)
	}
	ev := observation()
	ev.CWD = cwd
	got, err := engine.Admit(context.Background(), ev)
	if err != nil {
		t.Fatal(err)
	}
	if got.RepoID == "" || got.WorktreeID == "" {
		t.Fatalf("minimal policy did not retain enriched identity as digests: %+v", got)
	}
	if got.RepoID == filepath.Join(repo, ".git") || got.WorktreeID == repo {
		t.Fatalf("identity was enriched after policy and leaked paths: %+v", got)
	}
	if _, ok := got.Payload["prompt"].(map[string]any); !ok {
		t.Fatalf("minimal payload was not digested: %+v", got.Payload)
	}
}

func TestOneShotAdmissionSharesCaptureSemantics(t *testing.T) {
	dir := t.TempDir()
	got, err := capture.AdmitOnce(context.Background(), capture.OneShotOptions{
		SpoolDir: dir,
		Policy:   privacy.ModeMinimal,
	}, observation())
	if err != nil {
		t.Fatalf("AdmitOnce: %v", err)
	}
	if got.ID == "" || got.CaptureTime == nil {
		t.Fatalf("one-shot result is incomplete: %+v", got)
	}
	if _, ok := got.Payload["prompt"].(map[string]any); !ok {
		t.Fatalf("one-shot did not apply policy: %+v", got.Payload)
	}
}

func TestAdmissionHonorsCancellationBeforeCommit(t *testing.T) {
	engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeBalanced})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := engine.Admit(ctx, observation()); err == nil {
		t.Fatal("Admit succeeded with a canceled context")
	}
	history, err := engine.Recent(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 0 {
		t.Fatalf("canceled observation reached history: %+v", history)
	}
}
