package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// OTelForwardTargets is the host-private record of where the daemon tees the
// OTLP/HTTP JSON it receives from Claude Code, plus the user's original
// telemetry settings so uninstall can put them back. It lives beside
// graph-roots.json rather than in config.json: it is not part of the API
// config surface, may hold the user's own settings values, and the daemon
// re-reads it live so an install takes effect without a restart.
type OTelForwardTargets struct {
	Logs        string            `json:"logs,omitempty"`
	Metrics     string            `json:"metrics,omitempty"`
	OriginalEnv map[string]string `json:"original_env,omitempty"`
}

// OTelForwardPath is where the forwarding record is kept.
func OTelForwardPath(home string) string {
	return filepath.Join(home, ".agentfirehose", "otel-forward.json")
}

// LoadOTelForward reads the forwarding record; a missing file is no forwarding.
func LoadOTelForward(home string) (OTelForwardTargets, error) {
	var targets OTelForwardTargets
	data, err := os.ReadFile(OTelForwardPath(home))
	if err != nil {
		if os.IsNotExist(err) {
			return targets, nil
		}
		return targets, err
	}
	if err := json.Unmarshal(data, &targets); err != nil {
		return OTelForwardTargets{}, fmt.Errorf("%s: %w", OTelForwardPath(home), err)
	}
	return targets, nil
}

func saveOTelForward(home string, targets OTelForwardTargets) error {
	path := OTelForwardPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(targets, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".otel-forward-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// forwardPreservedKeys are the telemetry keys whose meaning forwarding keeps:
// where logs and metrics go, how they are encoded, and whether they are on.
var forwardPreservedKeys = map[string]bool{
	"CLAUDE_CODE_ENABLE_TELEMETRY":        true,
	"OTEL_LOGS_EXPORTER":                  true,
	"OTEL_METRICS_EXPORTER":               true,
	"OTEL_EXPORTER_OTLP_ENDPOINT":         true,
	"OTEL_EXPORTER_OTLP_PROTOCOL":         true,
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT":    true,
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL":    true,
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": true,
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": true,
}

// planOTelForward turns the user's existing telemetry settings into forward
// targets, or reports (as a conflict) why they cannot be preserved. Only
// loopback http/json OTLP destinations are forwarded: Firehose receives
// http/json, so that is all it can pass on faithfully, and it never relays to
// a non-local host. Headers, certificates and other options are not copied
// into Firehose, so settings that depend on them are refused, not dropped.
func planOTelForward(env map[string]any, foreign []string, ownAddr string) (OTelForwardTargets, error) {
	plan := OTelForwardTargets{OriginalEnv: map[string]string{}}
	for _, key := range foreign {
		value, ok := env[key].(string)
		if !ok || !forwardPreservedKeys[key] {
			return plan, fmt.Errorf("%s cannot be preserved when forwarding (only loopback http/json OTLP endpoints can); use replace instead: %w", key, ErrClaudeOTelConflict)
		}
		switch key {
		case "CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_LOGS_EXPORTER", "OTEL_METRICS_EXPORTER":
			// Foreign here means a different switch or exporter (disabled,
			// console, …), which a relay to an OTLP collector cannot honour.
			return plan, fmt.Errorf("%s=%q cannot be preserved when forwarding (only otlp exports can); use replace instead: %w", key, value, ErrClaudeOTelConflict)
		}
	}
	// Everything the user had configured is saved, including values that
	// already match Firehose's, so uninstall restores the exact original.
	for key, value := range env {
		if v, ok := value.(string); ok && isClaudeTelemetryKey(key) {
			plan.OriginalEnv[key] = v
		}
	}
	lookup := func(key string) string { v, _ := env[key].(string); return v }
	for _, signal := range []string{"logs", "metrics"} {
		upper := strings.ToUpper(signal)
		if lookup("OTEL_"+upper+"_EXPORTER") != "otlp" {
			continue
		}
		endpoint := lookup("OTEL_EXPORTER_OTLP_" + upper + "_ENDPOINT")
		if endpoint == "" {
			base := strings.TrimRight(lookup("OTEL_EXPORTER_OTLP_ENDPOINT"), "/")
			if base == "" {
				continue
			}
			endpoint = base + "/v1/" + signal
		}
		protocol := lookup("OTEL_EXPORTER_OTLP_" + upper + "_PROTOCOL")
		if protocol == "" {
			protocol = lookup("OTEL_EXPORTER_OTLP_PROTOCOL")
		}
		if protocol != "http/json" {
			return plan, fmt.Errorf("existing %s export uses protocol %q; only http/json can be forwarded, use replace instead: %w", signal, protocol, ErrClaudeOTelConflict)
		}
		if err := validateForwardTarget(endpoint, ownAddr); err != nil {
			return plan, fmt.Errorf("existing %s endpoint: %w", signal, err)
		}
		if signal == "logs" {
			plan.Logs = endpoint
		} else {
			plan.Metrics = endpoint
		}
	}
	if plan.Logs == "" && plan.Metrics == "" {
		return plan, fmt.Errorf("no existing OTLP logs or metrics export to forward to; use replace instead: %w", ErrClaudeOTelConflict)
	}
	return plan, nil
}

// ValidateOTelForwardTarget reports whether endpoint is an acceptable relay
// destination: a plain http URL on a loopback host that is not the daemon.
func ValidateOTelForwardTarget(endpoint, ownAddr string) error {
	return validateForwardTarget(endpoint, ownAddr)
}

func validateForwardTarget(endpoint, ownAddr string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.Scheme != "http" || u.User != nil {
		return fmt.Errorf("%q is not a plain http URL without credentials: %w", redactURL(endpoint), ErrClaudeOTelConflict)
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("%q is not a loopback address; Firehose only forwards locally: %w", redactURL(endpoint), ErrClaudeOTelConflict)
	}
	port := u.Port()
	if port == "" {
		port = "80"
	}
	if _, ownPort, err := net.SplitHostPort(ownAddr); err == nil && ownPort == port {
		return fmt.Errorf("%q is Firehose's own address; forwarding would loop: %w", redactURL(endpoint), ErrClaudeOTelConflict)
	}
	return nil
}

func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "<unparseable>"
	}
	return u.Scheme + "://" + u.Host + u.Path
}

