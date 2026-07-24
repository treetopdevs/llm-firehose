package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"agentfirehose/internal/adapters/opencode"
)

// Check is one doctor validation result.
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
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
	hookOK := false
	if data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json")); err == nil {
		var settings map[string]any
		if json.Unmarshal(data, &settings) == nil {
			if hooks, err := json.Marshal(settings["hooks"]); err == nil {
				hookOK = strings.Contains(string(hooks), "emit --source claude-code")
			}
		}
	}
	checks = append(checks, Check{
		Name: "claude-code hooks", OK: hookOK,
		Detail: pick(hookOK, "wired in ~/.claude/settings.json", "run: firehose install claude-code"),
	})

	codexHookOK := CodexHooksConfigured(home)
	checks = append(checks, Check{
		Name:   "codex hooks",
		OK:     codexHookOK,
		Detail: pick(codexHookOK, "configured in ~/.codex/hooks.json; review trust in Codex /hooks", "run: firehose install codex"),
	})

	// opencode plugin present
	pluginPath := filepath.Join(home, ".config", "opencode", "plugin", opencode.PluginFileName)
	_, operr := os.Stat(pluginPath)
	checks = append(checks, Check{
		Name: "opencode plugin", OK: operr == nil,
		Detail: pick(operr == nil, pluginPath, "run: firehose install opencode"),
	})

	// Rollout tailing is independent of hooks and remains the assistant-message
	// transport.
	_, cerr := os.Stat(cfg.CodexDir)
	checks = append(checks, Check{
		Name: "codex sessions", OK: cerr == nil,
		Detail: pick(cerr == nil, cfg.CodexDir, "no Codex session directory found (start Codex once)"),
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
