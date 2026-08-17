package capture

import (
	"context"
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
