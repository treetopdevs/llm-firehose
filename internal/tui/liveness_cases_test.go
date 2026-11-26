package tui

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type livenessCase struct {
	Name            string `json:"name"`
	State           string `json:"state"`
	Last            string `json:"last"`
	Since           string `json:"since"`
	Go              bool   `json:"go"`
	TS              bool   `json:"ts"`
	KnownDivergence string `json:"known_divergence"`
}

type livenessTable struct {
	Now   string         `json:"now"`
	Cases []livenessCase `json:"cases"`
}

func loadLivenessTable(t *testing.T) livenessTable {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "liveness_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var tbl livenessTable
	if err := json.Unmarshal(raw, &tbl); err != nil {
		t.Fatal(err)
	}
	return tbl
}

func livenessTime(t *testing.T, s string) time.Time {
	t.Helper()
	if s == "" {
		return time.Time{}
	}
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestLivenessCases(t *testing.T) {
	tbl := loadLivenessTable(t)
	now := livenessTime(t, tbl.Now)
	for _, c := range tbl.Cases {
		got := attentionFresh(c.State, livenessTime(t, c.Last), livenessTime(t, c.Since), now)
		if got != c.Go {
			t.Errorf("%s: attentionFresh = %v, want %v", c.Name, got, c.Go)
		}
	}
}

func TestLivenessCasesAgreeUnlessDeclared(t *testing.T) {
	for _, c := range loadLivenessTable(t).Cases {
		if c.Go != c.TS && c.KnownDivergence == "" {
			t.Errorf("%s: clients disagree; fix one client or declare the divergence", c.Name)
		}
	}
}

func TestLivenessCasesDesktopCopyIsIdentical(t *testing.T) {
	a, err := os.ReadFile(filepath.Join("testdata", "liveness_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join("..", "..", "apps", "tauri-desktop", "src", "liveness.cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("apps/tauri-desktop/src/liveness.cases.json differs from internal/tui/testdata/liveness_cases.json; cp the Go copy over it")
	}
}
