package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"agentfirehose/internal/capturemeta"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
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
	if _, ok := ev.Payload["prompt"]; ok || strings.Contains(ev.Summary, strings.Repeat("x", 20)) {
		t.Errorf("balanced Claude capture must exclude prompt bodies: %+v", ev)
	}
}

func TestClaudeFixtureContentIsOnlyRetainedInFullMode(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "adapters", "claudecode", "testdata", "post_tool_use_bash.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []privacy.Mode{privacy.ModeBalanced, privacy.ModeMinimal, privacy.ModeFull} {
		t.Run(string(mode), func(t *testing.T) {
			cfg := testConfig(t)
			cfg.PrivacyMode = string(mode)
			if err := EmitLocal(cfg, "claude-code", raw); err != nil {
				t.Fatal(err)
			}
			evs, err := spool.ReadLastN(cfg.SpoolDir, 1)
			if err != nil || len(evs) != 1 {
				t.Fatalf("spool: events=%+v err=%v", evs, err)
			}
			data, err := json.Marshal(evs[0])
			if err != nil {
				t.Fatal(err)
			}
			hasMarker := strings.Contains(string(data), "SECRET-")
			if mode == privacy.ModeFull && !hasMarker {
				t.Errorf("full mode lost raw fixture content: %s", data)
			}
			if mode != privacy.ModeFull && hasMarker {
				t.Errorf("%s mode leaked fixture content: %s", mode, data)
			}
		})
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

func TestOpenCodeToolContentIsOnlyRetainedInFullMode(t *testing.T) {
	raw := []byte(`{"type":"message.part.updated","properties":{"part":{"id":"call-fixture","sessionID":"oc-1","type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"SECRET-OPENCODE-COMMAND"},"output":"SECRET-OPENCODE-RESULT"}}}}`)
	for _, mode := range []privacy.Mode{privacy.ModeBalanced, privacy.ModeMinimal, privacy.ModeFull} {
		t.Run(string(mode), func(t *testing.T) {
			cfg := testConfig(t)
			cfg.PrivacyMode = string(mode)
			if err := EmitLocal(cfg, "opencode", raw); err != nil {
				t.Fatal(err)
			}
			evs, err := spool.ReadLastN(cfg.SpoolDir, 1)
			if err != nil || len(evs) != 1 {
				t.Fatalf("spool: events=%+v err=%v", evs, err)
			}
			data, err := json.Marshal(evs[0])
			if err != nil {
				t.Fatal(err)
			}
			hasMarker := strings.Contains(string(data), "SECRET-OPENCODE")
			if mode == privacy.ModeFull && !hasMarker {
				t.Errorf("full mode lost raw OpenCode content: %s", data)
			}
			if mode != privacy.ModeFull && hasMarker {
				t.Errorf("%s mode leaked OpenCode content: %s", mode, data)
			}
		})
	}
}

func TestEmitSkippedEventWritesNothing(t *testing.T) {
	cfg := testConfig(t)
	in := strings.NewReader(`{"type":"message.part.updated","properties":{"part":{"type":"text","text":"streaming"}}}`)
	if err := Emit(cfg, "opencode", in); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 0 {
		t.Fatalf("skipped event must not be spooled: %+v", evs)
	}
}

func TestEmitUnknownEventWritesSafeWarning(t *testing.T) {
	cfg := testConfig(t)
	in := strings.NewReader(`{"type":"lsp.client.diagnostics","properties":{"secret":"SECRET-RAW"}}`)
	if err := Emit(cfg, "opencode", in); err != nil {
		t.Fatalf("Emit: %v", err)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 || evs[0].Name != "adapter.unknown_event" {
		t.Fatalf("unknown event warning missing: %+v", evs)
	}
	data, err := json.Marshal(evs[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "SECRET-RAW") {
		t.Fatalf("unknown warning leaked raw input: %s", data)
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
	expected := []string{
		"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
		"PostToolUseFailure", "StopFailure", "PreCompact",
		"Notification", "SubagentStop", "Stop", "SessionEnd",
	}
	for _, evName := range expected {
		if !strings.Contains(s, `"`+evName+`"`) {
			t.Errorf("hook for %s not installed", evName)
		}
	}
	for _, omitted := range []string{
		"Setup", "UserPromptExpansion", "PermissionRequest", "PermissionDenied",
		"PostToolBatch", "SubagentStart", "TaskCreated",
		"TaskCompleted", "TeammateIdle", "InstructionsLoaded",
		"ConfigChange", "CwdChanged", "WorktreeCreate", "WorktreeRemove",
		"PostCompact", "Elicitation", "ElicitationResult",
		"FileChanged", "MessageDisplay",
	} {
		if strings.Contains(s, `"`+omitted+`"`) {
			t.Errorf("unproven/unsafe hook %s must not be installed by default", omitted)
		}
	}
	if !strings.Contains(s, "hook-forward --source claude-code") {
		t.Error("fail-silent Claude forwarder not wired")
	}
	// backup created
	if _, err := os.Stat(settingsPath + ".bak"); err != nil {
		t.Error("no backup written")
	}
	backup, _ := os.ReadFile(settingsPath + ".bak")

	// idempotent: run again, no duplicate firehose hooks
	if err := InstallClaudeCode(home, "firehose"); err != nil {
		t.Fatalf("second install: %v", err)
	}
	data2, _ := os.ReadFile(settingsPath)
	if string(data2) != string(data) {
		t.Error("second install changed settings")
	}
	backup2, _ := os.ReadFile(settingsPath + ".bak")
	if string(backup2) != string(backup) {
		t.Error("second install overwrote recovery backup")
	}

	hooks := settings["hooks"].(map[string]any)
	if len(hooks) != len(expected) {
		t.Errorf("installed hook families = %d, want fixture-proven %d: %+v", len(hooks), len(expected), hooks)
	}
	for _, name := range expected {
		entries := hooks[name].([]any)
		last := entries[len(entries)-1].(map[string]any)
		handlers := last["hooks"].([]any)
		handler := handlers[0].(map[string]any)
		if handler["async"] != true {
			t.Errorf("%s Firehose hook is not asynchronous: %+v", name, handler)
		}
	}
	for _, name := range []string{
		"SessionStart", "UserPromptSubmit", "Notification", "SubagentStop",
		"Stop", "SessionEnd",
	} {
		entries := hooks[name].([]any)
		last := entries[len(entries)-1].(map[string]any)
		if _, ok := last["matcher"]; ok {
			t.Errorf("%s does not support a matcher: %+v", name, last)
		}
	}
	for _, name := range []string{"PreToolUse", "PostToolUse"} {
		entries := hooks[name].([]any)
		last := entries[len(entries)-1].(map[string]any)
		if last["matcher"] != ".*" {
			t.Errorf("%s matcher = %v, want valid all-tools regex", name, last["matcher"])
		}
	}
}

func TestInstallClaudeCodeDoesNotMutateSharedUserEntry(t *testing.T) {
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	command := quoteCommandPath("/tmp/firehose", runtime.GOOS) + " hook-forward --source claude-code"
	document := map[string]any{
		"hooks": map[string]any{
			"PreToolUse": []any{
				map[string]any{
					"matcher": "Bash",
					"hooks": []any{
						map[string]any{"type": "command", "command": "my-audit"},
						map[string]any{"type": "command", "command": command},
					},
				},
			},
		},
	}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settingsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := InstallClaudeCode(home, "/tmp/firehose"); err != nil {
		t.Fatal(err)
	}
	installed, _ := os.ReadFile(settingsPath)
	var got map[string]any
	if err := json.Unmarshal(installed, &got); err != nil {
		t.Fatal(err)
	}
	entries := got["hooks"].(map[string]any)["PreToolUse"].([]any)
	if len(entries) != 2 {
		t.Fatalf("PreToolUse entries = %+v, want shared user entry plus Firehose-owned entry", entries)
	}
	shared := entries[0].(map[string]any)
	if shared["matcher"] != "Bash" {
		t.Fatalf("shared user matcher mutated: %+v", shared)
	}
	owned := entries[1].(map[string]any)
	if owned["matcher"] != ".*" {
		t.Fatalf("Firehose-owned matcher = %v, want .*", owned["matcher"])
	}
}

func TestInstallClaudeCodeRefusesNonObjectHooks(t *testing.T) {
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"hooks":["user-owned-shape"]}`)
	if err := os.WriteFile(settingsPath, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallClaudeCode(home, "firehose"); err == nil {
		t.Fatal("non-object hooks were silently replaced")
	}
	after, _ := os.ReadFile(settingsPath)
	if string(after) != string(original) {
		t.Fatalf("settings changed after refusal: %s", after)
	}
}

func TestClaudeHooksConfiguredRejectsPartialCoverage(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, "firehose")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := InstallClaudeCode(home, bin); err != nil {
		t.Fatal(err)
	}
	if !ClaudeHooksConfigured(home) {
		t.Fatal("complete installation reported unhealthy")
	}
	path := filepath.Join(home, ".claude", "settings.json")
	data, _ := os.ReadFile(path)
	var settings map[string]any
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatal(err)
	}
	hooks := settings["hooks"].(map[string]any)
	delete(hooks, "PostToolUse")
	changed, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, changed, 0o600); err != nil {
		t.Fatal(err)
	}
	if ClaudeHooksConfigured(home) {
		t.Fatal("partial/outdated installation reported healthy")
	}
}

func TestInstallClaudeOTelIsOptInPreservingAndIdempotent(t *testing.T) {
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"model":"opus","env":{"KEEP_ME":"yes"}}`)
	if err := os.WriteFile(settingsPath, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := InstallClaudeOTel(home, "127.0.0.1:4517", nil); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(settingsPath)
	var settings map[string]any
	if err := json.Unmarshal(first, &settings); err != nil {
		t.Fatal(err)
	}
	env := settings["env"].(map[string]any)
	if env["KEEP_ME"] != "yes" || settings["model"] != "opus" {
		t.Fatalf("unrelated Claude settings changed: %+v", settings)
	}
	for key, want := range ClaudeOTelEnvironment("127.0.0.1:4517") {
		if env[key] != want {
			t.Errorf("%s = %v, want %q", key, env[key], want)
		}
	}
	if env["OTEL_LOG_USER_PROMPTS"] != nil || env["OTEL_LOG_TOOL_DETAILS"] != nil {
		t.Fatalf("content-bearing telemetry option enabled: %+v", env)
	}
	backup, err := os.ReadFile(settingsPath + ".bak")
	if err != nil || string(backup) != string(original) {
		t.Fatalf("recovery backup = %q err=%v", backup, err)
	}
	if !ClaudeOTelConfigured(home, "127.0.0.1:4517") {
		t.Fatal("installed Claude OTel settings reported unavailable")
	}
	if err := InstallClaudeOTel(home, "127.0.0.1:4517", nil); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(settingsPath)
	if string(second) != string(first) {
		t.Fatal("idempotent Claude OTel install rewrote settings")
	}
}

func TestInstallClaudeOTelRefusesConflictsAndManagedSettings(t *testing.T) {
	t.Run("user endpoint", func(t *testing.T) {
		home := t.TempDir()
		settingsPath := filepath.Join(home, ".claude", "settings.json")
		if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
			t.Fatal(err)
		}
		original := []byte(`{"env":{"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT":"http://127.0.0.1:9999/v1/logs"}}`)
		if err := os.WriteFile(settingsPath, original, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := InstallClaudeOTel(home, "127.0.0.1:4517", nil); err == nil {
			t.Fatal("existing user OTel destination was overwritten")
		}
		after, _ := os.ReadFile(settingsPath)
		if string(after) != string(original) {
			t.Fatalf("conflicting settings changed: %s", after)
		}
	})

	t.Run("managed endpoint", func(t *testing.T) {
		home := t.TempDir()
		managed := filepath.Join(home, ".claude", "managed-settings.json")
		if err := os.MkdirAll(filepath.Dir(managed), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(managed,
			[]byte(`{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://managed.example"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := InstallClaudeOTel(home, "127.0.0.1:4517", nil); err == nil {
			t.Fatal("managed OTel destination was ignored")
		}
	})

	t.Run("malformed managed settings", func(t *testing.T) {
		home := t.TempDir()
		managed := filepath.Join(home, ".claude", "managed-settings.json")
		if err := os.MkdirAll(filepath.Dir(managed), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(managed, []byte(`{"env":`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := InstallClaudeOTel(home, "127.0.0.1:4517", nil); err == nil {
			t.Fatal("malformed managed settings were ignored")
		}
	})

	t.Run("non-loopback", func(t *testing.T) {
		if err := InstallClaudeOTel(t.TempDir(), "0.0.0.0:4517", nil); err == nil {
			t.Fatal("non-loopback OTel endpoint accepted")
		}
	})

	t.Run("process environment telemetry", func(t *testing.T) {
		for _, entry := range []string{
			"CLAUDE_CODE_ENABLE_TELEMETRY=1",
			"OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example",
		} {
			home := t.TempDir()
			environ := []string{"PATH=/usr/bin", "HOME=" + home, entry}
			if err := InstallClaudeOTel(home, "127.0.0.1:4517", environ); err == nil {
				t.Fatalf("process environment telemetry %q was overridden", entry)
			}
			if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); !os.IsNotExist(err) {
				t.Fatalf("refused install still touched settings: %v", err)
			}
		}
	})
}

func TestDoctorReportsClaudeOTelAsSupplementalTransport(t *testing.T) {
	home := t.TempDir()
	cfg := testConfig(t)
	cfg.DaemonAddr = "127.0.0.1:4517"
	if err := InstallClaudeOTel(home, cfg.DaemonAddr, nil); err != nil {
		t.Fatal(err)
	}
	var found *Check
	for _, check := range Doctor(cfg, home) {
		if check.Name == "claude-code otel" {
			copy := check
			found = &copy
			break
		}
	}
	if found == nil || !found.OK || found.Transport != "otel-http" ||
		found.Fidelity != string(capturemeta.SupportedPassiveStream) ||
		found.SupportedEvents == 0 {
		t.Fatalf("Claude OTel doctor check = %+v", found)
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
	if err := HookForward(cfg, "codex-hook", "", strings.NewReader(`{"session_id":"s1","turn_id":"t1","hook_event_name":"UserPromptSubmit","prompt":"hello"}`), &out); err != nil {
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
	if err := HookForward(cfg, "claude-code", "", strings.NewReader(`not json`), &out); err != nil || out.String() != "{}\n" {
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

func TestRunHookForwardCommandInvalidFlagsSkipsDefaultCodexSource(t *testing.T) {
	home := t.TempDir()
	var out bytes.Buffer
	// Claude-shaped payload would parse under the default --source=codex-hook;
	// an unknown flag must not invent that mapping.
	payload := `{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"/repo","prompt":"hello"}`
	RunHookForwardCommand(home, []string{"--bogus"}, strings.NewReader(payload), &out)
	if out.String() != "{}\n" {
		t.Fatalf("hook command stdout = %q", out.String())
	}
	evs, err := spool.ReadLastN(filepath.Join(home, ".agentfirehose", "spool"), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 || evs[0].Name != "hook_capture_error" {
		t.Fatalf("want only flag warning, got %+v", evs)
	}
	for _, ev := range evs {
		if ev.Source == "codex" || ev.Category == event.CategoryPrompt {
			t.Fatalf("must not forward payload with default codex-hook source: %+v", ev)
		}
	}
}

func TestReportHookCaptureErrorRedactsBeforeSpool(t *testing.T) {
	cfg := testConfig(t)
	cfg.PrivacyMode = string(privacy.ModeMinimal)
	reportHookCaptureError(cfg, "claude-code", fmt.Errorf("boom"))
	evs, err := spool.ReadLastN(cfg.SpoolDir, 10)
	if err != nil || len(evs) != 1 {
		t.Fatalf("spool = %+v err=%v", evs, err)
	}
	ev := evs[0]
	if ev.Name != "hook_capture_error" || ev.Severity != event.SeverityWarn {
		t.Fatalf("warning fields lost after redact: %+v", ev)
	}
	if !strings.Contains(ev.Summary, "boom") {
		t.Fatalf("summary must retain capture error: %+v", ev)
	}
	// Payload values are digested in minimal mode; adapter_source must not
	// remain a bare string.
	if _, isMap := ev.Payload["adapter_source"].(map[string]any); !isMap {
		t.Fatalf("payload must be redacted before append: %+v", ev.Payload)
	}
	if _, ok := ev.Payload["status"].(map[string]any); !ok {
		t.Fatalf("status must be digested in minimal mode: %+v", ev.Payload)
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
	for _, name := range []string{"claude-code hooks", "codex hooks", "antigravity hooks", "opencode plugin", "codex sessions"} {
		c := byName[name]
		if c.Transport == "" || c.Fidelity == "" || c.SupportedEvents == 0 {
			t.Errorf("%s missing additive capture metadata: %+v", name, c)
		}
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
	bin := filepath.Join(home, "firehose")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	InstallClaudeCode(home, bin)
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

	data, err := os.ReadFile(filepath.Join(home, ".codex", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	hooks := doc["hooks"].(map[string]any)
	delete(hooks, "PostCompact")
	partial, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "hooks.json"), partial, 0o600); err != nil {
		t.Fatal(err)
	}
	if CodexHooksConfigured(home) {
		t.Fatal("partial Codex installation reported healthy")
	}
}

func TestCommandAvailableAbsolutePathExecBit(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "firehose")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	// No Unix execute bits — Windows still treats an absolute regular file as available.
	if err := os.WriteFile(bin, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := commandAvailable(bin)
	if runtime.GOOS == "windows" {
		if !got {
			t.Fatal("windows absolute path must be accepted without unix exec bits")
		}
		home := t.TempDir()
		if err := InstallCodex(home, bin); err != nil {
			t.Fatalf("InstallCodex: %v", err)
		}
		if !CodexHooksConfigured(home) {
			t.Fatal("CodexHooksConfigured must accept absolute windows executable path")
		}
		return
	}
	if got {
		t.Fatal("non-windows absolute path without exec bits must be rejected")
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

func antigravityFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "adapters", "antigravity", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestInstallAntigravityHooks(t *testing.T) {
	bin := "/Applications/Agent Firehose/firehosed"
	existing := `{"note":"keep me","other-tool":{"enabled":true,"Stop":[{"type":"command","command":"other hook"}]}}`
	for _, tt := range []struct {
		name    string
		prior   string // "" = no pre-existing hooks.json
		wantErr bool
	}{
		{name: "fresh install creates config dir, file, and backup"},
		{name: "merge preserves every existing key", prior: existing},
		{name: "invalid JSON is refused", prior: "{not json", wantErr: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			hooksPath := filepath.Join(home, ".gemini", "config", "hooks.json")
			if tt.prior != "" {
				if err := os.MkdirAll(filepath.Dir(hooksPath), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(hooksPath, []byte(tt.prior), 0o644); err != nil {
					t.Fatal(err)
				}
			}

			err := InstallAntigravity(home, bin)
			if tt.wantErr {
				if err == nil {
					t.Fatal("InstallAntigravity accepted invalid JSON")
				}
				after, _ := os.ReadFile(hooksPath)
				if string(after) != tt.prior {
					t.Fatalf("refused install still modified hooks.json: %s", after)
				}
				if _, err := os.Stat(hooksPath + ".bak"); !os.IsNotExist(err) {
					t.Fatal("refused install wrote a backup")
				}
				return
			}
			if err != nil {
				t.Fatalf("InstallAntigravity: %v", err)
			}

			first, err := os.ReadFile(hooksPath)
			if err != nil {
				t.Fatalf("hooks.json missing: %v", err)
			}
			backup, err := os.ReadFile(hooksPath + ".bak")
			if err != nil {
				t.Fatalf("backup missing: %v", err)
			}
			if tt.prior != "" {
				if string(backup) != tt.prior {
					t.Fatalf("backup = %q, want original", backup)
				}
				if !strings.Contains(string(first), "keep me") || !strings.Contains(string(first), "other hook") {
					t.Fatalf("existing configuration was not preserved: %s", first)
				}
			}

			var doc map[string]any
			if err := json.Unmarshal(first, &doc); err != nil {
				t.Fatalf("hooks.json is not valid JSON: %v", err)
			}
			group, _ := doc["agent-firehose"].(map[string]any)
			if group == nil || group["enabled"] != true {
				t.Fatalf("agent-firehose group missing or disabled: %s", first)
			}
			// Only the post-only events are installed: PreToolUse output is a
			// permission decision and pre-events add in-band latency.
			for _, name := range []string{"PreToolUse", "PreInvocation"} {
				if _, ok := group[name]; ok {
					t.Errorf("pre-event %s must never be installed", name)
				}
			}
			// Tool events use matcher+hooks nesting.
			toolEntries, _ := group["PostToolUse"].([]any)
			if len(toolEntries) != 1 {
				t.Fatalf("PostToolUse entries = %v", group["PostToolUse"])
			}
			toolEntry, _ := toolEntries[0].(map[string]any)
			if toolEntry["matcher"] != "*" {
				t.Errorf("PostToolUse matcher = %v", toolEntry["matcher"])
			}
			toolHooks, _ := toolEntry["hooks"].([]any)
			if len(toolHooks) != 1 {
				t.Fatalf("PostToolUse hooks = %v", toolEntry["hooks"])
			}
			toolHook, _ := toolHooks[0].(map[string]any)
			if toolHook["command"] != "'"+bin+"' hook-forward --source antigravity --event PostToolUse" {
				t.Errorf("PostToolUse command = %v", toolHook["command"])
			}
			// PostInvocation and Stop entries are flat hook configs.
			for _, name := range []string{"PostInvocation", "Stop"} {
				entries, _ := group[name].([]any)
				if len(entries) != 1 {
					t.Fatalf("%s entries = %v", name, group[name])
				}
				entry, _ := entries[0].(map[string]any)
				if _, nested := entry["hooks"]; nested {
					t.Errorf("%s must be a flat hook entry, got %v", name, entry)
				}
				if entry["type"] != "command" || entry["timeout"] != float64(10) {
					t.Errorf("%s handler = %v", name, entry)
				}
				want := "'" + bin + "' hook-forward --source antigravity --event " + name
				if entry["command"] != want {
					t.Errorf("%s command = %v, want %q", name, entry["command"], want)
				}
			}

			// Idempotency: a second run changes nothing, including the backup.
			if err := InstallAntigravity(home, bin); err != nil {
				t.Fatalf("second InstallAntigravity: %v", err)
			}
			second, _ := os.ReadFile(hooksPath)
			if string(first) != string(second) {
				t.Fatal("Antigravity hook installation is not idempotent")
			}
			backupAfter, _ := os.ReadFile(hooksPath + ".bak")
			if string(backupAfter) != string(backup) {
				t.Fatalf("idempotent install replaced original backup: %q", backupAfter)
			}
		})
	}
}

func TestAntigravityHooksConfiguredRequiresAllThreeEventsAndLiveExecutable(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, "Agent Firehose", "firehosed")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if AntigravityHooksConfigured(home) {
		t.Fatal("empty home reported configured")
	}
	if err := InstallAntigravity(home, bin); err != nil {
		t.Fatal(err)
	}
	if !AntigravityHooksConfigured(home) {
		t.Fatal("complete Antigravity installation reported unhealthy")
	}

	hooksPath := filepath.Join(home, ".gemini", "config", "hooks.json")
	data, _ := os.ReadFile(hooksPath)
	var doc map[string]any
	_ = json.Unmarshal(data, &doc)
	group := doc["agent-firehose"].(map[string]any)
	delete(group, "Stop")
	partial, _ := json.Marshal(doc)
	_ = os.WriteFile(hooksPath, partial, 0o600)
	if AntigravityHooksConfigured(home) {
		t.Fatal("partial Antigravity installation reported healthy")
	}
}

func TestEmitLocalNamedAntigravityRedactsAndRequiresEventName(t *testing.T) {
	cfg := testConfig(t)
	raw := antigravityFixture(t, "post_tool_use_list_dir.json")
	if err := EmitLocalNamed(cfg, "antigravity", "", raw); err == nil {
		t.Fatal("antigravity emit without an event name must fail: payloads carry no event-name field")
	}
	if err := EmitLocalNamed(cfg, "antigravity", "PostToolUse", raw); err != nil {
		t.Fatalf("EmitLocalNamed: %v", err)
	}
	evs, err := spool.ReadLastN(cfg.SpoolDir, 10)
	if err != nil || len(evs) != 1 {
		t.Fatalf("spool = %+v, %v", evs, err)
	}
	ev := evs[0]
	if ev.Source != "antigravity" || ev.Name != "PostToolUse:list_dir" {
		t.Errorf("wrong mapping: %+v", ev)
	}
	if ev.Raw != "" {
		t.Error("balanced mode must drop raw payload")
	}
	safe, _ := json.Marshal(ev)
	if strings.Contains(string(safe), "SECRET-") {
		t.Errorf("balanced antigravity capture leaked sanitized secrets: %s", safe)
	}
}

func TestRunHookForwardCommandAntigravityCarriesEventName(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, ".agentfirehose")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// An unroutable daemon address keeps the test hermetic: emit falls back
	// to the local spool instead of a live daemon on this machine.
	if err := os.WriteFile(filepath.Join(configDir, "config.json"), []byte(`{"daemon_addr":"127.0.0.1:1"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	RunHookForwardCommand(home,
		[]string{"--source", "antigravity", "--event", "PostToolUse"},
		bytes.NewReader(antigravityFixture(t, "post_tool_use_run_command.json")), &out)
	if out.String() != "{}\n" {
		t.Fatalf("hook command stdout = %q", out.String())
	}
	spoolDir := filepath.Join(home, ".agentfirehose", "spool")
	evs, err := spool.ReadLastN(spoolDir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 1 || evs[0].Source != "antigravity" || evs[0].Name != "PostToolUse:run_command" {
		t.Fatalf("captured hook = %+v", evs)
	}

	// Missing --event stays fail-silent: neutral "{}" plus a bounded
	// hook_capture_error warning instead of a captured event.
	out.Reset()
	RunHookForwardCommand(home,
		[]string{"--source", "antigravity"},
		bytes.NewReader(antigravityFixture(t, "post_tool_use_run_command.json")), &out)
	if out.String() != "{}\n" {
		t.Fatalf("hook command stdout without --event = %q", out.String())
	}
	evs, err = spool.ReadLastN(spoolDir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 || evs[1].Name != "hook_capture_error" || evs[1].Severity != event.SeverityWarn {
		t.Fatalf("missing --event warning = %+v", evs)
	}
}

func TestDoctorReportsAntigravityHooks(t *testing.T) {
	home := t.TempDir()
	cfg := Config{SpoolDir: filepath.Join(home, ".agentfirehose", "spool"), PrivacyMode: "balanced"}
	find := func() Check {
		for _, c := range Doctor(cfg, home) {
			if c.Name == "antigravity hooks" {
				return c
			}
		}
		t.Fatal("no antigravity hooks check")
		return Check{}
	}
	c := find()
	if c.OK {
		t.Errorf("antigravity hooks should fail in empty home: %+v", c)
	}
	if !strings.Contains(c.Detail, "firehose install antigravity") {
		t.Errorf("detail should recommend the installer: %+v", c)
	}
	if c.Transport != "hook" || c.Fidelity != string(capturemeta.SupportedInBandHook) || c.SupportedEvents != 5 {
		t.Errorf("antigravity capture metadata = %+v", c)
	}

	bin := filepath.Join(home, "firehosed")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := InstallAntigravity(home, bin); err != nil {
		t.Fatal(err)
	}
	if c := find(); !c.OK {
		t.Errorf("antigravity hooks should pass after install: %+v", c)
	}
}

// Raw hook payloads must never leave the machine: a non-loopback daemon_addr
// (however it got into config.json) is ignored in favor of the local spool
// rather than being sent cleartext to a remote host.
func TestDaemonRouteRequiresLoopback(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:4517": true,
		"localhost:4517": true,
		"[::1]:4517":     true,
		"example.com:80": false,
		"10.0.0.5:4517":  false,
		"0.0.0.0:4517":   false,
		"no-port-at-all": false,
	} {
		if got := daemonRouteAllowed(addr); got != want {
			t.Errorf("daemonRouteAllowed(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestEmitWithNonLoopbackDaemonStillCapturesLocally(t *testing.T) {
	cfg := testConfig(t)
	cfg.DaemonAddr = "example.com:4517"
	if err := EmitNamed(cfg, "generic", "", strings.NewReader(`{"category":"meta","summary":"s"}`)); err != nil {
		t.Fatalf("EmitNamed: %v", err)
	}
	evs, _ := spool.ReadLastN(cfg.SpoolDir, 10)
	if len(evs) != 1 {
		t.Fatalf("local spool events = %d, want 1", len(evs))
	}
}
