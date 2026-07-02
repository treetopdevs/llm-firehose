package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"agentfirehose/internal/adapters/opencode"
)

// hookedEvents are the Claude Code hook events the firehose subscribes to.
var hookedEvents = []string{
	"SessionStart", "SessionEnd", "UserPromptSubmit",
	"PreToolUse", "PostToolUse", "Notification",
	"Stop", "SubagentStop", "PreCompact",
}

// InstallClaudeCode merges firehose forwarding hooks into
// <home>/.claude/settings.json, backing the file up first and preserving all
// existing content. Running it twice is a no-op.
func InstallClaudeCode(home, binPath string) error {
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	settings := map[string]any{}
	if data, err := os.ReadFile(settingsPath); err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("existing %s is not valid JSON, refusing to modify: %w", settingsPath, err)
		}
		if err := os.WriteFile(settingsPath+".bak", data, 0o644); err != nil {
			return fmt.Errorf("backup: %w", err)
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
			return err
		}
		// still create a backup marker so the doctor/test flow is uniform
		if err := os.WriteFile(settingsPath+".bak", []byte("{}"), 0o644); err != nil {
			return fmt.Errorf("backup: %w", err)
		}
	}

	command := binPath + " emit --source claude-code"
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	for _, evName := range hookedEvents {
		entries, _ := hooks[evName].([]any)
		if hasCommand(entries, command) {
			continue
		}
		entry := map[string]any{
			"hooks": []any{map[string]any{"type": "command", "command": command}},
		}
		if evName == "PreToolUse" || evName == "PostToolUse" {
			entry["matcher"] = "*"
		}
		hooks[evName] = append(entries, entry)
	}
	settings["hooks"] = hooks

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath, append(out, '\n'), 0o644)
}

func hasCommand(entries []any, command string) bool {
	data, err := json.Marshal(entries)
	if err != nil {
		return false
	}
	return strings.Contains(string(data), command)
}

// InstallOpenCode writes the forwarder plugin into
// <home>/.config/opencode/plugin/ and returns its path.
func InstallOpenCode(home string) (string, error) {
	return opencode.WritePlugin(filepath.Join(home, ".config", "opencode", "plugin"))
}
