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
	if !strings.Contains(s, "hook-forward --source claude-code") {
		t.Error("fail-silent Claude forwarder not wired")
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
	if c := strings.Count(string(data2), "hook-forward --source claude-code"); c != strings.Count(s, "hook-forward --source claude-code") {
		t.Errorf("install not idempotent: %d vs %d occurrences", c, strings.Count(s, "hook-forward --source claude-code"))
	}
}

func TestCommandPathQuotingIsPlatformAppropriate(t *testing.T) {
	const windowsPath = `C:\Program Files\Agent Firehose\firehosed.exe`
	if got, want := quoteCommandPath(windowsPath, "windows"), `"`+windowsPath+`"`; got != want {
		t.Fatalf("Windows command path = %q, want %q", got, want)
	}
	const posixPath = `/Applications/Agent Firehose/firehosed`
	if got, want := quoteCommandPath(posixPath, "darwin"), `'`+posixPath+`'`; got != want {
		t.Fatalf("POSIX command path = %q, want %q", got, want)
	}
}

func TestInstallOpenCodeWritesPlugin(t *testing.T) {
	home := t.TempDir()
	path, err := InstallOpenCode(home, "/Applications/Agent Firehose/firehosed")
	if err != nil {
		t.Fatalf("InstallOpenCode: %v", err)
	}
	if !strings.HasPrefix(path, filepath.Join(home, ".config", "opencode", "plugin")) {
		t.Errorf("plugin in wrong place: %s", path)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("plugin not written: %v", err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), `"/Applications/Agent Firehose/firehosed","hook-forward","--source","opencode"`) {
		t.Fatalf("desktop sidecar forwarder not wired safely:\n%s", data)
	}
}

func TestInstallCodexHooksMergesBacksUpAndIsIdempotent(t *testing.T) {
	for _, bin := range []string{"/Applications/Agent Firehose/firehose", "/Applications/Agent Firehose/firehosed"} {
		t.Run(filepath.Base(bin), func(t *testing.T) {
			home := t.TempDir()
			hooksPath := filepath.Join(home, ".codex", "hooks.json")
			if err := os.MkdirAll(filepath.Dir(hooksPath), 0o755); err != nil {
				t.Fatal(err)
			}
			original := `{"description":"keep me","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"existing hook"}]}]}}`
			if err := os.WriteFile(hooksPath, []byte(original), 0o644); err != nil {
				t.Fatal(err)
			}

			if err := InstallCodex(home, bin); err != nil {
				t.Fatalf("InstallCodex: %v", err)
			}
			first, _ := os.ReadFile(hooksPath)
			backup, _ := os.ReadFile(hooksPath + ".bak")
			if string(backup) != original {
				t.Fatalf("backup = %q, want original", backup)
			}
			if !strings.Contains(string(first), "existing hook") || !strings.Contains(string(first), "keep me") {
				t.Fatalf("unrelated configuration was not preserved: %s", first)
			}
			for _, name := range CodexHookEvents {
				if !strings.Contains(string(first), `"`+name+`"`) {
					t.Errorf("missing %s", name)
				}
			}
			if !strings.Contains(string(first), `'`+bin+`' hook-forward`) {
				t.Fatalf("path with spaces was not quoted: %s", first)
			}

			if err := InstallCodex(home, bin); err != nil {
				t.Fatalf("second InstallCodex: %v", err)
			}
			second, _ := os.ReadFile(hooksPath)
			if string(first) != string(second) {
				t.Fatal("Codex hook installation is not idempotent")
			}
			backupAfter, _ := os.ReadFile(hooksPath + ".bak")
			if string(backupAfter) != original {
				t.Fatalf("idempotent install replaced original backup: %q", backupAfter)
			}
		})
	}
}

func TestInstallCodexShellQuotesSpecialExecutablePath(t *testing.T) {
	home := t.TempDir()
	bin := `/Applications/$Agent's Firehose/firehose`
	if err := InstallCodex(home, bin); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(home, ".codex", "hooks.json"))
	if !strings.Contains(string(data), `'/Applications/$Agent'\"'\"'s Firehose/firehose' hook-forward`) {
		t.Fatalf("unsafe command quoting: %s", data)
	}
}

func TestInstallCodexCreatesConfigurationAndBackup(t *testing.T) {
	home := t.TempDir()
	if err := InstallCodex(home, "firehose"); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", ".bak"} {
		if _, err := os.Stat(filepath.Join(home, ".codex", "hooks.json") + suffix); err != nil {
			t.Errorf("missing hooks.json%s: %v", suffix, err)
		}
	}
}

