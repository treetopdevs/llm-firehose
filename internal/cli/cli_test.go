package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agentfirehose/internal/event"
	"agentfirehose/internal/spool"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	return Config{
		SpoolDir:    filepath.Join(t.TempDir(), "spool"),
		PrivacyMode: "balanced",
	}
}

func TestEmitClaudeCodeWritesRedactedEvent(t *testing.T) {
	cfg := testConfig(t)
	in := strings.NewReader(`{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"/repo","prompt":"` + strings.Repeat("x", 500) + `"}`)
	if err := Emit(cfg, "claude-code", in); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	evs, err := spool.ReadLastN(cfg.SpoolDir, 10)
	if err != nil {
		t.Fatalf("read spool: %v", err)
	}
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	ev := evs[0]
	if ev.Source != "claude-code" || ev.Category != event.CategoryPrompt {
		t.Errorf("wrong mapping: %+v", ev)
	}
	if ev.Raw != "" {
		t.Error("balanced mode must drop raw payload")
	}
	if p, _ := ev.Payload["prompt"].(string); len([]rune(p)) > 241 {
		t.Errorf("balanced mode must truncate payload, len=%d", len([]rune(p)))
	}
}

func TestEmitOpenCodeSource(t *testing.T) {
	cfg := testConfig(t)
	in := strings.NewReader(`{"type":"file.edited","properties":{"file":"/repo/a.ts"},"directory":"/repo"}`)
	if err := Emit(cfg, "opencode", in); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 || evs[0].Category != event.CategoryFile {
		t.Fatalf("opencode emit wrong: %+v", evs)
	}
}

func TestEmitSkippedEventWritesNothing(t *testing.T) {
	cfg := testConfig(t)
	in := strings.NewReader(`{"type":"lsp.client.diagnostics","properties":{}}`)
	if err := Emit(cfg, "opencode", in); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 0 {
		t.Fatalf("skipped event must not be spooled: %+v", evs)
	}
}

func TestIngestStreamsLines(t *testing.T) {
	cfg := testConfig(t)
	in := strings.NewReader(
		`{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"ran make"}` + "\n" +
			`{"custom":"thing"}` + "\n")
	n, err := Ingest(cfg, in)
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if n != 2 {
		t.Errorf("ingested %d, want 2", n)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 2 {
		t.Fatalf("spool has %d events", len(evs))
	}
}

func TestExportWritesNDJSON(t *testing.T) {
	cfg := testConfig(t)
	Ingest(cfg, strings.NewReader(`{"time":"2026-07-02T10:00:00Z","source":"my-tool","category":"shell","summary":"ran make"}`+"\n"))
	var out bytes.Buffer
	n, err := Export(cfg, &out)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if n != 1 {
		t.Errorf("exported %d, want 1", n)
	}
	var ev event.Event
	if err := json.Unmarshal(out.Bytes(), &ev); err != nil {
		t.Fatalf("export line not JSON: %v", err)
	}
	if ev.Summary != "ran make" {
		t.Errorf("export mangled: %+v", ev)
	}
}

func TestInstallClaudeCodeMergesSettings(t *testing.T) {
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settingsPath), 0o755)
	os.WriteFile(settingsPath, []byte(`{"model":"opus","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"my-existing-hook"}]}]}}`), 0o644)

	if err := InstallClaudeCode(home, "firehose"); err != nil {
		t.Fatalf("InstallClaudeCode: %v", err)
	}

	data, _ := os.ReadFile(settingsPath)
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("settings corrupted: %v", err)
	}
	if settings["model"] != "opus" {
		t.Error("unrelated settings clobbered")
	}
	s := string(data)
	if !strings.Contains(s, "my-existing-hook") {
		t.Error("existing hook removed")
	}
	for _, evName := range []string{"UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionStart", "Notification"} {
		if !strings.Contains(s, evName) {
			t.Errorf("hook for %s not installed", evName)
		}
	}
	if !strings.Contains(s, "firehose emit --source claude-code") {
		t.Error("firehose emit command not wired")
	}
	// backup created
	if _, err := os.Stat(settingsPath + ".bak"); err != nil {
		t.Error("no backup written")
	}

	// idempotent: run again, no duplicate firehose hooks
	if err := InstallClaudeCode(home, "firehose"); err != nil {
		t.Fatalf("second install: %v", err)
	}
	data2, _ := os.ReadFile(settingsPath)
	if c := strings.Count(string(data2), "firehose emit --source claude-code"); c != strings.Count(s, "firehose emit --source claude-code") {
		t.Errorf("install not idempotent: %d vs %d occurrences", c, strings.Count(s, "firehose emit --source claude-code"))
	}
}

func TestInstallOpenCodeWritesPlugin(t *testing.T) {
	home := t.TempDir()
	path, err := InstallOpenCode(home)
	if err != nil {
		t.Fatalf("InstallOpenCode: %v", err)
	}
	if !strings.HasPrefix(path, filepath.Join(home, ".config", "opencode", "plugin")) {
		t.Errorf("plugin in wrong place: %s", path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("plugin not written: %v", err)
	}
}

func TestDoctorReportsChecks(t *testing.T) {
	home := t.TempDir()
	cfg := Config{SpoolDir: filepath.Join(home, ".agentfirehose", "spool"), PrivacyMode: "balanced"}
	checks := Doctor(cfg, home)
	if len(checks) == 0 {
		t.Fatal("doctor returned no checks")
	}
	byName := map[string]Check{}
	for _, c := range checks {
		byName[c.Name] = c
	}
	if c, ok := byName["claude-code hooks"]; !ok || c.OK {
		t.Errorf("claude-code hooks should fail in empty home: %+v", c)
	}
	if c, ok := byName["spool writable"]; !ok || !c.OK {
		t.Errorf("spool should be creatable: %+v", c)
	}
	// after install, hooks check passes
	InstallClaudeCode(home, "firehose")
	checks = Doctor(cfg, home)
	for _, c := range checks {
		if c.Name == "claude-code hooks" && !c.OK {
			t.Errorf("hooks check should pass after install: %+v", c)
		}
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	home := t.TempDir()
	cfg, err := LoadConfig(home)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.PrivacyMode != "balanced" {
		t.Errorf("default privacy = %q, want balanced", cfg.PrivacyMode)
	}
	if cfg.SpoolDir != filepath.Join(home, ".agentfirehose", "spool") {
		t.Errorf("default spool = %q", cfg.SpoolDir)
	}
	// explicit config file overrides
	os.MkdirAll(filepath.Join(home, ".agentfirehose"), 0o755)
	os.WriteFile(filepath.Join(home, ".agentfirehose", "config.json"), []byte(`{"privacy_mode":"minimal"}`), 0o644)
	cfg, err = LoadConfig(home)
	if err != nil {
		t.Fatalf("LoadConfig with file: %v", err)
	}
	if cfg.PrivacyMode != "minimal" {
		t.Errorf("privacy = %q, want minimal", cfg.PrivacyMode)
	}
}
