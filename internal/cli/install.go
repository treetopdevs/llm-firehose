package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"agentfirehose/internal/adapters/opencode"
)

// ClaudeHookEvents is the observational Claude Code hook surface Firehose
// installs. WorktreeCreate is excluded because registering it replaces
// Claude's worktree implementation and a neutral observer cannot return the
// required path. FileChanged is excluded until the user supplies a bounded
// watch list.
var ClaudeHookEvents = []string{
	"SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion",
	"PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse",
	"PostToolUseFailure", "PostToolBatch", "Notification", "SubagentStart",
	"SubagentStop", "TaskCreated", "TaskCompleted", "Stop", "StopFailure",
	"TeammateIdle", "InstructionsLoaded", "ConfigChange", "CwdChanged",
	"WorktreeRemove", "PreCompact", "PostCompact", "Elicitation",
	"ElicitationResult", "SessionEnd", "MessageDisplay",
}

var claudeHooksWithoutMatchers = map[string]bool{
	"UserPromptSubmit": true,
	"PostToolBatch":    true,
	"Stop":             true,
	"TeammateIdle":     true,
	"TaskCreated":      true,
	"TaskCompleted":    true,
	"WorktreeRemove":   true,
	"CwdChanged":       true,
	"MessageDisplay":   true,
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
	original := []byte("{}")
	existed := false
	if data, err := os.ReadFile(settingsPath); err == nil {
		existed = true
		original = data
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("existing %s is not valid JSON, refusing to modify: %w", settingsPath, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	command := quoteCommandPath(binPath, runtime.GOOS) + " hook-forward --source claude-code"
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	changed := false
	for _, evName := range ClaudeHookEvents {
		entries, _ := hooks[evName].([]any)
		matcher := ".*"
		if claudeHooksWithoutMatchers[evName] {
			matcher = ""
		}
		var entryChanged bool
		entries, entryChanged = ensureClaudeHook(entries, command, matcher)
		if entryChanged {
			hooks[evName] = entries
			changed = true
		}
	}
	if !changed && existed {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(settingsPath + ".bak"); os.IsNotExist(err) {
		if err := os.WriteFile(settingsPath+".bak", original, 0o600); err != nil {
			return fmt.Errorf("backup: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("backup: %w", err)
	}
	settings["hooks"] = hooks

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath, append(out, '\n'), 0o600)
}

func ensureClaudeHook(entries []any, command, matcher string) ([]any, bool) {
	for _, rawEntry := range entries {
		entry, _ := rawEntry.(map[string]any)
		handlers, _ := entry["hooks"].([]any)
		for _, rawHandler := range handlers {
			handler, _ := rawHandler.(map[string]any)
			if handler["command"] != command {
				continue
			}
			changed := false
			if handler["type"] != "command" {
				handler["type"] = "command"
				changed = true
			}
			if handler["async"] != true {
				handler["async"] = true
				changed = true
			}
			if matcher == "" {
				if _, ok := entry["matcher"]; ok {
					delete(entry, "matcher")
					changed = true
				}
			} else if entry["matcher"] != matcher {
				entry["matcher"] = matcher
				changed = true
			}
			return entries, changed
		}
	}

	handler := map[string]any{
		"type":    "command",
		"command": command,
		"async":   true,
	}
	entry := map[string]any{"hooks": []any{handler}}
	if matcher != "" {
		entry["matcher"] = matcher
	}
	return append(entries, entry), true
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

// ClaudeHooksConfigured verifies complete, current Firehose-owned Claude hook
// coverage and a live forwarding executable.
func ClaudeHooksConfigured(home string) bool {
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return false
	}
	var settings map[string]any
	if json.Unmarshal(data, &settings) != nil {
		return false
	}
	hooks, _ := settings["hooks"].(map[string]any)
	for _, name := range ClaudeHookEvents {
		entries, _ := hooks[name].([]any)
		found := false
		for _, rawEntry := range entries {
			entry, _ := rawEntry.(map[string]any)
			if claudeHooksWithoutMatchers[name] {
				if _, ok := entry["matcher"]; ok {
					continue
				}
			} else if entry["matcher"] != ".*" {
				continue
			}
			handlers, _ := entry["hooks"].([]any)
			for _, rawHandler := range handlers {
				handler, _ := rawHandler.(map[string]any)
				command, _ := handler["command"].(string)
				if strings.HasSuffix(command, " hook-forward --source claude-code") &&
					handler["type"] == "command" &&
					handler["async"] == true &&
					commandAvailable(strings.TrimSuffix(command, " --source claude-code")) {
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
	command := quoteCommandPath(binPath, runtime.GOOS) + " hook-forward"
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

func quoteCommandPath(value, goos string) string {
	if goos == "windows" {
		// Double quotes are the executable-path delimiter understood by
		// cmd.exe. A Windows filename itself cannot contain a double quote.
		return `"` + value + `"`
	}
	return shellQuote(value)
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
	} else if strings.HasPrefix(bin, `"`) && strings.HasSuffix(bin, `"`) {
		bin = strings.TrimSuffix(strings.TrimPrefix(bin, `"`), `"`)
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
func InstallOpenCode(home, binPath string) (string, error) {
	return opencode.WritePlugin(filepath.Join(home, ".config", "opencode", "plugin"), binPath)
}
