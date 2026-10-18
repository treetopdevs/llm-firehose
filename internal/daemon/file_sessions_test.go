package daemon

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"agentfirehose/internal/event"
	"agentfirehose/internal/testsupport/capturehistory"
)

func TestFileSessionArtifactsRoute(t *testing.T) {
	cfg := testConfig(t)
	// Real normalized Codex patch fixture; only workspace/session fields mutated.
	f, err := os.Open("../capture/testdata/activity_real_shapes.ndjson")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	var real event.Event
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), `"name":"patch_apply_end"`) {
			if err := json.Unmarshal(scanner.Bytes(), &real); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if real.ID == "" {
		t.Fatal("real patch fixture missing")
	}
	real.WorktreeID = "/work/proj"
	w := capturehistory.NewAdmitter(cfg.SpoolDir)
	if _, err := w.Append(real); err != nil {
		t.Fatal(err)
	}
	earlier := real
	earlier.ID = "earlier"
	earlier.SessionID = "other"
	earlier.Time = real.Time.Add(-time.Hour)
	if _, err := w.Append(earlier); err != nil {
		t.Fatal(err)
	}
	ts := testServer(t, cfg)
	resp, err := http.Get(ts.URL + "/artifacts/file-sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var rows []map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0]["session_id"] != real.SessionID || rows[0]["last_event_id"] != real.ID || rows[0]["workspace_kind"] != "worktree_id" {
		t.Fatalf("wrong scoped rows: %+v", rows)
	}
	if rows[1]["last_event_id"] != "earlier" {
		t.Fatalf("unstable ordering: %+v", rows)
	}
	legacy, err := http.Get(ts.URL + "/artifacts/files")
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Body.Close()
	var oldRows []map[string]any
	if err := json.NewDecoder(legacy.Body).Decode(&oldRows); err != nil {
		t.Fatal(err)
	}
	if len(oldRows) != 1 || len(oldRows[0]) != 5 || oldRows[0]["events"] != float64(2) || oldRows[0]["path"] != rows[0]["path"] {
		t.Fatalf("legacy contract changed: %+v", oldRows)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/artifacts/file-sessions", nil)
	req.Header.Set("Origin", "https://evil.example")
	denied, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer denied.Body.Close()
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("origin status %d", denied.StatusCode)
	}
}

func TestFileSessionArtifactsEmpty(t *testing.T) {
	ts := testServer(t, testConfig(t))
	resp, err := http.Get(ts.URL + "/artifacts/file-sessions")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var rows []any
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		t.Fatal(err)
	}
	if rows == nil || len(rows) != 0 {
		t.Fatalf("want empty array: %#v", rows)
	}
}