func TestHookForwardAlwaysReturnsEmptyDecisionAndFallsBackToSpool(t *testing.T) {
	cfg := testConfig(t)
	cfg.DaemonAddr = "127.0.0.1:1"
	var out bytes.Buffer
	if err := HookForward(cfg, "codex-hook", strings.NewReader(`{"session_id":"s1","turn_id":"t1","hook_event_name":"UserPromptSubmit","prompt":"hello"}`), &out); err != nil {
		t.Fatalf("HookForward: %v", err)
	}
	if out.String() != "{}\n" {
		t.Fatalf("stdout = %q", out.String())
	}
	evs, err := spool.ReadLastN(cfg.SpoolDir, 10)
	if err != nil || len(evs) != 1 || evs[0].Source != "codex" {
		t.Fatalf("fallback spool = %+v, %v", evs, err)
	}

	out.Reset()
	if err := HookForward(cfg, "claude-code", strings.NewReader(`not json`), &out); err != nil || out.String() != "{}\n" {
		t.Fatalf("malformed hook must fail silently: err=%v out=%q", err, out.String())
	}
	evs, err = spool.ReadLastN(cfg.SpoolDir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 || evs[1].Name != "hook_capture_error" || evs[1].Severity != event.SeverityWarn {
		t.Fatalf("capture failure warning = %+v", evs)
	}
}

func TestRunHookForwardCommandSurfacesConfigFailureAndForwards(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, ".agentfirehose")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "config.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	payload := `{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"/repo","prompt":"hello"}`
	RunHookForwardCommand(home, []string{"--source", "claude-code"}, strings.NewReader(payload), &out)
	if out.String() != "{}\n" {
		t.Fatalf("hook command stdout = %q", out.String())
	}
	evs, err := spool.ReadLastN(filepath.Join(home, ".agentfirehose", "spool"), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 || evs[0].Name != "hook_capture_error" || evs[1].Category != event.CategoryPrompt {
		t.Fatalf("config warning and captured hook = %+v", evs)
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
	if c, ok := byName["codex hooks"]; !ok || c.OK {
		t.Errorf("codex hooks should fail in empty home: %+v", c)
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

func TestDoctorRequiresAllCodexHooksAndLiveExecutable(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, "Agent Firehose", "firehosed")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := InstallCodex(home, bin); err != nil {
		t.Fatal(err)
	}
	if !CodexHooksConfigured(home) {
		t.Fatal("complete Codex installation reported unhealthy")
	}

	data, _ := os.ReadFile(filepath.Join(home, ".codex", "hooks.json"))
	var doc map[string]any
	_ = json.Unmarshal(data, &doc)
	hooks := doc["hooks"].(map[string]any)
	delete(hooks, "PostCompact")
	partial, _ := json.Marshal(doc)
	_ = os.WriteFile(filepath.Join(home, ".codex", "hooks.json"), partial, 0o600)
	if CodexHooksConfigured(home) {
		t.Fatal("partial Codex installation reported healthy")
	}
}

func TestSaveConfigRoundTrip(t *testing.T) {
	home := t.TempDir()
	cfg, _ := LoadConfig(home)
	cfg.PrivacyMode = "minimal"
	if err := SaveConfig(home, cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	got, err := LoadConfig(home)
	if err != nil {
		t.Fatalf("LoadConfig after save: %v", err)
	}
	if got.PrivacyMode != "minimal" {
		t.Errorf("privacy = %q, want minimal", got.PrivacyMode)
	}
	if got.SpoolDir != cfg.SpoolDir {
		t.Errorf("spool dir changed across save: %q vs %q", got.SpoolDir, cfg.SpoolDir)
	}
}

func TestSaveConfigRejectsBadMode(t *testing.T) {
	home := t.TempDir()
	cfg, _ := LoadConfig(home)
	cfg.PrivacyMode = "everything"
	if err := SaveConfig(home, cfg); err == nil {
		t.Fatal("want error for invalid privacy mode")
	}
	if _, err := os.Stat(filepath.Join(home, ".agentfirehose", "config.json")); !os.IsNotExist(err) {
		t.Error("invalid config must not be written")
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
	if cfg.DaemonAddr != "127.0.0.1:4517" {
		t.Errorf("default daemon addr = %q, want 127.0.0.1:4517", cfg.DaemonAddr)
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
