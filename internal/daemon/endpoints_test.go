package daemon

import (
	"bufio"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

func seedSessions(t *testing.T, dir string) {
	t.Helper()
	w := spool.NewWriter(dir)
	base := time.Date(2026, 7, 2, 10, 0, 0, 0, time.UTC)
	evs := []event.Event{
		{ID: "a1", Time: base, Source: "claude-code", Agent: "claude", SessionID: "s1",
			Category: event.CategorySession, Summary: "session started", Repo: "myrepo"},
		{ID: "a2", Time: base.Add(time.Minute), Source: "claude-code", SessionID: "s1",
			Category: event.CategoryTool, Summary: "ran a tool"},
		{ID: "b1", Time: base.Add(2 * time.Minute), Source: "codex", SessionID: "s2",
			Category: event.CategoryPrompt, Summary: "hello"},
		{ID: "c1", Time: base.Add(3 * time.Minute), Source: "procwatch",
			Category: event.CategoryMeta, Summary: "no session id"},
	}
	for _, ev := range evs {
		if err := w.Append(ev); err != nil {
			t.Fatalf("seed append: %v", err)
		}
	}
}

func TestSessionsAggregatesSpool(t *testing.T) {
	cfg := testConfig(t)
	seedSessions(t, cfg.SpoolDir)
	ts := testServer(t, cfg)

	resp, err := http.Get(ts.URL + "/sessions")
	if err != nil {
		t.Fatalf("GET /sessions: %v", err)
	}
	defer resp.Body.Close()
	var sessions []Session
	if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2 (events without session_id excluded): %+v", len(sessions), sessions)
	}
	// Most recently active first.
	if sessions[0].ID != "s2" || sessions[1].ID != "s1" {
		t.Errorf("session order wrong: %+v", sessions)
	}
	s1 := sessions[1]
	if s1.Events != 2 || s1.Source != "claude-code" || s1.Repo != "myrepo" || s1.Agent != "claude" {
		t.Errorf("s1 summary wrong: %+v", s1)
	}
	if !s1.LastTime.After(s1.FirstTime) {
		t.Errorf("s1 time range wrong: %+v", s1)
	}
}

func TestSessionByID(t *testing.T) {
	cfg := testConfig(t)
	seedSessions(t, cfg.SpoolDir)
	ts := testServer(t, cfg)

	resp, err := http.Get(ts.URL + "/sessions/s1")
	if err != nil {
		t.Fatalf("GET /sessions/s1: %v", err)
	}
	defer resp.Body.Close()
	var evs []event.Event
	if err := json.NewDecoder(resp.Body).Decode(&evs); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(evs) != 2 || evs[0].ID != "a1" || evs[1].ID != "a2" {
		t.Fatalf("session events wrong: %+v", evs)
	}

	notFound, err := http.Get(ts.URL + "/sessions/does-not-exist")
	if err != nil {
		t.Fatalf("GET missing session: %v", err)
	}
	notFound.Body.Close()
	if notFound.StatusCode != http.StatusNotFound {
		t.Errorf("missing session status = %d, want 404", notFound.StatusCode)
	}
}

func TestDoctorEndpoint(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := http.Get(ts.URL + "/doctor")
	if err != nil {
		t.Fatalf("GET /doctor: %v", err)
	}
	defer resp.Body.Close()
	var checks []struct {
		Name   string `json:"name"`
		OK     bool   `json:"ok"`
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&checks); err != nil {
		t.Fatalf("decode: %v", err)
	}
	found := false
	for _, c := range checks {
		if c.Name == "spool writable" {
			found = true
			if !c.OK {
				t.Errorf("spool writable should pass: %+v", c)
			}
		}
	}
	if !found {
		t.Errorf("no 'spool writable' check in %+v", checks)
	}
}

func TestExportEndpoint(t *testing.T) {
	cfg := testConfig(t)
	seedSessions(t, cfg.SpoolDir)
	ts := testServer(t, cfg)

	resp, err := http.Post(ts.URL+"/export", "application/json", nil)
	if err != nil {
		t.Fatalf("POST /export: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if v := resp.Header.Get("X-Firehose-Export-Version"); v != "1" {
		t.Errorf("export version header = %q, want 1", v)
	}
	var n int
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		var ev event.Event
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			t.Fatalf("export line %d not an event: %v", n, err)
		}
		if ev.SchemaVersion != event.CurrentSchemaVersion {
			t.Errorf("export line %d schema_version = %d", n, ev.SchemaVersion)
		}
		n++
	}
	if n != 4 {
		t.Errorf("exported %d lines, want 4", n)
	}
}
