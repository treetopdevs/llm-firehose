package capture

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func TestProjectionFailureAfterCommitReconcilesWithoutAdmissionRetry(t *testing.T) {
	engine, err := New(Options{SpoolDir: t.TempDir(), Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	realProject := engine.project
	failed := false
	engine.project = func(ev event.Event) error {
		if !failed {
			failed = true
			return errors.New("injected projection failure")
		}
		return realProject(ev)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()
	ev := event.Event{
		ID:        "projection-recovery",
		Time:      time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC),
		Source:    "generic",
		Category:  event.CategoryMessage,
		SessionID: "projection-session",
	}
	stored, err := engine.Admit(context.Background(), ev)
	if err != nil || stored.ID != ev.ID {
		cancel()
		t.Fatalf("committed Admission = %+v, %v", stored, err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		sessions := engine.Sessions()
		if len(sessions) == 1 && sessions[0].Events == 1 {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("projection was not recovered: %+v", sessions)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
	history, err := engine.Export(io.Discard)
	if err != nil || history != 1 {
		t.Fatalf("source retry duplicated commit: count=%d err=%v", history, err)
	}
}
