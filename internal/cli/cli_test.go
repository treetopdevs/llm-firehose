package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agentfirehose/internal/config"
	"agentfirehose/internal/event"
	"agentfirehose/internal/privacy"
	"agentfirehose/internal/testsupport/capturehistory"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
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
	evs, err := capturehistory.Recent(cfg.SpoolDir, 10)
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
			evs, err := capturehistory.Recent(cfg.SpoolDir, 1)
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
	evs, _ := capturehistory.Recent(cfg.SpoolDir, 10)
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
			evs, err := capturehistory.Recent(cfg.SpoolDir, 1)
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
	evs, _ := capturehistory.Recent(cfg.SpoolDir, 10)
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
	evs, _ := capturehistory.Recent(cfg.SpoolDir, 10)
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
	evs, _ := capturehistory.Recent(cfg.SpoolDir, 10)
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
	evs, err := capturehistory.Recent(cfg.SpoolDir, 10)
	if err != nil || len(evs) != 1 || evs[0].Source != "codex" {
		t.Fatalf("fallback spool = %+v, %v", evs, err)
	}

	out.Reset()
	if err := HookForward(cfg, "claude-code", "", strings.NewReader(`not json`), &out); err != nil || out.String() != "{}\n" {
		t.Fatalf("malformed hook must fail silently: err=%v out=%q", err, out.String())
	}
	evs, err = capturehistory.Recent(cfg.SpoolDir, 10)
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
	evs, err := capturehistory.Recent(filepath.Join(home, ".agentfirehose", "spool"), 10)
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
	evs, err := capturehistory.Recent(filepath.Join(home, ".agentfirehose", "spool"), 10)
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
	evs, err := capturehistory.Recent(cfg.SpoolDir, 10)
	if err != nil || len(evs) != 1 {
		t.Fatalf("spool = %+v err=%v", evs, err)
	}
	ev := evs[0]
	if ev.Name != "hook_capture_error" || ev.Severity != event.SeverityWarn {
		t.Fatalf("warning fields lost after redact: %+v", ev)
	}
	if strings.Contains(ev.Summary, "boom") {
		t.Fatalf("summary leaked capture error: %+v", ev)
	}
	// Payload values are digested in minimal mode; adapter_source must not
	// remain a bare string.
	if _, isMap := ev.Payload["adapter_source"].(map[string]any); !isMap {
		t.Fatalf("payload must be redacted before append: %+v", ev.Payload)
	}
	if _, ok := ev.Payload["status"].(map[string]any); !ok {
		t.Fatalf("status must be digested in minimal mode: %+v", ev.Payload)
	}
	if _, ok := ev.Payload["error"].(map[string]any); !ok {
		t.Fatalf("error must be digested in minimal mode: %+v", ev.Payload)
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
	evs, err := capturehistory.Recent(cfg.SpoolDir, 10)
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
	evs, err := capturehistory.Recent(spoolDir, 10)
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
	evs, err = capturehistory.Recent(spoolDir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 2 || evs[1].Name != "hook_capture_error" || evs[1].Severity != event.SeverityWarn {
		t.Fatalf("missing --event warning = %+v", evs)
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
	evs, _ := capturehistory.Recent(cfg.SpoolDir, 10)
	if len(evs) != 1 {
		t.Fatalf("local spool events = %d, want 1", len(evs))
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
