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
	return out
}

func truncateValue(v any) any {
	s, ok := v.(string)
	if !ok {
		return v
	}
	r := []rune(s)
	if len(r) <= balancedMaxRunes {
		return s
	}
	return string(r[:balancedMaxRunes]) + "…"
}

func digestValue(v any) any {
	s := fmt.Sprintf("%v", v)
	sum := sha256.Sum256([]byte(s))
	return map[string]any{
		"sha256": hex.EncodeToString(sum[:]),
		"len":    len(s),
	}
}