// UninstallClaudeOTel removes Firehose's telemetry block from Claude settings.
// When the install forwarded to an existing collector, that collector's
// original settings are restored (without overwriting keys the user has set
// since) and the forwarding record is deleted. Keys whose values are not
// Firehose's own are left alone. Repeat runs are no-ops.
func UninstallClaudeOTel(home, daemonAddr string) error {
	if err := validateClaudeOTelAddr(daemonAddr); err != nil {
		return err
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	forward, err := LoadOTelForward(home)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(settingsPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err == nil {
		settings := map[string]any{}
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("existing %s is not valid JSON, refusing to modify: %w", settingsPath, err)
		}
		env, _ := settings["env"].(map[string]any)
		if settings["env"] != nil && env == nil {
			return fmt.Errorf("existing %s env value is not an object, refusing to modify", settingsPath)
		}
		changed := false
		for key, want := range ClaudeOTelEnvironment(daemonAddr) {
			if env[key] == want {
				delete(env, key)
				changed = true
			}
		}
		for key, value := range forward.OriginalEnv {
			if _, present := env[key]; !present {
				if env == nil {
					env = map[string]any{}
				}
				env[key] = value
				changed = true
			}
		}
		if changed {
			if len(env) == 0 {
				delete(settings, "env")
			} else {
				settings["env"] = env
			}
			backup, err := uniqueBackupPath(settingsPath)
			if err != nil {
				return fmt.Errorf("backup: %w", err)
			}
			if err := os.WriteFile(backup, data, 0o600); err != nil {
				return fmt.Errorf("backup: %w", err)
			}
			out, err := json.MarshalIndent(settings, "", "  ")
			if err != nil {
				return err
			}
			if err := os.WriteFile(settingsPath, append(out, '\n'), 0o600); err != nil {
				return err
			}
		}
	}
	if err := os.Remove(OTelForwardPath(home)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
