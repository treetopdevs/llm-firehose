package capture_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

func TestAdmissionImmediatelyProjectsCapturedEvent(t *testing.T) {
	engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	ev := observation()
	ev.ID = "projected-1"
	ev.SessionID = "session-1"
	ev.TraceID = "trace-1"
	ev.Category = event.CategoryFile
	ev.Payload = map[string]any{"file_path": "/repo/main.go"}
	if _, err := engine.Admit(context.Background(), ev); err != nil {
		t.Fatal(err)
	}

	sessions := engine.Sessions()
	if len(sessions) != 1 || sessions[0].ID != "session-1" || sessions[0].Events != 1 {
		t.Fatalf("sessions = %+v", sessions)
	}
	sessionEvents, err := engine.Session("session-1")
	if err != nil || len(sessionEvents) != 1 || sessionEvents[0].ID != ev.ID {
		t.Fatalf("Session = %+v, %v", sessionEvents, err)
	}
	traceEvents, err := engine.Trace("trace-1")
	if err != nil || len(traceEvents) != 1 || traceEvents[0].ID != ev.ID {
		t.Fatalf("Trace = %+v, %v", traceEvents, err)
	}
	files := engine.Files()
	if len(files) != 1 || files[0].Path != "/repo/main.go" || files[0].Events != 1 {
		t.Fatalf("files = %+v", files)
	}
}

func TestPresentationDeduplicatesStableIDsWhileExportPreservesObservations(t *testing.T) {
	dir := t.TempDir()
	engine, err := capture.New(capture.Options{SpoolDir: dir, Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	ev := observation()
	ev.ID = "stable-replay"
	ev.SessionID = "session-replay"
	for range 2 {
		if _, err := engine.Admit(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}

	history, err := engine.Recent(10)
	if err != nil || len(history) != 1 {
		t.Fatalf("Recent = %+v, %v", history, err)
	}
	sessions := engine.Sessions()
	if len(sessions) != 1 || sessions[0].Events != 1 {
		t.Fatalf("sessions = %+v", sessions)
	}
	var exported bytes.Buffer
	count, err := engine.Export(&exported)
	if err != nil || count != 2 {
		t.Fatalf("Export count=%d err=%v", count, err)
	}
	dec := json.NewDecoder(&exported)
	for i := range 2 {
		var got event.Event
		if err := dec.Decode(&got); err != nil || got.ID != ev.ID {
			t.Fatalf("export record %d = %+v, %v", i, got, err)
		}
	}
}

func TestNewRebuildsAllDerivedStateFromSpool(t *testing.T) {
	dir := t.TempDir()
	first, err := capture.New(capture.Options{SpoolDir: dir, Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	ev := observation()
	ev.ID = "restart-1"
	ev.SessionID = "session-restart"
	if _, err := first.Admit(context.Background(), ev); err != nil {
		t.Fatal(err)
	}

	restarted, err := capture.New(capture.Options{SpoolDir: dir, Policy: privacy.ModeMinimal})
	if err != nil {
		t.Fatal(err)
	}
	sessions := restarted.Sessions()
	if len(sessions) != 1 || sessions[0].ID != ev.SessionID || sessions[0].Events != 1 {
		t.Fatalf("rebuilt sessions = %+v", sessions)
	}
}

func TestOneShotWriteReconcilesExactlyOnceIntoRunningEngine(t *testing.T) {
	dir := t.TempDir()
	engine, err := capture.New(capture.Options{SpoolDir: dir, Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()

	ev := observation()
	ev.ID = "one-shot-running"
	ev.SessionID = "session-one-shot"
	if _, err := capture.AdmitOnce(context.Background(), capture.OneShotOptions{
		SpoolDir: dir,
		Policy:   privacy.ModeFull,
	}, ev); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		sessions := engine.Sessions()
		if len(sessions) == 1 && sessions[0].Events == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("one-shot event was not reconciled once: %+v", sessions)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestLiveSubscriptionReceivesSerializedAdmissionsInOrder(t *testing.T) {
	engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	subscription := engine.Subscribe(ctx)
	for _, id := range []string{"ordered-1", "ordered-2", "ordered-3"} {
		ev := observation()
		ev.ID = id
		if _, err := engine.Admit(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"ordered-1", "ordered-2", "ordered-3"} {
		select {
		case got := <-subscription.Events:
			if got.ID != id {
				t.Fatalf("live order got %q, want %q", got.ID, id)
			}
		case <-time.After(time.Second):
			t.Fatalf("subscription did not receive %q", id)
		}
	}
}

func TestSlowSubscriptionTerminatesWithoutBlockingCapture(t *testing.T) {
	engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	slow := engine.Subscribe(context.Background())
	healthy := engine.Subscribe(context.Background())
	for i := range 300 {
		ev := observation()
		ev.ID = fmt.Sprintf("overflow-%03d", i)
		if _, err := engine.Admit(context.Background(), ev); err != nil {
			t.Fatalf("Admit %d: %v", i, err)
		}
		select {
		case <-healthy.Events:
		case <-time.After(time.Second):
			t.Fatalf("healthy subscriber blocked at %d", i)
		}
	}
	select {
	case err := <-slow.Done:
		if !errors.Is(err, capture.ErrSubscriptionOverflow) {
			t.Fatalf("slow subscription ended with %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("slow subscription was not terminated on overflow")
	}

	ev := observation()
	ev.ID = "after-overflow"
	if _, err := engine.Admit(context.Background(), ev); err != nil {
		t.Fatalf("capture unhealthy after overflow: %v", err)
	}
}

func TestLiveSubscriptionSuppressesStableIDReplay(t *testing.T) {
	engine, err := capture.New(capture.Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	subscription := engine.Subscribe(context.Background())
	ev := observation()
	ev.ID = "live-replay"
	for range 2 {
		if _, err := engine.Admit(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
	}
	if got := <-subscription.Events; got.ID != ev.ID {
		t.Fatalf("first live event = %+v", got)
	}
	select {
	case duplicate := <-subscription.Events:
		t.Fatalf("stable replay was projected twice: %+v", duplicate)
	case <-time.After(100 * time.Millisecond):
	}
}
