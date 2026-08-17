package capture

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"agentfirehose/internal/adapters/procwatch"
	"agentfirehose/internal/privacy"
)

type appearingProcess struct{ calls atomic.Int32 }

func (l *appearingProcess) List() ([]procwatch.Process, error) {
	if l.calls.Add(1) == 1 {
		return nil, nil
	}
	return []procwatch.Process{{PID: 4242, Command: "claude"}}, nil
}

func TestProcessSourceObservationIsAdmittedAndPersisted(t *testing.T) {
	lister := &appearingProcess{}
	engine, err := New(Options{
		SpoolDir: t.TempDir(), Policy: privacy.ModeFull,
		Sources: []Source{newProcessSource(lister, 10*time.Millisecond)},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- engine.Run(ctx) }()
	defer func() {
		cancel()
		<-done
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		history, err := engine.Recent(20)
		if err != nil {
			t.Fatal(err)
		}
		for _, ev := range history {
			if ev.Source == procwatch.Source && ev.Name == "agent-start" && ev.Agent == "claude" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("process Source Adapter event was not persisted: %+v", history)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCodexPreparationWarningIsAdmittedDuringNew(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(t.TempDir(), "codex-cursors.json")
	if err := os.WriteFile(statePath, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	engine, err := New(Options{
		SpoolDir: t.TempDir(), Policy: privacy.ModeBalanced,
		Sources: []Source{newCodexSource(root, statePath, 10*time.Millisecond)},
	})
	if err != nil {
		t.Fatal(err)
	}
	history, err := engine.Recent(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].Name != "rollout_capture_error" || history[0].Severity != "warn" {
		t.Fatalf("Codex initialization warning = %+v", history)
	}
	matches, err := filepath.Glob(statePath + ".corrupt-*")
	if err != nil || len(matches) != 1 {
		t.Fatalf("quarantined cursor = %v, %v", matches, err)
	}
}

func TestSourceOwnershipTransfersAfterActiveEngineReleases(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "engine.lock")
	first := &sourceLease{path: lockPath}
	second := &sourceLease{path: lockPath}
	firstRelease, err := first.claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	type claim struct {
		release func()
		err     error
	}
	claimed := make(chan claim, 1)
	go func() {
		release, err := second.claim(ctx)
		claimed <- claim{release: release, err: err}
	}()
	select {
	case got := <-claimed:
		if got.release != nil {
			got.release()
		}
		firstRelease()
		t.Fatal("second engine acquired Source ownership concurrently")
	case <-time.After(2 * sourceOwnershipPollInterval):
	}
	firstRelease()
	select {
	case got := <-claimed:
		if got.err != nil {
			t.Fatal(got.err)
		}
		got.release()
	case <-ctx.Done():
		t.Fatal("Source ownership did not transfer after release")
	}
}
