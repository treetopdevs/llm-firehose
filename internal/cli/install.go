package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
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

// CodexHookEvents is the complete lifecycle/tool hook surface supported by
// current Codex. The rollout watcher remains the message streaming source.
var CodexHookEvents = []string{
	"SessionStart", "SessionEnd", "UserPromptSubmit",
	"PreToolUse", "PermissionRequest", "PostToolUse",
	"PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop",
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
	for _, entry := range entries {
		entryMap, _ := entry.(map[string]any)
		hooks, _ := entryMap["hooks"].([]any)
		for _, hook := range hooks {
			hookMap, _ := hook.(map[string]any)
			if hookMap["command"] == command {
				return true
			}
		}
	}
	return false
}

// InstallCodex merges observational forwarding hooks into user-wide
// ~/.codex/hooks.json. Existing hooks and top-level fields are preserved, the
// prior file is backed up, and repeated installation is a no-op.
func InstallCodex(home, binPath string) error {
	hooksPath := filepath.Join(home, ".codex", "hooks.json")
	doc := map[string]any{}
	original := []byte("{}")
	existed := false
	if data, err := os.ReadFile(hooksPath); err == nil {
		existed = true
		original = data
		if err := json.Unmarshal(data, &doc); err != nil {
			return fmt.Errorf("existing %s is not valid JSON, refusing to modify: %w", hooksPath, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	command := shellQuote(binPath) + " hook-forward"
	hooks, _ := doc["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	changed := false
	for _, name := range CodexHookEvents {
		entries, _ := hooks[name].([]any)
		if hasCommand(entries, command) {
			continue
		}
		entry := map[string]any{
			"hooks": []any{map[string]any{"type": "command", "command": command}},
		}
		switch name {
		case "PreToolUse", "PermissionRequest", "PostToolUse", "SubagentStart", "SubagentStop":
			entry["matcher"] = "*"
		}
		hooks[name] = append(entries, entry)
		changed = true
	}
	if !changed && existed {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(hooksPath), 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(hooksPath + ".bak"); os.IsNotExist(err) {
		if err := os.WriteFile(hooksPath+".bak", original, 0o600); err != nil {
			return fmt.Errorf("backup: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("backup: %w", err)
	}
	doc["hooks"] = hooks
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(hooksPath, append(out, '\n'), 0o600)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

// CodexHooksConfigured verifies every supported event has a forwarding hook
// and that its referenced executable is currently available.
func CodexHooksConfigured(home string) bool {
	data, err := os.ReadFile(filepath.Join(home, ".codex", "hooks.json"))
	if err != nil {
		return false
	}
	var doc map[string]any
	if json.Unmarshal(data, &doc) != nil {
		return false
	}
	hooks, _ := doc["hooks"].(map[string]any)
	for _, name := range CodexHookEvents {
		entries, _ := hooks[name].([]any)
		found := false
		for _, entry := range entries {
			entryMap, _ := entry.(map[string]any)
			handlers, _ := entryMap["hooks"].([]any)
			for _, handler := range handlers {
				handlerMap, _ := handler.(map[string]any)
				command, _ := handlerMap["command"].(string)
				if strings.HasSuffix(command, " hook-forward") && commandAvailable(command) {
					found = true
					break
				}
			}
			if found {
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func commandAvailable(command string) bool {
	bin := strings.TrimSuffix(command, " hook-forward")
	if strings.HasPrefix(bin, "'") && strings.HasSuffix(bin, "'") {
		bin = strings.TrimSuffix(strings.TrimPrefix(bin, "'"), "'")
		bin = strings.ReplaceAll(bin, "'\"'\"'", "'")
	}
	if filepath.IsAbs(bin) {
		info, err := os.Stat(bin)
		return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
	}
	_, err := exec.LookPath(bin)
	return err == nil
}

// InstallOpenCode writes the forwarder plugin into
// <home>/.config/opencode/plugin/ and returns its path.
func InstallOpenCode(home string) (string, error) {
	return opencode.WritePlugin(filepath.Join(home, ".config", "opencode", "plugin"))
}
