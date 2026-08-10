// Package privacy applies capture-mode redaction to events before they are
// persisted or displayed.
package privacy

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"agentfirehose/internal/event"
)

// Mode controls how much captured content is retained.
type Mode string

const (
	// ModeMinimal keeps metadata only: payload values become {sha256, len} digests.
	ModeMinimal Mode = "minimal"
	// ModeBalanced keeps bounded excerpts: string payload values truncated, raw dropped.
	ModeBalanced Mode = "balanced"
	// ModeFull keeps everything including raw source payloads.
	ModeFull Mode = "full"
)

const balancedMaxRunes = 240

// ParseMode converts a config string into a Mode.
func ParseMode(s string) (Mode, error) {
	switch Mode(s) {
	case ModeMinimal, ModeBalanced, ModeFull:
		return Mode(s), nil
	}
	return "", fmt.Errorf("privacy: unknown mode %q (want minimal, balanced, or full)", s)
}

// Redact returns a copy of ev with content reduced according to mode.
// The input event is never mutated.
func Redact(ev event.Event, mode Mode) event.Event {
	if mode == ModeFull {
		return ev
	}
	out := ev
	out.Raw = ""
	out.Payload = make(map[string]any, len(ev.Payload))
	for k, v := range ev.Payload {
		switch mode {
		case ModeBalanced:
			out.Payload[k] = truncateValue(v)
		case ModeMinimal:
			out.Payload[k] = digestValue(v)
		}
	}
	// Path-valued identity must not persist absolute filesystem locations
	// outside full mode; digests keep correlation without leaking CWD paths.
	out.CWD = digestPath(out.CWD)
	out.RepoID = digestPath(out.RepoID)
	out.WorktreeID = digestPath(out.WorktreeID)
	return out
}

func digestPath(s string) string {
	if s == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func truncateValue(v any) any {
	switch value := v.(type) {
	case string:
		r := []rune(value)
		if len(r) <= balancedMaxRunes {
			return value
		}
		return string(r[:balancedMaxRunes]) + "…"
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, nested := range value {
			out[key] = truncateValue(nested)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, nested := range value {
			out[i] = truncateValue(nested)
		}
		return out
	case map[string]string:
		out := make(map[string]string, len(value))
		for key, nested := range value {
			out[key] = truncateValue(nested).(string)
		}
		return out
	case []string:
		out := make([]string, len(value))
		for i, nested := range value {
			out[i] = truncateValue(nested).(string)
		}
		return out
	default:
		return v
	}
}

func digestValue(v any) any {
	s := fmt.Sprintf("%v", v)
	sum := sha256.Sum256([]byte(s))
	return map[string]any{
		"sha256": hex.EncodeToString(sum[:]),
		"len":    len(s),
	}
}
