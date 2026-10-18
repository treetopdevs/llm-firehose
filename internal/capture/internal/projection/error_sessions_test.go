package projection

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
)

func TestErrorSessionsExactPagedRebuild(t *testing.T) {
	base := fixtureEvent(t, "c5089b7d2673ba045c26b47175717f12")
	start := base.Time
	var evs []event.Event
	for i := 0; i < 505; i++ {
		ev := base
		ev.ID = fmt.Sprintf("event-%04d", i)
		ev.SessionID = "a"
		ev.Time = start.Add(time.Duration(i) * time.Second)
		evs = append(evs, ev)
	}
	for _, session := range []string{"b", "c", ""} {
		ev := base
		ev.ID = "session-" + session
		ev.SessionID = session
		ev.Time = start.Add(504 * time.Second)
		evs = append(evs, ev)
	}
	// Same-time earliest observation chooses the smallest exact ID.
	first := base
	first.ID = "earliest"
	first.SessionID = "a"
	first.Time = start
	evs = append(evs, first)
	ix := New()
	for i := len(evs) - 1; i >= 0; i-- {
		ix.Apply(evs[i])
		ix.Apply(evs[i])
	}
	got, ok := ix.ErrorSessions(keyMixTest, 0, 2)
	if !ok || got.Total != 3 || got.Key != keyMixTest || got.Offset != 0 || got.Limit != 2 || len(got.Sessions) != 2 {
		t.Fatalf("page=%+v found=%v", got, ok)
	}
	a := got.Sessions[0]
	if a.SessionID != "a" || a.Source != "codex" || a.Count != 506 || !a.FirstTime.Equal(start) || !a.LastTime.Equal(start.Add(504*time.Second)) || a.SampleEventID != "earliest" {
		t.Fatalf("aggregate=%+v", a)
	}
	if got.Sessions[1].SessionID != "b" {
		t.Fatalf("tie order=%+v", got)
	}
	got.Sessions[0].Count = -1
	again, _ := ix.ErrorSessions(keyMixTest, 0, 2)
	if again.Sessions[0].Count != 506 {
		t.Fatal("query aliases internal state")
	}
	tail, _ := ix.ErrorSessions(keyMixTest, 2, 2)
	if len(tail.Sessions) != 1 || tail.Sessions[0].SessionID != "c" {
		t.Fatalf("tail=%+v", tail)
	}
	empty, _ := ix.ErrorSessions(keyMixTest, 100, 2)
	if empty.Sessions == nil || len(empty.Sessions) != 0 {
		t.Fatalf("empty=%+v", empty)
	}
	if _, ok := ix.ErrorSessions("unknown", 0, 50); ok {
		t.Fatal("unknown key found")
	}
	legacy := ix.ErrorSignatures("a")[0]
	if len(legacy.Members) != 500 || legacy.Count != 509 || legacy.Sessions != 3 {
		t.Fatalf("legacy changed: %+v", legacy)
	}
	dir := t.TempDir()
	f, err := os.Create(filepath.Join(dir, start.UTC().Format("2006-01-02")+".ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	enc := json.NewEncoder(f)
	for _, ev := range evs {
		if err := enc.Encode(ev); err != nil {
			t.Fatal(err)
		}
		if err := enc.Encode(ev); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := Build(dir)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := ix.ErrorSessions(keyMixTest, 0, 100)
	actual, _ := rebuilt.ErrorSessions(keyMixTest, 0, 100)
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("rebuild=%+v want=%+v", actual, want)
	}
}

func TestErrorSessionsFixtureAndPrivacy(t *testing.T) {
	for _, mode := range []privacy.Mode{privacy.ModeMinimal, privacy.ModeBalanced, privacy.ModeFull} {
		t.Run(string(mode), func(t *testing.T) {
			ix := New()
			for _, ev := range loadErrsigFixture(t) {
				ix.Apply(privacy.Redact(ev, mode))
			}
			for _, sig := range ix.ErrorSignatures("") {
				page, ok := ix.ErrorSessions(sig.Key, 0, 100)
				if !ok || page.Total != sig.Sessions {
					t.Fatalf("page=%+v sig=%+v", page, sig)
				}
				for _, row := range page.Sessions {
					if row.Source != sig.Source || row.Count < 1 || row.SampleEventID == "" {
						t.Fatalf("row=%+v", row)
					}
				}
			}
		})
	}
}

func TestErrorSessionsWithoutSessionIsKnownEmpty(t *testing.T) {
	ix := New()
	ev := fixtureEvent(t, "c5089b7d2673ba045c26b47175717f12")
	ev.SessionID = ""
	ix.Apply(ev)
	page, ok := ix.ErrorSessions(keyMixTest, 0, 50)
	if !ok || page.Total != 0 || page.Sessions == nil || len(page.Sessions) != 0 {
		t.Fatalf("page=%+v known=%v", page, ok)
	}
}
