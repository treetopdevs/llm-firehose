package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"agentfirehose/internal/adapters/claudecode"
	"agentfirehose/internal/adapters/claudeotel"
	"agentfirehose/internal/adapters/codex"
	"agentfirehose/internal/adapters/opencode"
	"agentfirehose/internal/capturemeta"
)

// Check is one doctor validation result.
type Check struct {
	Name            string `json:"name"`
	OK              bool   `json:"ok"`
	Detail          string `json:"detail"`
	Transport       string `json:"transport,omitempty"`
	Fidelity        string `json:"fidelity,omitempty"`
	SupportedEvents int    `json:"supported_events,omitempty"`
	FilteredEvents  int    `json:"filtered_events,omitempty"`
}

// Doctor validates that capture paths are wired correctly.
func Doctor(cfg Config, home string) []Check {
	var checks []Check

	// spool writable
	err := os.MkdirAll(cfg.SpoolDir, 0o755)
	if err == nil {
		probe := filepath.Join(cfg.SpoolDir, ".doctor-probe")
		err = os.WriteFile(probe, []byte("ok"), 0o644)
		os.Remove(probe)
	}
	checks = append(checks, Check{
		Name: "spool writable", OK: err == nil,
		Detail: detailOr(err, cfg.SpoolDir),
	})

	// privacy mode valid
	_, perr := parseMode(cfg.PrivacyMode)
	checks = append(checks, Check{
		Name: "privacy mode", OK: perr == nil,
		Detail: detailOr(perr, cfg.PrivacyMode),
	})

	// claude-code hooks present
	hookOK := ClaudeHooksConfigured(home)
	checks = append(checks, Check{
		Name: "claude-code hooks", OK: hookOK,
		Detail:          pick(hookOK, "wired in ~/.claude/settings.json", "run: firehose install claude-code"),
		Transport:       "hook",
		Fidelity:        string(capturemeta.SupportedInBandHook),
		SupportedEvents: len(claudecode.Manifest.Mapped),
		FilteredEvents:  len(claudecode.Manifest.Filtered),
	})

	otelAddr := cfg.DaemonAddr
	if otelAddr == "" {
		otelAddr = DefaultDaemonAddr
	}
	otelOK := ClaudeOTelConfigured(home, otelAddr)
	checks = append(checks, Check{
		Name:            "claude-code otel",
		OK:              otelOK,
		Detail:          pick(otelOK, "supplemental local OTLP/HTTP JSON enabled", "optional: firehose install claude-otel"),
		Transport:       claudeotel.Transport,
		Fidelity:        string(claudeotel.Manifest.Fidelity),
		SupportedEvents: len(claudeotel.Manifest.Mapped),
		FilteredEvents:  len(claudeotel.Manifest.Filtered),
	})

	codexHookOK := CodexHooksConfigured(home)
	checks = append(checks, Check{
		Name:            "codex hooks",
		OK:              codexHookOK,
		Detail:          pick(codexHookOK, "configured in ~/.codex/hooks.json; review trust in Codex /hooks", "run: firehose install codex"),
		Transport:       "hook",
		Fidelity:        string(capturemeta.SupportedInBandHook),
		SupportedEvents: len(CodexHookEvents),
	})

	// opencode plugin present
	pluginPath := filepath.Join(home, ".config", "opencode", "plugin", opencode.PluginFileName)
	_, operr := os.Stat(pluginPath)
	checks = append(checks, Check{
		Name: "opencode plugin", OK: operr == nil,
		Detail:          pick(operr == nil, pluginPath, "run: firehose install opencode"),
		Transport:       "plugin",
		Fidelity:        string(capturemeta.SupportedPassiveStream),
		SupportedEvents: len(opencode.Manifest.Mapped),
		FilteredEvents:  len(opencode.Manifest.Filtered),
	})

	// Rollout tailing is independent of hooks and remains the assistant-message
	// transport.
	_, cerr := os.Stat(cfg.CodexDir)
	checks = append(checks, Check{
		Name:            "codex sessions",
		OK:              cerr == nil,
		Detail:          pick(cerr == nil, cfg.CodexDir, "no Codex session directory found (start Codex once)"),
		Transport:       "durable-jsonl",
		Fidelity:        string(capturemeta.PassiveInternalFile),
		SupportedEvents: len(codex.DurableManifest.Mapped),
		FilteredEvents:  len(codex.DurableManifest.Filtered),
	})

	return checks
}

func parseMode(s string) (string, error) {
	switch s {
	case "minimal", "balanced", "full":
		return s, nil
	}
	return "", fmt.Errorf("invalid privacy mode %q", s)
}

func detailOr(err error, ok string) string {
	if err != nil {
		return err.Error()
	}
	return ok
}

func pick(ok bool, yes, no string) string {
	if ok {
		return yes
	}
	return no
}
