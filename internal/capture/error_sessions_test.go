package capture

import (
	"context"
	"errors"
	"testing"

	"agentfirehose/internal/capture/internal/spool"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func TestErrorSessionsUsesProjectionAndValidatesBounds(t *testing.T) {
	dir := t.TempDir()
	ev := historyEvent("error-one", "session-one", "", 1, 1)
	ev.Category = event.CategoryError
	ev.Summary = "failure"
	appendRawRecord(t, dir, ev)
	scan := func(context.Context, string, string, spool.Prefilter, func(), func(event.Event)) error {
		t.Fatal("ErrorSessions must not scan spool")
		return nil
	}
	e, err := newEngine(Options{SpoolDir: dir, Policy: privacy.ModeFull}, engineSeams{scanDay: scan})
	if err != nil {
		t.Fatal(err)
	}
	key := e.ErrorSignatures("")[0].Key
	page, err := e.ErrorSessions(key, 0, 50)
	if err != nil || page.Total != 1 || page.Sessions[0].Count != 1 || page.Sessions[0].SampleEventID != ev.ID {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	for _, tc := range []struct {
		key           string
		offset, limit int
	}{{"", 0, 50}, {key, -1, 50}, {key, 0, 0}, {key, 0, 101}} {
		if _, err := e.ErrorSessions(tc.key, tc.offset, tc.limit); !errors.Is(err, ErrInvalidErrorSessionsQuery) {
			t.Fatalf("query=%+v err=%v", tc, err)
		}
	}
	if _, err := e.ErrorSessions("unknown", 0, 50); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown err=%v", err)
	}
}

func TestErrorSessionsAdmissionAssignsEvidenceID(t *testing.T) {
	dir := t.TempDir()
	e, err := New(Options{SpoolDir: dir, Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	observation := historyEvent("", "session-one", "", 1, 1)
	observation.Category = event.CategoryError
	observation.Summary = "failure"
	stored, err := e.Admit(context.Background(), observation)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID == "" {
		t.Fatal("admitted error has no ID")
	}
	// Replaying the durable envelope deduplicates even though the source supplied no ID.
	if _, err := e.Admit(context.Background(), stored); err != nil {
		t.Fatal(err)
	}
	page, err := e.ErrorSessions(e.ErrorSignatures("")[0].Key, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Sessions) != 1 || page.Sessions[0].Count != 1 || page.Sessions[0].SampleEventID != stored.ID {
		t.Fatalf("page=%+v", page)
	}
	evidence, err := e.Event(context.Background(), page.Sessions[0].SampleEventID)
	if err != nil || evidence.ID != stored.ID {
		t.Fatalf("evidence=%+v err=%v", evidence, err)
	}
	rebuilt, err := New(Options{SpoolDir: dir, Policy: privacy.ModeFull})
	if err != nil {
		t.Fatal(err)
	}
	page, err = rebuilt.ErrorSessions(rebuilt.ErrorSignatures("")[0].Key, 0, 50)
	if err != nil || len(page.Sessions) != 1 || page.Sessions[0].Count != 1 || page.Sessions[0].SampleEventID != stored.ID {
		t.Fatalf("rebuilt=%+v err=%v", page, err)
	}
}
