// Package capturemeta describes adapter coverage and creates safe warnings
// when a supported transport observes an upstream shape it does not know.
package capturemeta

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"agentfirehose/internal/event"
)

// Fidelity describes how directly and durably an adapter observes a source.
type Fidelity string

const (
	SupportedPassiveStream Fidelity = "supported-passive-stream"
	SupportedInBandHook    Fidelity = "supported-in-band-hook"
	PassiveVersionedFile   Fidelity = "passive-versioned-file"
	PassiveInternalFile    Fidelity = "passive-internal-file"
	OwnedRunProtocol       Fidelity = "owned-run-protocol"
	ProcessOnly            Fidelity = "process-only"
)

var validFidelities = map[Fidelity]bool{
	SupportedPassiveStream: true,
	SupportedInBandHook:    true,
	PassiveVersionedFile:   true,
	PassiveInternalFile:    true,
	OwnedRunProtocol:       true,
	ProcessOnly:            true,
}

var validTransports = map[string]bool{
	"hook":          true,
	"plugin":        true,
	"otel-http":     true,
	"otel-jsonl":    true,
	"durable-jsonl": true,
	"process":       true,
}

// Manifest declares one adapter transport's supported and intentionally
// filtered native events.
type Manifest struct {
	Source       string
	Transport    string
	Fidelity     Fidelity
	Mapped       []string
	Filtered     []string
	SourceSchema string
}

// Validate rejects incomplete manifests and ambiguous event coverage.
func (m Manifest) Validate() error {
	if strings.TrimSpace(m.Source) == "" {
		return fmt.Errorf("capture manifest: source is required")
	}
	if !validTransports[m.Transport] {
		return fmt.Errorf("capture manifest: invalid transport %q", m.Transport)
	}
	if !validFidelities[m.Fidelity] {
		return fmt.Errorf("capture manifest: invalid fidelity %q", m.Fidelity)
	}
	if strings.TrimSpace(m.SourceSchema) == "" {
		return fmt.Errorf("capture manifest: source schema is required")
	}
	seen := make(map[string]string, len(m.Mapped)+len(m.Filtered))
	for _, group := range []struct {
		name   string
		events []string
	}{
		{name: "mapped", events: m.Mapped},
		{name: "filtered", events: m.Filtered},
	} {
		for _, name := range group.events {
			if strings.TrimSpace(name) == "" {
				return fmt.Errorf("capture manifest: %s event name is empty", group.name)
			}
			if prior, ok := seen[name]; ok {
				return fmt.Errorf("capture manifest: event %q is duplicated in %s and %s", name, prior, group.name)
			}
			seen[name] = group.name
		}
	}
	return nil
}

// UnknownEvent returns a deterministic, content-free warning. Its ID rotates
// by UTC day so derived views suppress repeated observations without hiding
// persistent drift forever.
func UnknownEvent(source, transport, nativeName, sourceVersion, reason string, now time.Time) event.Event {
	day := now.UTC().Format("2006-01-02")
	sum := sha256.Sum256([]byte(strings.Join([]string{source, transport, sourceVersion, nativeName, day}, "\x00")))
	bounded := safeReason(reason)
	safeSource := truncateRunes(source, 80)
	safeTransport := truncateRunes(transport, 32)
	safeName := truncateRunes(nativeName, 160)
	safeVersion := truncateRunes(sourceVersion, 80)
	captured := now.UTC()
	return event.Event{
		ID:            "unknown-" + hex.EncodeToString(sum[:16]),
		Time:          captured,
		CaptureTime:   &captured,
		Source:        safeSource,
		Transport:     safeTransport,
		SourceVersion: safeVersion,
		Category:      event.CategoryMeta,
		Name:          "adapter.unknown_event",
		Severity:      event.SeverityWarn,
		Summary:       truncateRunes("Unknown "+safeSource+" event: "+safeName, 240),
		Payload: map[string]any{
			"source":            safeSource,
			"transport":         safeTransport,
			"native_event_name": safeName,
			"source_version":    safeVersion,
			"reason":            bounded,
		},
	}
}

func safeReason(reason string) string {
	switch strings.TrimSpace(reason) {
	case "native hook event is not present in the Claude Code manifest":
		return "native hook event is not present in the Claude Code manifest"
	case "native bus event is not present in the OpenCode manifest":
		return "native bus event is not present in the OpenCode manifest"
	case "native hook event is not present in the Antigravity manifest":
		return "native hook event is not present in the Antigravity manifest"
	default:
		return "native event is not present in the adapter manifest"
	}
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit]) + "…"
}
