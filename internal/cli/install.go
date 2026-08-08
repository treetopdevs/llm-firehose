package cli

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"agentfirehose/internal/adapters/opencode"
)

// ClaudeOTelEnvironment is the exact opt-in environment block Firehose adds
// to Claude Code settings. It intentionally omits every content-bearing
// telemetry option.
func ClaudeOTelEnvironment(daemonAddr string) map[string]string {
	base := "http://" + daemonAddr
	return map[string]string{
		"CLAUDE_CODE_ENABLE_TELEMETRY":        "1",
		"OTEL_LOGS_EXPORTER":                  "otlp",
		"OTEL_METRICS_EXPORTER":               "otlp",
		"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL":    "http/json",
		"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "http/json",
		"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT":    base + "/v1/logs",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": base + "/v1/metrics",
	}
}

// InstallClaudeOTel opts Claude Code into the daemon's supplemental local
// OTLP/HTTP JSON receiver. Existing user, process, or managed telemetry
// settings are a hard conflict and are never overwritten. The caller supplies
// its process environment as environ (normally os.Environ()) so tests can
// inject a hermetic one; any telemetry key present there refuses the install.
func InstallClaudeOTel(home, daemonAddr string, environ []string) error {
	if err := validateClaudeOTelAddr(daemonAddr); err != nil {
		return err
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	settings := map[string]any{}
	original := []byte("{}")
	if data, err := os.ReadFile(settingsPath); err == nil {
		original = data
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("existing %s is not valid JSON, refusing to modify: %w", settingsPath, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	for _, managedPath := range []string{
		filepath.Join(home, ".claude", "managed-settings.json"),
		"/Library/Application Support/ClaudeCode/managed-settings.json",
	} {
		if data, err := os.ReadFile(managedPath); err == nil {
			var managed any
			if err := json.Unmarshal(data, &managed); err != nil {
				return fmt.Errorf("managed Claude settings at %s are invalid; refusing to modify user telemetry: %w", managedPath, err)
			}
			if containsTelemetrySetting(managed) {
				return fmt.Errorf("managed Claude telemetry settings exist at %s; refusing to override", managedPath)
			}
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect managed Claude settings: %w", err)
		}
	}
	for _, entry := range environ {
		key, _, _ := strings.Cut(entry, "=")
		if isClaudeTelemetryKey(key) {
			return fmt.Errorf("process environment already configures %s; refusing to override", key)
		}
	}

	var env map[string]any
	if existing, ok := settings["env"]; ok {
		var valid bool
		env, valid = existing.(map[string]any)
		if !valid {
			return fmt.Errorf("existing %s env value is not an object, refusing to modify", settingsPath)
		}
	} else {
		env = map[string]any{}
	}
	target := ClaudeOTelEnvironment(daemonAddr)
	telemetryEntries := 0
	exact := true
	for key, value := range env {
		if !isClaudeTelemetryKey(key) {
			continue
		}
		telemetryEntries++
		want, targeted := target[key]
		if !targeted || value != want {
			exact = false
		}
	}
	if telemetryEntries > 0 {
		if exact && telemetryEntries == len(target) {
			for key, value := range target {
				if env[key] != value {
					exact = false
					break
				}
			}
		}
		if exact && telemetryEntries == len(target) {
			return nil
		}
		return fmt.Errorf("existing Claude telemetry settings conflict; refusing to overwrite")
	}
	for key, value := range target {
		env[key] = value
	}
	settings["env"] = env

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
	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath, append(out, '\n'), 0o600)
}

// ClaudeOTelConfigured reports whether the exact local, content-disabled
// environment block is present.
func ClaudeOTelConfigured(home, daemonAddr string) bool {
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return false
	}
	var settings map[string]any
	if json.Unmarshal(data, &settings) != nil {
		return false
	}
	env, _ := settings["env"].(map[string]any)
	target := ClaudeOTelEnvironment(daemonAddr)
	seen := 0
	for key, value := range env {
		if !isClaudeTelemetryKey(key) {
			continue
		}
		seen++
		if target[key] != value {
			return false
		}
	}
	return seen == len(target)
}

func validateClaudeOTelAddr(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("Claude OTel daemon address %q: %w", addr, err)
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("Claude OTel daemon address %q must use loopback", addr)
	}
	return nil
}

func isClaudeTelemetryKey(key string) bool {
	return key == "CLAUDE_CODE_ENABLE_TELEMETRY" || strings.HasPrefix(key, "OTEL_")
}

func containsTelemetrySetting(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			if isClaudeTelemetryKey(key) || containsTelemetrySetting(nested) {
				return true
			}
		}
	case []any:
		for _, nested := range typed {
			if containsTelemetrySetting(nested) {
				return true
			}
		}
	}
	return false
}

// ClaudeHookEvents is the observational Claude Code hook surface Firehose
// installs. Every event except PreCompact is fixture-proven; PreCompact keeps
// its inherited install coverage while a real capture is pending (see
// adapters/claudecode/testdata/README.md). Additional documented hook names
// stay parser-only until a real local payload can prove their shape.
var ClaudeHookEvents = []string{
	"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
	"PostToolUseFailure", "StopFailure", "PreCompact",
	"Notification", "SubagentStop", "Stop", "SessionEnd",
}

var claudeHooksWithoutMatchers = map[string]bool{
	"UserPromptSubmit": true,
	"SessionStart":     true,
	"SessionEnd":       true,
	"Notification":     true,
	"SubagentStop":     true,
	"Stop":             true,
	"StopFailure":      true,
	"PreCompact":       true,
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
	var hooks map[string]any
	if existing, ok := settings["hooks"]; ok {
		var valid bool
		hooks, valid = existing.(map[string]any)
		if !valid {
			return fmt.Errorf("existing %s hooks value is not an object, refusing to modify", settingsPath)
		}
	} else {
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
		if len(handlers) != 1 {
			continue
		}
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
